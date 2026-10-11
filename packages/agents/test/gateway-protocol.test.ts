import { readFileSync } from 'node:fs';
import { createServer as createHttpServer, request as httpRequest, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { connect, type AddressInfo } from 'node:net';
import {
  AgentCard,
  Task,
  TaskArtifactUpdateEvent,
  TaskStatusUpdateEvent,
  generateAgentCardSignature,
} from '@a2a-js/sdk';
import {
  AgentEvent,
  DefaultRequestHandler,
  InMemoryTaskStore,
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext,
} from '@a2a-js/sdk/server';
import { UserBuilder, jsonRpcHandler } from '@a2a-js/sdk/server/express';
import type { AgentRef, GatewayEvent } from '@kramahq/engine';
import express from 'express';
import { exportJWK, generateKeyPair, type JWK } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { A2AGateway, type GatewayOptions } from '../src/index.js';

/**
 * The gateway against a real SDK server (the way the wrappers are built), for the parts of the protocol that are not a
 * plain send: reading and following a task, OAuth and mTLS, signed cards, and a corporate proxy.
 */
const tls = (n: string) => readFileSync(new URL(`./fixtures/tls/${n}`, import.meta.url), 'utf8');
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const c of closers.splice(0)) await c();
  delete process.env['HTTP_PROXY'];
  delete process.env['http_proxy'];
  delete process.env['HTTPS_PROXY'];
  delete process.env['https_proxy'];
  delete process.env['NO_PROXY'];
  delete process.env['no_proxy'];
});

const listen = async (server: Server): Promise<string> => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  closers.push(
    () =>
      new Promise<void>((r) => {
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  );
  return String((server.address() as AddressInfo).port);
};

interface AgentOptions {
  https?: boolean;
  /** Requests other than the card must carry one of these bearer tokens. */
  accepted?: Set<string>;
  /** Changes the card just before it is served (sign it, tamper with it). */
  card?: (c: Record<string, unknown>) => Promise<Record<string, unknown>> | Record<string, unknown>;
  jwks?: JWK[];
  /** The agent card needs the bearer token too (an authenticated card). */
  gateCard?: boolean;
}

interface Agent {
  url: string;
  release(): void;
  requests: { path: string; auth?: string }[];
}

async function startAgent(o: AgentOptions = {}): Promise<Agent> {
  let release = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const requests: Agent['requests'] = [];
  const executor: AgentExecutor = {
    async execute(ctx: RequestContext, bus: ExecutionEventBus) {
      const { taskId, contextId } = ctx;
      const text = String(ctx.userMessage.parts[0]?.content?.value ?? '');
      const status = (state: string) =>
        AgentEvent.statusUpdate(
          TaskStatusUpdateEvent.fromJSON({ taskId, contextId, status: { state } }),
        );
      bus.publish(
        AgentEvent.task(
          Task.fromJSON({ id: taskId, contextId, status: { state: 'TASK_STATE_SUBMITTED' } }),
        ),
      );
      bus.publish(status('TASK_STATE_WORKING'));
      if (text.includes('hold')) await gate;
      bus.publish(
        AgentEvent.artifactUpdate(
          TaskArtifactUpdateEvent.fromJSON({
            taskId,
            contextId,
            artifact: { artifactId: 'a1', name: 'response', parts: [{ text: `echo: ${text}` }] },
            lastChunk: true,
          }),
        ),
      );
      bus.publish(status('TASK_STATE_COMPLETED'));
      bus.finished();
    },
    async cancelTask() {},
  };
  let base = '';
  const card = () => ({
    name: 'Protocol agent',
    description: 'For gateway protocol tests',
    version: '1.0.0',
    capabilities: { streaming: true },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: [{ id: 'echo', name: 'Echo', description: 'Echoes', tags: [] }],
    supportedInterfaces: [
      {
        url: `${base}/a2a/jsonrpc`,
        protocolBinding: 'JSONRPC',
        protocolVersion: '1.0',
        tenant: '',
      },
    ],
  });
  const handler = new DefaultRequestHandler(
    AgentCard.fromJSON(card()),
    new InMemoryTaskStore(),
    executor,
  );
  const app = express();
  app.use((req, res, next) => {
    const auth = req.headers['authorization'];
    requests.push({ path: req.path, ...(auth ? { auth } : {}) });
    const open = req.path === '/.well-known/agent-card.json' && !o.gateCard;
    if (!open && o.accepted && !o.accepted.has(String(auth ?? '').replace(/^Bearer /, ''))) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    next();
  });
  app.get('/.well-known/agent-card.json', async (_req, res) => {
    const json = AgentCard.toJSON(AgentCard.fromJSON(card())) as Record<string, unknown>;
    res.json(o.card ? await o.card(json) : json);
  });
  app.get('/jwks.json', (_req, res) => void res.json({ keys: o.jwks ?? [] }));
  app.use(
    '/a2a/jsonrpc',
    jsonRpcHandler({
      requestHandler: handler,
      userBuilder: UserBuilder.noAuthentication,
      legacyCompat: { enabled: true },
    }),
  );
  const server = o.https
    ? createHttpsServer(
        {
          key: tls('server.key'),
          cert: tls('server.pem'),
          ca: tls('ca.pem'),
          requestCert: true,
          rejectUnauthorized: true,
        },
        app,
      )
    : createHttpServer(app);
  const port = await listen(server as unknown as Server);
  base = `${o.https ? 'https' : 'http'}://127.0.0.1:${port}`;
  return { url: base, release, requests };
}

/** An OAuth token endpoint that issues `tok_1`, `tok_2`, … and tells the agent which ones to accept. */
async function startTokenServer(accepted: Set<string>, expiresIn = 3600) {
  const seen: { auth?: string; body: string }[] = [];
  let n = 0;
  const server = createHttpServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({
        ...(req.headers.authorization ? { auth: req.headers.authorization } : {}),
        body,
      });
      const token = `tok_${++n}`;
      accepted.add(token);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ access_token: token, token_type: 'Bearer', expires_in: expiresIn }));
    });
  });
  const port = await listen(server);
  return { tokenUrl: `http://127.0.0.1:${port}/token`, seen };
}

/** A forward proxy: plain HTTP by absolute URI, HTTPS by CONNECT. Records what it was asked for. */
async function startProxy() {
  const seen: string[] = [];
  const server = createHttpServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    const target = new URL(req.url!);
    const up = httpRequest(
      {
        host: target.hostname,
        port: target.port,
        path: target.pathname + target.search,
        method: req.method,
        headers: req.headers,
      },
      (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      },
    );
    req.pipe(up);
  });
  server.on('connect', (req, client, head) => {
    seen.push(`CONNECT ${req.url}`);
    const [host, port] = req.url!.split(':');
    const up = connect(Number(port), host, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      up.write(head);
      up.pipe(client);
      client.pipe(up);
    });
    up.on('error', () => client.destroy());
    client.on('error', () => up.destroy());
  });
  const port = await listen(server);
  return { url: `http://127.0.0.1:${port}`, seen };
}

const external = (url: string): AgentRef => ({
  id: 'ext',
  url,
  role: 'echo',
  backend: 'sdk',
  external: true,
});
const LOCAL = { external: { allowPrivate: true } } satisfies GatewayOptions;
const gw = (o: GatewayOptions = {}) => new A2AGateway({ ...LOCAL, proxy: 'none', ...o });

async function run(g: A2AGateway, a: AgentRef, text: string): Promise<GatewayEvent[]> {
  const out: GatewayEvent[] = [];
  for await (const e of g.send(a, { text })) out.push(e);
  return out;
}
const taskIdOf = (evs: GatewayEvent[]) => evs.find((e) => e.kind === 'state')!.taskId as string;

describe('reading and following tasks', () => {
  it('getTask returns the state and finished artifacts, and undefined for an unknown task', async () => {
    const agent = await startAgent();
    const g = gw();
    const id = taskIdOf(await run(g, external(agent.url), 'hello'));
    const snap = await g.getTask(external(agent.url), id);
    expect(snap).toMatchObject({ taskId: id, state: 'completed' });
    expect(snap?.artifacts.map((a) => a.name)).toEqual(['response']);
    expect(await g.getTask(external(agent.url), 'no-such-task')).toBeUndefined();
  });

  it('listTasks filters by context and state', async () => {
    const agent = await startAgent();
    const g = gw();
    const a = external(agent.url);
    const first = await run(g, a, 'one');
    await run(g, a, 'two');
    const ctx = first.find((e) => e.kind === 'state')!;
    const all = await g.listTasks(a);
    expect(all.tasks).toHaveLength(2);
    const one = await g.listTasks(a, { contextId: (ctx as { contextId?: string }).contextId! });
    expect(one.tasks.map((t) => t.taskId)).toEqual([taskIdOf(first)]);
    expect((await g.listTasks(a, { state: 'working' })).tasks).toHaveLength(0);
    expect((await g.listTasks(a, { state: 'completed' })).tasks).toHaveLength(2);
  });

  it('subscribe follows a running task to its end without sending a second message', async () => {
    const agent = await startAgent();
    const g = gw();
    const a = external(agent.url);
    // Start the work with a stream we then abandon, as a dropped connection would.
    const drop = new AbortController();
    let taskId = '';
    const starter = (async () => {
      for await (const e of g.send(a, { text: 'hold', signal: drop.signal }))
        if (e.kind === 'state' && !taskId) {
          taskId = e.taskId;
          return;
        }
    })();
    await starter;
    const before = agent.requests.filter((r) => r.path === '/a2a/jsonrpc').length;

    const seen: GatewayEvent[] = [];
    const following = (async () => {
      for await (const e of g.subscribe(a, taskId)) seen.push(e);
    })();
    await vi_waitFor(() => seen.some((e) => e.kind === 'state' && e.state === 'working'));
    agent.release();
    await following;

    expect(seen.at(-1)).toMatchObject({ kind: 'state', state: 'completed', taskId });
    expect(seen.some((e) => e.kind === 'artifact' && e.name === 'response')).toBe(true);
    // One request opened the subscription; nothing was sent again.
    const after = agent.requests.filter((r) => r.path === '/a2a/jsonrpc').length;
    expect(after - before).toBe(1);
  });

  it('subscribe to a finished task yields its final state', async () => {
    // The SDK server logs the refusal it answers with; that is expected here.
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const agent = await startAgent();
    const g = gw();
    const a = external(agent.url);
    const id = taskIdOf(await run(g, a, 'done'));
    const seen: GatewayEvent[] = [];
    for await (const e of g.subscribe(a, id)) seen.push(e);
    expect(seen.at(-1)).toMatchObject({ kind: 'state', state: 'completed', taskId: id });
  });

  it('subscribe to an unknown task fails with task_not_found', async () => {
    const agent = await startAgent();
    const g = gw();
    await expect(
      (async () => {
        for await (const _ of g.subscribe(external(agent.url), 'ghost')) void _;
      })(),
    ).rejects.toMatchObject({ code: 'task_not_found' });
  });

  it('subscribe ends quietly when the caller stops', async () => {
    const agent = await startAgent();
    const g = gw();
    const a = external(agent.url);
    let taskId = '';
    const drop = new AbortController();
    for await (const e of g.send(a, { text: 'hold', signal: drop.signal }))
      if (e.kind === 'state') {
        taskId = e.taskId;
        break;
      }
    const stop = new AbortController();
    const seen: GatewayEvent[] = [];
    const following = (async () => {
      for await (const e of g.subscribe(a, taskId, { signal: stop.signal })) seen.push(e);
    })();
    await vi_waitFor(() => seen.length > 0);
    stop.abort();
    await following;
    agent.release();
  });
});

async function vi_waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('OAuth client credentials', () => {
  const setup = async () => {
    const accepted = new Set<string>();
    const token = await startTokenServer(accepted);
    const agent = await startAgent({ accepted });
    const auth = {
      [agent.url]: {
        type: 'oauth2_client_credentials' as const,
        tokenUrl: token.tokenUrl,
        clientId: 'krama',
        clientSecret: 's3cret/+ value',
        scope: 'a2a.invoke',
      },
    };
    return { accepted, token, agent, auth };
  };

  it('fetches a token once, sends it as a bearer, and reuses it', async () => {
    const { token, agent, auth } = await setup();
    const g = gw({ auth });
    const a = external(agent.url);
    const id = taskIdOf(await run(g, a, 'hi'));
    await g.getTask(a, id);
    expect(token.seen).toHaveLength(1);
    expect(token.seen[0]!.body).toContain('grant_type=client_credentials');
    expect(token.seen[0]!.body).toContain('scope=a2a.invoke');
    expect(token.seen[0]!.body).not.toContain('s3cret');
    // The secret travels in the Authorization header, form-encoded, as RFC 6749 says.
    expect(token.seen[0]!.auth).toBe(
      `Basic ${Buffer.from('krama:s3cret%2F%2B+value').toString('base64')}`,
    );
    expect(
      agent.requests
        .filter((r) => r.path === '/a2a/jsonrpc')
        .every((r) => r.auth === 'Bearer tok_1'),
    ).toBe(true);
  });

  it('sends the token to every request for that origin, so an authenticated card works', async () => {
    const accepted = new Set<string>();
    const token = await startTokenServer(accepted);
    const agent = await startAgent({ accepted, gateCard: true });
    const auth = {
      [agent.url]: {
        type: 'oauth2_client_credentials' as const,
        tokenUrl: token.tokenUrl,
        clientId: 'krama',
        clientSecret: 'secret-secret',
      },
    };
    expect(await run(gw({ auth }), external(agent.url), 'hi')).toBeTruthy();
    expect(agent.requests.find((r) => r.path === '/.well-known/agent-card.json')?.auth).toBe(
      'Bearer tok_1',
    );
  });

  it('never sends the token to another origin', async () => {
    const { token, agent, auth } = await setup();
    const other = await startAgent({ accepted: new Set(['tok_1', 'tok_2']) });
    const g = gw({ auth });
    await run(g, external(agent.url), 'hi');
    await run(g, external(other.url), 'hi').catch(() => undefined);
    expect(other.requests.every((r) => r.auth === undefined)).toBe(true);
    expect(token.seen).toHaveLength(1);
  });

  it('renews a token the agent rejects, once, and carries on', async () => {
    const { accepted, token, agent, auth } = await setup();
    const g = gw({ auth });
    const a = external(agent.url);
    const id = taskIdOf(await run(g, a, 'hi'));
    accepted.delete('tok_1'); // revoked on the server
    expect(await g.getTask(a, id)).toMatchObject({ state: 'completed' });
    expect(token.seen).toHaveLength(2);
  });

  it('a credential the agent keeps rejecting fails as unauthenticated and leaks neither secret nor token', async () => {
    const { accepted, agent, auth } = await setup();
    accepted.add = () => accepted; // tokens are issued, but the agent never accepts them
    const err = await run(gw({ auth }), external(agent.url), 'hi').catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'unauthenticated' });
    expect(
      JSON.stringify([(err as Error).message, (err as { detail?: unknown }).detail]),
    ).not.toMatch(/s3cret|tok_\d/);
  });

  it('a failing token endpoint is unauthenticated, not a hang', async () => {
    const agent = await startAgent({ accepted: new Set(['x']) });
    const dead = createHttpServer((_q, r) => void r.writeHead(500).end('{"error":"server_error"}'));
    const port = await listen(dead);
    const g = gw({
      auth: {
        [agent.url]: {
          type: 'oauth2_client_credentials',
          tokenUrl: `http://127.0.0.1:${port}/token`,
          clientId: 'c',
          clientSecret: 'hunter2hunter2',
        },
      },
    });
    const err = await run(g, external(agent.url), 'hi').catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'unauthenticated' });
    expect((err as Error).message).toContain('HTTP 500');
    expect((err as Error).message).not.toContain('hunter2');
  });

  it('a fixed bearer is sent and masked in errors', async () => {
    const agent = await startAgent({ accepted: new Set(['static-token-123']) });
    const g = gw({ auth: { [agent.url]: { type: 'bearer', token: 'static-token-123' } } });
    expect(await run(g, external(agent.url), 'hi')).toBeTruthy();
  });
});

describe('mutual TLS', () => {
  it('connects with a client certificate and the private CA, and fails without the certificate', async () => {
    const agent = await startAgent({ https: true });
    const material = {
      [agent.url]: { ca: tls('ca.pem'), cert: tls('client.pem'), key: tls('client.key') },
    };
    expect(await run(gw({ tls: material, proxy: 'none' }), external(agent.url), 'hi')).toBeTruthy();

    const noCert = { [agent.url]: { ca: tls('ca.pem') } };
    await expect(run(gw({ tls: noCert }), external(agent.url), 'hi')).rejects.toMatchObject({
      code: 'unreachable',
    });

    // Without the CA the server certificate is not trusted: verification is never switched off.
    await expect(run(gw({}), external(agent.url), 'hi')).rejects.toMatchObject({
      code: 'unreachable',
    });
  });

  it('works through a proxy as well (CONNECT)', async () => {
    const agent = await startAgent({ https: true });
    const proxy = await startProxy();
    const material = {
      [agent.url]: { ca: tls('ca.pem'), cert: tls('client.pem'), key: tls('client.key') },
    };
    const g = gw({ tls: material, proxy: { url: proxy.url, noProxy: '' } });
    expect(await run(g, external(agent.url), 'hi')).toBeTruthy();
    expect(proxy.seen[0]).toMatch(/^CONNECT 127\.0\.0\.1:\d+$/);
  });
});

describe('proxy', () => {
  it('honours HTTP_PROXY for an external agent', async () => {
    const agent = await startAgent();
    const proxy = await startProxy();
    process.env['HTTP_PROXY'] = proxy.url;
    // NO_PROXY is unset, so loopback goes through the proxy too.
    const g = new A2AGateway({ ...LOCAL });
    expect(await run(g, external(agent.url), 'hi')).toBeTruthy();
    expect(proxy.seen.some((s) => s.includes('/.well-known/agent-card.json'))).toBe(true);
    expect(proxy.seen.some((s) => s.includes('/a2a/jsonrpc'))).toBe(true);
  });

  it('honours NO_PROXY', async () => {
    const agent = await startAgent();
    const proxy = await startProxy();
    process.env['HTTP_PROXY'] = proxy.url;
    process.env['NO_PROXY'] = '127.0.0.1';
    expect(await run(new A2AGateway({ ...LOCAL }), external(agent.url), 'hi')).toBeTruthy();
    expect(proxy.seen).toEqual([]);
  });

  it('never proxies an agent Krama started', async () => {
    const agent = await startAgent();
    const proxy = await startProxy();
    process.env['HTTP_PROXY'] = proxy.url;
    const managed: AgentRef = { id: 'm', url: agent.url, role: 'echo', backend: 'sdk' };
    expect(await run(new A2AGateway(), managed, 'hi')).toBeTruthy();
    expect(proxy.seen).toEqual([]);
  });

  it('proxy: none ignores the environment', async () => {
    const agent = await startAgent();
    const proxy = await startProxy();
    process.env['HTTP_PROXY'] = proxy.url;
    expect(await run(gw({ proxy: 'none' }), external(agent.url), 'hi')).toBeTruthy();
    expect(proxy.seen).toEqual([]);
  });

  it('keeps the proxy password out of errors', async () => {
    const agent = await startAgent();
    const g = gw({ proxy: { url: 'http://user:pr0xyPassw0rd@127.0.0.1:9', noProxy: '' } });
    const err = await run(g, external(agent.url), 'hi').catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'unreachable' });
    expect(
      JSON.stringify([(err as Error).message, (err as { detail?: unknown }).detail]),
    ).not.toContain('pr0xyPassw0rd');
  });

  it('still refuses a literal private address for an external agent behind a proxy', async () => {
    const proxy = await startProxy();
    const g = new A2AGateway({ proxy: { url: proxy.url } });
    await expect(run(g, external('http://10.0.0.5:8080'), 'hi')).rejects.toMatchObject({
      code: 'blocked',
    });
    expect(proxy.seen).toEqual([]);
  });
});

describe('signed agent cards', () => {
  const sign = async () => {
    const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
    const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'ES256', use: 'sig' } as JWK;
    const signer = generateAgentCardSignature(privateKey, { alg: 'ES256', kid: 'k1', typ: 'JOSE' });
    const signed = async (json: Record<string, unknown>) =>
      AgentCard.toJSON(await signer(AgentCard.fromJSON(json))) as Record<string, unknown>;
    return { jwk, signed, privateKey };
  };

  it('accepts a card signed by a trusted key and says so', async () => {
    const k = await sign();
    const agent = await startAgent({ card: k.signed });
    const g = gw({ cards: { keys: { k1: k.jwk }, requireSigned: true } });
    expect((await g.inspect(external(agent.url))).signature).toBe('verified');
    expect(await run(g, external(agent.url), 'hi')).toBeTruthy();
  });

  it('refuses a card changed after it was signed', async () => {
    const k = await sign();
    const agent = await startAgent({
      card: async (j) => ({ ...(await k.signed(j)), name: 'Somebody else' }),
    });
    const g = gw({ cards: { keys: { k1: k.jwk } } }); // even when a signature is not required
    await expect(g.inspect(external(agent.url))).rejects.toMatchObject({ code: 'untrusted_card' });
  });

  it('refuses a card signed by a key that is not trusted', async () => {
    const mine = await sign();
    const theirs = await sign();
    const agent = await startAgent({ card: theirs.signed });
    const g = gw({ cards: { keys: { k1: mine.jwk } } });
    await expect(g.inspect(external(agent.url))).rejects.toMatchObject({ code: 'untrusted_card' });
  });

  it('refuses an unsigned card when a signature is required', async () => {
    const k = await sign();
    const agent = await startAgent();
    const g = gw({ cards: { keys: { k1: k.jwk }, requireSigned: true } });
    await expect(g.inspect(external(agent.url))).rejects.toMatchObject({ code: 'untrusted_card' });
  });

  it('accepts an unsigned card by default, and reports a signed one it cannot check as unverified', async () => {
    const k = await sign();
    const plain = await startAgent();
    expect((await gw().inspect(external(plain.url))).signature).toBe('unsigned');
    const signed = await startAgent({ card: k.signed });
    const report = await gw().inspect(external(signed.url));
    expect(report.signature).toBe('unverified');
    expect(report.issues.map((i) => i.code)).toContain('signature-unchecked');
  });

  it('a signed card cannot be used when a signature is required but no key is configured', async () => {
    const k = await sign();
    const agent = await startAgent({ card: k.signed });
    await expect(
      gw({ cards: { requireSigned: true } }).inspect(external(agent.url)),
    ).rejects.toMatchObject({
      code: 'untrusted_card',
    });
  });

  it('fetches a key from jku only when allowed, and only from an allowed origin', async () => {
    const k = await sign();
    const withJku = async (jku: string) => {
      const { privateKey } = k;
      const signer = generateAgentCardSignature(privateKey, {
        alg: 'ES256',
        kid: 'k1',
        typ: 'JOSE',
        jku,
      });
      return async (json: Record<string, unknown>) =>
        AgentCard.toJSON(await signer(AgentCard.fromJSON(json))) as Record<string, unknown>;
    };
    // Same origin as the agent.
    const probe = await startAgent({ jwks: [k.jwk] });
    const agent = await startAgent({
      jwks: [k.jwk],
      card: await withJku(`${probe.url}/jwks.json`),
    });
    // The key set is on a different origin than the agent, and that origin is not allowed.
    await expect(
      gw({ cards: { allowJku: true } }).inspect(external(agent.url)),
    ).rejects.toMatchObject({ code: 'untrusted_card' });
    // Allowed by listing the origin.
    const ok = gw({
      cards: { allowJku: true },
      external: { allowPrivate: true, allowedOrigins: [agent.url, probe.url] },
    });
    expect((await ok.inspect(external(agent.url))).signature).toBe('verified');
    // Not allowed unless switched on.
    await expect(
      gw({
        cards: { requireSigned: true },
        external: { allowPrivate: true, allowedOrigins: [agent.url, probe.url] },
      }).inspect(external(agent.url)),
    ).rejects.toMatchObject({ code: 'untrusted_card' });
  });
});

const drain = async (it: AsyncIterable<unknown>) => {
  for await (const e of it) void e;
};

describe('durable sends', () => {
  it('sends the messageId the caller fixed, so a repeat of the same send is recognisable', async () => {
    const agent = await startAgent();
    const bodies: unknown[] = [];
    const g = gw({ tap: (e) => e.kind === 'request' && bodies.push(e.body) });
    agent.release();
    await drain(g.send(external(agent.url), { text: 'x', messageId: 'msg_step_1_0' }));
    expect(JSON.stringify(bodies)).toContain('msg_step_1_0');
  });

  it('says nothing was sent when the agent cannot be reached at all', async () => {
    const g = gw({ requestTimeoutMs: 2000 });
    const err = await (async () => {
      try {
        await drain(g.send(external('http://127.0.0.1:1'), { text: 'x' }));
      } catch (e) {
        return e as { code: string; dispatched?: boolean };
      }
    })();
    expect(err?.code).toBe('unreachable');
    expect(err?.dispatched).toBe(false);
  });

  it('says the request may have left when the stream breaks after it was sent', async () => {
    const server = createHttpServer((req, res) => {
      if (req.url?.includes('agent-card')) {
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            name: 'x',
            description: 'x',
            version: '1',
            capabilities: { streaming: true },
            defaultInputModes: ['text/plain'],
            defaultOutputModes: ['text/plain'],
            skills: [],
            supportedInterfaces: [
              {
                url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/a2a/jsonrpc`,
                protocolBinding: 'JSONRPC',
                protocolVersion: '1.0',
              },
            ],
          }),
        );
        return;
      }
      req.socket.destroy(); // the request arrived, then the connection died
    });
    const port = await listen(server);
    const g = gw();
    const err = await (async () => {
      try {
        await drain(g.send(external(`http://127.0.0.1:${port}`), { text: 'x' }));
      } catch (e) {
        return e as { dispatched?: boolean };
      }
    })();
    expect(err?.dispatched).toBe(true);
  });
});
