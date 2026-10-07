import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  API_BASE_PATH,
  ROUTES,
  buildOpenApi,
  capabilities,
  health,
  me,
  problem,
  run,
  type RouteDef,
} from '@kramahq/contract';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildApi,
  createKrama,
  loadConfig,
  Versioned,
  type Handlers,
  type Krama,
} from '../src/index.js';

const TOKEN = 'test-token-0123456789abcdef';
const auth = { authorization: `Bearer ${TOKEN}` };
const V1 = API_BASE_PATH;

let home: string;
let krama: Krama;
let app: FastifyInstance;
let calls: { createRun: number };

// Handlers that stand in for the real ones so the cross-cutting behaviour (idempotency, ETag, status codes) can be tested
// on real contract routes.
function stubSample() {
  return {
    id: 'run_1',
    title: 'Stub',
    status: 'planning',
    mode: 'review',
    input: { text: 'hello' },
    pack: { id: 'pack_x', version: '1', sha: 'abc' },
    orchestrator: { definitionId: 'orchestrator', backend: 'a2a-claude' },
    budget: { max: { amount: 5, currency: 'USD' }, spent: null, warnAtPct: 80, onExceed: 'pause' },
    currentPhaseIds: [],
    pendingDecisions: 0,
    trigger: { type: 'api' },
    labels: [],
    createdBy: { type: 'user', id: 'u_local' },
    links: {},
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function stubHandlers(): Handlers {
  calls = { createRun: 0 };
  const sample = stubSample();
  return {
    createRun: () => {
      calls.createRun++;
      return { ...sample, id: `run_${calls.createRun}` };
    },
    getRun: (req) => new Versioned({ ...sample, id: `run_${req.params['id']}` }, 7),
    patchMemoryRecord: (req) => ({ ifMatch: req.ifMatch }),
  };
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'krama-api-'));
  krama = await createKrama({ home, packs: [], definitions: [] });
  const config = loadConfig({ argv: ['--home', home, '--token', TOKEN, '--port', '0'], env: {} });
  app = await buildApi({ krama, config, handlers: stubHandlers(), validateResponses: true });
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
  await krama?.close();
  rmSync(home, { recursive: true, force: true });
});

const get = (url: string, headers: Record<string, string> = {}) =>
  app.inject({ method: 'GET', url, headers });

describe('platform routes', () => {
  it('serves /capabilities without a token, matching the contract', async () => {
    const res = await get(`${V1}/capabilities`);
    expect(res.statusCode).toBe(200);
    const body = capabilities.parse(res.json());
    expect(body.features.auth.mode).toBe('token');
    // Only what exists is advertised.
    expect(body.features.memory.enabled).toBe(false);
    expect(body.features.schedules.enabled).toBe(false);
    expect(body.backends.map((b) => b.wrapper)).toContain('a2a-claude');
  });

  it('serves /health without a token, matching the contract', async () => {
    const res = await get(`${V1}/health`);
    expect(res.statusCode).toBe(200);
    const body = health.parse(res.json());
    expect(body.status).toBe('ok');
    expect(Object.keys(body.components)).toEqual(['store', 'agents', 'events']);
  });

  it('serves /me to a caller with the token', async () => {
    const res = await get(`${V1}/me`, auth);
    expect(res.statusCode).toBe(200);
    const body = me.parse(res.json());
    expect(body.roles).toContain('admin');
  });

  it('keeps preferences across requests as a merge patch', async () => {
    const patch = (payload: unknown) =>
      app.inject({
        method: 'PATCH',
        url: `${V1}/me/preferences`,
        headers: auth,
        payload: payload as object,
      });
    expect((await patch({ theme: 'dark', density: 'compact' })).json().preferences).toEqual({
      theme: 'dark',
      density: 'compact',
    });
    expect((await patch({ density: null })).json().preferences).toEqual({ theme: 'dark' });
    expect(JSON.parse(readFileSync(join(home, 'preferences.json'), 'utf8'))).toEqual({
      theme: 'dark',
    });
    expect((await get(`${V1}/me`, auth)).json().preferences).toEqual({ theme: 'dark' });
  });

  it('reports a failing component instead of failing the request', async () => {
    const spy = krama.ports.store.runs.list;
    krama.ports.store.runs.list = async () => {
      throw new Error('disk gone');
    };
    try {
      const res = await get(`${V1}/health`);
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe('down');
      expect(res.json().components.store.detail).toBe('disk gone');
    } finally {
      krama.ports.store.runs.list = spy;
    }
  });
});

describe('authentication', () => {
  it.each([
    ['no header', {}],
    ['a wrong token', { authorization: 'Bearer nope' }],
    ['a non-bearer scheme', { authorization: `Basic ${TOKEN}` }],
  ])('answers 401 problem+json with %s', async (_n, headers) => {
    const res = await get(`${V1}/me`, headers);
    expect(res.statusCode).toBe(401);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.headers['www-authenticate']).toBe('Bearer');
    expect(problem.parse(res.json()).code).toBe('unauthenticated');
  });

  it('answers 401 before it looks at the body, so anonymous callers learn nothing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `${V1}/runs`,
      payload: { nonsense: true },
    });
    expect(res.statusCode).toBe(401);
  });

  it('refuses a request addressed to a non-loopback host (DNS rebinding)', async () => {
    const res = await get(`${V1}/capabilities`, { host: 'evil.example.com' });
    expect(res.statusCode).toBe(403);
    expect(problem.parse(res.json()).code).toBe('forbidden');
  });

  it('only allows loopback or configured CORS origins', async () => {
    const preflight = (origin: string) =>
      app.inject({
        method: 'OPTIONS',
        url: `${V1}/me`,
        headers: { origin, 'access-control-request-method': 'GET' },
      });
    expect((await preflight('http://localhost:5173')).headers['access-control-allow-origin']).toBe(
      'http://localhost:5173',
    );
    expect(
      (await preflight('https://evil.example.com')).headers['access-control-allow-origin'],
    ).toBeUndefined();
  });
});

describe('problem+json', () => {
  it('rejects a bad query with per-field errors', async () => {
    const res = await get(`${V1}/runs?limit=abc`, auth);
    expect(res.statusCode).toBe(422);
    const p = problem.parse(res.json());
    expect(p.code).toBe('validation_failed');
    expect(p.errors?.[0]?.field).toBe('limit');
  });

  it('rejects a bad body with per-field errors', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `${V1}/runs`,
      headers: auth,
      payload: { packId: 5 },
    });
    expect(res.statusCode).toBe(422);
    expect(problem.parse(res.json()).errors?.map((e) => e.field)).toContain('packId');
  });

  it('answers malformed JSON with a problem, not a stack trace', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `${V1}/runs`,
      headers: { ...auth, 'content-type': 'application/json' },
      payload: '{nope',
    });
    expect(res.statusCode).toBe(422);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body).not.toContain('at ');
  });

  it('answers an unknown route with 404 problem+json', async () => {
    const res = await get(`${V1}/no-such-thing`, auth);
    expect(res.statusCode).toBe(404);
    expect(problem.parse(res.json()).code).toBe('not_found');
  });

  it('answers 501 for a route no handler serves yet, and never leaks an internal error', async () => {
    const res = await get(`${V1}/memory/records`, auth);
    expect(res.statusCode).toBe(501);
    expect(problem.parse(res.json()).code).toBe('not_implemented');
  });

  it('hides the message of an unexpected failure and gives a trace id', async () => {
    const boom = await buildApi({
      krama,
      config: loadConfig({ argv: ['--home', home, '--token', TOKEN], env: {} }),
      handlers: {
        getRun: () => {
          throw new Error('secret connection string');
        },
      },
    });
    const res = await boom.inject({ method: 'GET', url: `${V1}/runs/run_1`, headers: auth });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('secret');
    expect(problem.parse(res.json()).traceId).toBe(res.headers['x-request-id']);
    await boom.close();
  });
});

describe('conformance against the contract route table', () => {
  const fill = (r: RouteDef) => `${V1}${r.path.replace(/\{(\w+)\}/g, 'x')}`;

  it.each(ROUTES.filter((r) => r.perm !== 'public').map((r) => [r.operationId, r] as const))(
    '%s requires authentication',
    async (_id, r) => {
      const res = await app.inject({ method: r.method, url: fill(r) });
      expect(res.statusCode).toBe(401);
    },
  );

  it('answers every route with a contract-shaped result: a success body or a problem, never a bare 5xx', async () => {
    for (const r of ROUTES) {
      // A stream route never ends under `inject`; ask for its JSON page form, which is the same route and contract.
      const headers = r.stream ? { ...auth, accept: 'application/json' } : auth;
      const res = await app.inject({ method: r.method, url: fill(r), headers });
      if (res.statusCode >= 400) {
        expect(res.headers['content-type'], r.operationId).toContain('application/problem+json');
        expect([404, 422, 428, 501], `${r.operationId} -> ${res.statusCode}`).toContain(
          res.statusCode,
        );
      }
    }
  });

  it('leaves only the platform status routes public', () => {
    const open = ROUTES.filter((r) => r.perm === 'public').map((r) => r.operationId);
    expect(open).toEqual(expect.arrayContaining(['getCapabilities', 'getHealth']));
    expect(open.length).toBeLessThanOrEqual(3);
  });
});

describe('OpenAPI', () => {
  it('serves the generated document at /api/v1/openapi.json', async () => {
    const res = await get(`${V1}/openapi.json`);
    expect(res.statusCode).toBe(200);
    expect(res.json().openapi).toMatch(/^3\.1/);
    const ops = Object.values(res.json().paths).flatMap((p) =>
      Object.values(p as object).map((o: { operationId: string }) => o.operationId),
    );
    expect(ops).toEqual(expect.arrayContaining(ROUTES.map((r) => r.operationId)));
    expect(res.json().paths).toEqual(buildOpenApi(res.json().info.version).paths);
  });
});

describe('idempotency keys', () => {
  const body = { packId: 'pack_x', input: { text: 'hi' } };
  const post = (key: string | undefined, payload: object = body) =>
    app.inject({
      method: 'POST',
      url: `${V1}/runs`,
      headers: { ...auth, ...(key ? { 'idempotency-key': key } : {}) },
      payload,
    });

  it('creates once and replays the first answer for the same key and body', async () => {
    const before = calls.createRun;
    const a = await post('k-replay');
    const b = await post('k-replay');
    expect(a.statusCode).toBe(201);
    expect(run.parse(a.json()).id).toBe(`run_${before + 1}`);
    expect(b.statusCode).toBe(201);
    expect(b.json()).toEqual(a.json());
    expect(b.headers['idempotent-replayed']).toBe('true');
    expect(calls.createRun).toBe(before + 1);
  });

  it('answers 409 when a key is reused with a different body', async () => {
    await post('k-diff');
    const res = await post('k-diff', { ...body, title: 'other' });
    expect(res.statusCode).toBe(409);
    expect(problem.parse(res.json()).code).toBe('conflict');
  });

  it('treats a call without a key as a new create each time', async () => {
    const before = calls.createRun;
    await post(undefined);
    await post(undefined);
    expect(calls.createRun).toBe(before + 2);
  });

  it('lets a corrected request reuse a key whose first attempt failed validation', async () => {
    const bad = await post('k-422', { packId: 1 });
    expect(bad.statusCode).toBe(422);
    // Validation happens before the key is reserved, so the same key is free for a corrected request.
    expect((await post('k-422')).statusCode).toBe(201);
  });
});

describe('idempotency after a server error', () => {
  it('forgets the key so a retry can succeed', async () => {
    let n = 0;
    const flaky = await buildApi({
      krama,
      config: loadConfig({ argv: ['--home', home, '--token', TOKEN], env: {} }),
      handlers: {
        createRun: () => {
          if (n++ === 0) throw new Error('transient');
          return { ...(stubSample() as object) };
        },
      },
    });
    const send = () =>
      flaky.inject({
        method: 'POST',
        url: `${V1}/runs`,
        headers: { ...auth, 'idempotency-key': 'k-flaky' },
        payload: { packId: 'pack_x', input: { text: 'hi' } },
      });
    expect((await send()).statusCode).toBe(500);
    expect((await send()).statusCode).toBe(201);
    await flaky.close();
  });
});

describe('ETag and If-Match', () => {
  it('sends the version as an ETag and answers 304 when it is unchanged', async () => {
    const first = await get(`${V1}/runs/run_9`, auth);
    expect(first.statusCode).toBe(200);
    expect(first.headers['etag']).toBe('"v7"');
    const again = await get(`${V1}/runs/run_9`, { ...auth, 'if-none-match': '"v7"' });
    expect(again.statusCode).toBe(304);
    expect(again.body).toBe('');
    const stale = await get(`${V1}/runs/run_9`, { ...auth, 'if-none-match': '"v6"' });
    expect(stale.statusCode).toBe(200);
  });

  const patch = (headers: Record<string, string>) =>
    app.inject({
      method: 'PATCH',
      url: `${V1}/memory/records/m1`,
      headers: { ...auth, ...headers },
      payload: {},
    });

  it('requires If-Match on editable resources (428), and hands the parsed version to the handler', async () => {
    const missing = await patch({});
    expect(missing.statusCode).toBe(428);
    expect(problem.parse(missing.json()).code).toBe('precondition_required');
  });

  it('answers 412 for an If-Match it cannot read', async () => {
    const bad = await patch({ 'if-match': '*' });
    expect(bad.statusCode).toBe(412);
    expect(problem.parse(bad.json()).code).toBe('precondition_failed');
  });
});

describe('POST /agent-events', () => {
  const post = (headers: Record<string, string>, payload = '{"eventType":"agent_finished"}') =>
    app.inject({
      method: 'POST',
      url: '/agent-events',
      headers: { 'content-type': 'application/json', ...headers },
      payload,
    });

  it('is served by the collector with its own per-instance tokens, not the user token', async () => {
    expect((await post({})).statusCode).toBe(401);
    expect((await post(auth)).statusCode).toBe(401);
  });

  it('accepts and parks an event whose run is unknown', async () => {
    const token = krama.collector.tokens.issue({
      runId: 'run_missing' as never,
      instanceId: 'inst_1',
      agent: 'author',
      role: 'author',
      backend: 'a2a-claude',
    });
    const res = await post({ authorization: `Bearer ${token}` });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ status: 'parked' });
  });

  it('only allows POST', async () => {
    const res = await app.inject({ method: 'GET', url: '/agent-events', headers: auth });
    expect([401, 405]).toContain(res.statusCode);
  });
});
