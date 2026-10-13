import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BackendRegistry } from '@kramahq/agents';
import { API_BASE_PATH, type Run } from '@kramahq/contract';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApi, createKrama, loadConfig, type Krama } from '../src/index.js';
import { DEMO_BACKEND, DEMO_DEFINITIONS, DEMO_PACK } from '../src/demo/pack.js';

const TOKEN = 'test-token-0123456789abcdef';
const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
const V1 = API_BASE_PATH;

let home: string;
let krama: Krama;
const apps: Record<string, FastifyInstance> = {};

const as = async (name: string, roles: string[]) => {
  const config = loadConfig({ argv: ['--home', home, '--token', TOKEN, '--port', '0'], env: {} });
  apps[name] = await buildApi({
    krama,
    config,
    validateResponses: true,
    autoStartRuns: false,
    principal: { id: `u_${name}`, name: `${name} person`, roles, permissions: [] },
  });
  await apps[name]!.ready();
};

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'krama-identity-'));
  const backends = BackendRegistry.withBuiltins();
  backends.register(DEMO_BACKEND, 'user');
  krama = await createKrama({ home, packs: [DEMO_PACK], definitions: DEMO_DEFINITIONS, backends });
  await as('viewer', ['viewer']);
  await as('operator', ['operator']);
  await as('requester', ['requester']);
  await as('approver', ['approver']);
}, 60_000);

afterAll(async () => {
  for (const a of Object.values(apps)) await a.close();
  await krama?.close();
  rmSync(home, { recursive: true, force: true });
});

const call = (who: string, method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown) =>
  apps[who]!.inject({
    method,
    url: `${V1}${path}`,
    headers: auth,
    ...(body !== undefined ? { payload: body as object } : {}),
  });

describe('the principal behind a command is on the control record', () => {
  it('records who created and changed a run, with their highest role', async () => {
    const res = await call('operator', 'POST', '/runs', {
      packId: DEMO_PACK.id,
      input: { text: 'who did this?' },
    });
    expect(res.statusCode).toBe(201);
    const run = res.json() as Run;
    expect(run.createdBy).toMatchObject({ id: 'u_operator', role: 'operator' });
    const etag = (await call('operator', 'GET', `/runs/${run.id}`)).headers['etag'] as string;
    const patch = await apps['operator']!.inject({
      method: 'PATCH',
      url: `${V1}/runs/${run.id}`,
      headers: { ...auth, 'if-match': etag },
      payload: { title: 'Renamed' },
    });
    expect(patch.statusCode).toBe(200);

    const control = (await krama.ports.ledger!.read('control')).filter((r) => r.runId === run.id);
    expect(control.map((r) => [r.kind, r.actor.id, r.actor.role])).toEqual([
      ['run.created', 'u_operator', 'operator'],
      ['run.updated', 'u_operator', 'operator'],
    ]);
    expect((await krama.ports.ledger!.verify('control')).ok).toBe(true);
  });

  it('a command that fails leaves no control record behind', async () => {
    const before = (await krama.ports.ledger!.head('control'))?.seq ?? 0;
    const bad = await call('operator', 'POST', '/runs', { packId: 'pack_missing', input: {} });
    expect(bad.statusCode).toBe(404);
    expect((await krama.ports.ledger!.head('control'))?.seq ?? 0).toBe(before);
  });
});

describe('roles gate decisions', () => {
  const openDecision = async () => {
    const run = (await call('operator', 'POST', '/runs', {
      packId: DEMO_PACK.id,
      input: { text: 'needs a decision' },
    }).then((r) => r.json())) as Run;
    const d = await krama.engine.decisions.request({
      decision: {
        id: krama.ports.ids.next('dec'),
        kind: 'approval',
        runId: run.id,
        title: 'Approve the notes',
        question: 'Ok?',
        context: { artifacts: [] },
        options: [{ id: 'approve', label: 'Approve', style: 'primary' }],
        createdAt: new Date().toISOString(),
        links: {},
      },
    });
    return d.id;
  };

  it('refuses a viewer and a requester, lets an approver resolve, and records who', async () => {
    const id = await openDecision();
    const body = { optionId: 'approve' };
    expect((await call('viewer', 'POST', `/decisions/${id}/resolve`, body)).statusCode).toBe(403);
    expect((await call('requester', 'POST', `/decisions/${id}/resolve`, body)).statusCode).toBe(
      403,
    );
    const ok = await call('approver', 'POST', `/decisions/${id}/resolve`, body);
    expect(ok.statusCode).toBe(200);
    const rec = (await krama.ports.ledger!.read('control')).find(
      (r) => r.kind === 'decision.resolved' && r.decisionId === id,
    );
    expect(rec).toMatchObject({ actor: { id: 'u_approver', role: 'approver' } });
    // The refused attempts changed nothing and wrote nothing.
    expect(
      (await krama.ports.ledger!.read('control')).filter(
        (r) => r.kind === 'decision.resolved' && r.decisionId === id,
      ),
    ).toHaveLength(1);
  });
});
