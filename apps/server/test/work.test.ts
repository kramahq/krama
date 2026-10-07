import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BackendRegistry } from '@kramahq/agents';
import { API_BASE_PATH, ROUTES, type Run } from '@kramahq/contract';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApi, createKrama, loadConfig, type Krama } from '../src/index.js';
import { DEMO_BACKEND, DEMO_DEFINITIONS, DEMO_PACK } from '../src/demo/pack.js';
import { artifactHandlers } from '../src/api/artifacts.js';
import { catalogHandlers } from '../src/api/catalog.js';
import { workHandlers } from '../src/api/work.js';
import { parseGitStatus, workspaceHandlers } from '../src/api/workspaces.js';

const TOKEN = 'test-token-0123456789abcdef';
const auth = { authorization: `Bearer ${TOKEN}` };
const V1 = API_BASE_PATH;

let home: string;
let krama: Krama;
let app: FastifyInstance;

const gitAvailable = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'krama-work-'));
  const backends = BackendRegistry.withBuiltins();
  backends.register(DEMO_BACKEND, 'user');
  krama = await createKrama({
    home,
    packs: [DEMO_PACK],
    definitions: DEMO_DEFINITIONS,
    backends,
  });
  const config = loadConfig({ argv: ['--home', home, '--token', TOKEN, '--port', '0'], env: {} });
  // Routes only: a created run stays in `planning` until a test moves it.
  app = await buildApi({ krama, config, validateResponses: true, autoStartRuns: false });
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
  await krama?.close();
  rmSync(home, { recursive: true, force: true });
});

const call = (
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  path: string,
  o: { body?: unknown; headers?: Record<string, string> } = {},
) =>
  app.inject({
    method,
    url: `${V1}${path}`,
    headers: { ...auth, ...(o.headers ?? {}) },
    ...(o.body !== undefined ? { payload: o.body as object } : {}),
  });

const newRun = async (text = 'write the notes'): Promise<Run> => {
  const res = await call('POST', '/runs', { body: { packId: DEMO_PACK.id, input: { text } } });
  expect(res.statusCode).toBe(201);
  return res.json() as Run;
};

const problemOf = (res: { json(): unknown }) => res.json() as { code: string; status: number };

describe('runs', () => {
  it('creates a run in planning, with a Location and links', async () => {
    const res = await call('POST', '/runs', {
      body: { packId: DEMO_PACK.id, input: { text: 'ship it' }, labels: ['a'] },
    });
    expect(res.statusCode).toBe(201);
    const run = res.json() as Run;
    expect(run.status).toBe('planning');
    expect(run.title).toBe('ship it');
    expect(run.createdBy.id).toBe('u_local');
    expect(res.headers['location']).toBe(`${V1}/runs/${run.id}`);
    expect(run.links['self']?.href).toBe(`${V1}/runs/${run.id}`);
    expect(run.phases?.map((p) => p.id)).toEqual(['draft', 'review']);
  });

  it('answers a repeated Idempotency-Key with the same run', async () => {
    const send = () =>
      call('POST', '/runs', {
        body: { packId: DEMO_PACK.id, input: { text: 'once' } },
        headers: { 'idempotency-key': 'work-test-1' },
      });
    const a = (await send()).json() as Run;
    const second = await send();
    expect((second.json() as Run).id).toBe(a.id);
    expect(second.headers['idempotent-replayed']).toBe('true');
  });

  it('rejects an unknown pack and an unknown project', async () => {
    const pack = await call('POST', '/runs', { body: { packId: 'pack_nope', input: {} } });
    expect(pack.statusCode).toBe(404);
    expect(problemOf(pack).code).toBe('not_found');
    const project = await call('POST', '/runs', {
      body: { packId: DEMO_PACK.id, projectId: 'proj_nope', input: {} },
    });
    expect(project.statusCode).toBe(422);
  });

  it('lists newest first, pages with opaque cursors and filters', async () => {
    const a = await newRun('list-a');
    const b = await newRun('list-b');
    await call('PATCH', `/runs/${b.id}`, {
      body: { labels: ['urgent'] },
      headers: { 'if-match': (await call('GET', `/runs/${b.id}`)).headers['etag'] as string },
    });

    const first = await call('GET', '/runs?limit=1');
    const page1 = first.json() as { items: Run[]; nextCursor?: string };
    expect(page1.items).toHaveLength(1);
    expect(page1.nextCursor).toBeTruthy();
    const page2 = (await call('GET', `/runs?limit=1&cursor=${page1.nextCursor}`)).json() as {
      items: Run[];
    };
    expect(page2.items[0]!.id).not.toBe(page1.items[0]!.id);

    const urgent = (await call('GET', '/runs?labels=urgent')).json() as { items: Run[] };
    expect(urgent.items.map((r) => r.id)).toEqual([b.id]);
    const byText = (await call('GET', '/runs?q=list-a')).json() as { items: Run[] };
    expect(byText.items.map((r) => r.id)).toEqual([a.id]);
    const byStatus = (await call('GET', '/runs?status=planning,running')).json() as {
      items: Run[];
    };
    expect(byStatus.items.length).toBeGreaterThan(0);
    // The runs table draws phases, so a list carries them.
    expect(byStatus.items[0]!.phases).toBeDefined();
  });

  it('rejects an unknown status, sort, cursor and expand', async () => {
    expect((await call('GET', '/runs?status=sleeping')).statusCode).toBe(422);
    expect((await call('GET', '/runs?sort=title')).statusCode).toBe(422);
    expect((await call('GET', '/runs?cursor=zzz')).statusCode).toBe(422);
    const id = (await newRun()).id;
    expect((await call('GET', `/runs/${id}?expand=cost`)).statusCode).toBe(422);
  });

  it('serves a run with an ETag, phases only when expanded, and 304 when unchanged', async () => {
    const run = await newRun();
    const plain = await call('GET', `/runs/${run.id}`);
    expect((plain.json() as Run).phases).toBeUndefined();
    const etag = plain.headers['etag'] as string;
    expect(etag).toMatch(/^"v\d+"$/);
    const expanded = await call('GET', `/runs/${run.id}?expand=phases`);
    expect((expanded.json() as Run).phases).toHaveLength(2);
    const again = await call('GET', `/runs/${run.id}`, { headers: { 'if-none-match': etag } });
    expect(again.statusCode).toBe(304);
    expect((await call('GET', '/runs/run_missing')).statusCode).toBe(404);
  });

  it('changes mode, labels, title and budget only against the current version', async () => {
    const run = await newRun();
    const etag = (await call('GET', `/runs/${run.id}`)).headers['etag'] as string;

    const noHeader = await call('PATCH', `/runs/${run.id}`, { body: { mode: 'autopilot' } });
    expect(noHeader.statusCode).toBe(428);

    const ok = await call('PATCH', `/runs/${run.id}`, {
      body: { mode: 'autopilot', title: 'Renamed', labels: ['x', 'x', 'y'], budget: { max: 12 } },
      headers: { 'if-match': etag },
    });
    expect(ok.statusCode).toBe(200);
    const patched = ok.json() as Run;
    expect(patched).toMatchObject({ mode: 'autopilot', title: 'Renamed', labels: ['x', 'y'] });
    expect(patched.budget.max.amount).toBe(12);
    expect(ok.headers['etag']).not.toBe(etag);

    const stale = await call('PATCH', `/runs/${run.id}`, {
      body: { title: 'Again' },
      headers: { 'if-match': etag },
    });
    expect(stale.statusCode).toBe(412);

    const current = ok.headers['etag'] as string;
    const empty = await call('PATCH', `/runs/${run.id}`, {
      body: { title: '  ' },
      headers: { 'if-match': current },
    });
    expect(empty.statusCode).toBe(422);
    const negative = await call('PATCH', `/runs/${run.id}`, {
      body: { budget: { max: -1 } },
      headers: { 'if-match': current },
    });
    expect(negative.statusCode).toBe(422);
  });

  it('pauses, resumes through the runner, and stops', async () => {
    const run = await newRun();
    await krama.engine.runs.plan(run.id);

    const paused = await call('POST', `/runs/${run.id}/pause`);
    expect(paused.statusCode).toBe(200);
    expect((paused.json() as Run).status).toBe('paused');

    const resume = vi
      .spyOn(krama.runner, 'resume')
      .mockImplementation(async (id, actor) => void (await krama.engine.runs.resume(id, actor!)));
    const resumed = await call('POST', `/runs/${run.id}/resume`, { body: {} });
    expect((resumed.json() as Run).status).toBe('running');
    expect(resume).toHaveBeenCalledWith(run.id, expect.objectContaining({ id: 'u_local' }));
    const notPaused = await call('POST', `/runs/${run.id}/resume`);
    expect(notPaused.statusCode).toBe(409);
    resume.mockRestore();

    const stop = vi.spyOn(krama.runner, 'stop').mockResolvedValue();
    const stopped = await call('POST', `/runs/${run.id}/stop`, { body: { reason: 'enough' } });
    expect(stopped.statusCode).toBe(200);
    expect(stopped.json()).toMatchObject({ status: 'stopped', statusReason: 'enough' });
    expect(stop).toHaveBeenCalledWith(run.id);
    stop.mockRestore();
    // A stopped run cannot be paused: a rule of the engine, answered as a conflict.
    expect((await call('POST', `/runs/${run.id}/pause`)).statusCode).toBe(409);
  });

  it('estimates from the pack and the history of its completed runs', async () => {
    const res = await call('POST', '/runs/estimate', {
      body: { packId: DEMO_PACK.id, input: { text: 'x' } },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { phases: { id: string }[]; typical: { basedOnRuns: number } };
    expect(body.phases.map((p) => p.id)).toEqual(['draft', 'review']);
    expect(body.typical.basedOnRuns).toBe(0);
  });

  it('serves phases and steps', async () => {
    const run = await newRun();
    const phases = (await call('GET', `/runs/${run.id}/phases`)).json() as {
      items: { id: string }[];
    };
    expect(phases.items.map((p) => p.id)).toEqual(['draft', 'review']);
    expect((await call('GET', `/runs/${run.id}/phases/draft`)).statusCode).toBe(200);
    expect((await call('GET', `/runs/${run.id}/phases/nope`)).statusCode).toBe(404);
    const steps = (await call('GET', `/runs/${run.id}/steps`)).json() as { items: unknown[] };
    expect(steps.items).toEqual([]);
  });
});

describe('activity, messages and cost', () => {
  const agentOf = (role: string) => ({ id: `agt_${role}`, role, backend: 'a2a-demo' });
  const emit = (runId: string, type: string, data: Record<string, unknown>) =>
    krama.ports.events.append({
      type,
      runId: runId as `run_${string}`,
      subject: { type: 'agent', id: 'agt_author' },
      data,
    });

  it('reads activity from the run events, with filters and cursors', async () => {
    const run = await newRun();
    await emit(run.id, 'activity.tool_call', {
      kind: 'tool_call',
      toolName: 'fs.read',
      phaseId: 'draft',
      agent: agentOf('author'),
    });
    await emit(run.id, 'activity.message', {
      kind: 'message',
      text: 'Here is a draft',
      phaseId: 'draft',
      agent: agentOf('author'),
    });
    await emit(run.id, 'activity.status', {
      kind: 'thinking',
      text: 'hmm',
      phaseId: 'review',
      agent: agentOf('reviewer'),
    });
    // An event of another run, and an event that is not activity, never show up.
    const other = await newRun();
    await emit(other.id, 'activity.message', { kind: 'message', text: 'elsewhere' });
    await emit(run.id, 'run.updated', { status: 'running' });

    const all = (await call('GET', `/runs/${run.id}/activity`)).json() as {
      items: { type: string; toolName?: string; agent?: { role: string } }[];
    };
    expect(all.items.map((i) => i.type)).toEqual(['tool_call', 'message', 'thinking']);
    expect(all.items[0]).toMatchObject({ toolName: 'fs.read', agent: { role: 'author' } });

    const byType = (await call('GET', `/runs/${run.id}/activity?type=message,thinking`)).json() as {
      items: unknown[];
    };
    expect(byType.items).toHaveLength(2);
    const byAgent = (await call('GET', `/runs/${run.id}/activity?agent=agt_reviewer`)).json() as {
      items: { type: string }[];
    };
    expect(byAgent.items.map((i) => i.type)).toEqual(['thinking']);
    const byPhase = (await call('GET', `/runs/${run.id}/activity?phase=draft`)).json() as {
      items: unknown[];
    };
    expect(byPhase.items).toHaveLength(2);

    const first = (await call('GET', `/runs/${run.id}/activity?limit=2`)).json() as {
      items: unknown[];
      nextCursor?: string;
    };
    expect(first.items).toHaveLength(2);
    const rest = (
      await call('GET', `/runs/${run.id}/activity?limit=2&cursor=${first.nextCursor}`)
    ).json() as { items: { type: string }[]; nextCursor?: string };
    expect(rest.items.map((i) => i.type)).toEqual(['thinking']);
    expect(rest.nextCursor).toBeUndefined();

    const messages = (await call('GET', `/runs/${run.id}/messages`)).json() as {
      items: { text?: string }[];
    };
    expect(messages.items.map((m) => m.text)).toEqual(['Here is a draft']);
    expect((await call('GET', '/runs/run_missing/activity')).statusCode).toBe(404);
  });

  it('reports cost per phase, agent and backend, never estimating', async () => {
    const run = await newRun();
    await krama.engine.runs.plan(run.id);
    const noCost = (await call('GET', `/runs/${run.id}/cost`)).json() as { total: unknown };
    expect(noCost.total).toBeNull();

    await krama.engine.budget.record({
      runId: run.id,
      phaseId: 'draft',
      cost: { amount: 0.5, currency: 'USD' },
      usage: [{ unit: 'tokens', quantity: 100 }],
    });
    await krama.engine.budget.record({
      runId: run.id,
      phaseId: 'draft',
      cost: null,
      usage: [{ unit: 'tokens', quantity: 50 }],
    });
    const cost = (await call('GET', `/runs/${run.id}/cost`)).json() as {
      total: { amount: number };
      usage: { unit: string; quantity: number }[];
      byPhase: { key: string; cost: { amount: number } | null }[];
      byAgent: { key: string }[];
      byTool: unknown[];
    };
    expect(cost.total.amount).toBe(0.5);
    expect(cost.usage).toEqual([{ unit: 'tokens', quantity: 150 }]);
    expect(cost.byPhase.find((p) => p.key === 'draft')?.cost?.amount).toBe(0.5);
    expect(cost.byPhase.find((p) => p.key === 'review')?.cost).toBeNull();
    // Usage the orchestrator reported on its own belongs to the orchestrator.
    expect(cost.byAgent.map((a) => a.key)).toEqual(['orchestrator']);
    expect(cost.byTool).toEqual([]);
  });
});

describe('decisions', () => {
  const open = async (runId: string, title = 'Approve the notes') =>
    krama.engine.decisions.request({
      decision: {
        id: krama.ports.ids.next('dec'),
        kind: 'approval',
        runId: runId as `run_${string}`,
        title,
        question: 'Ship it?',
        options: [
          { id: 'approve', label: 'Approve', style: 'primary' },
          { id: 'reject', label: 'Reject', style: 'danger' },
        ],
        createdAt: new Date().toISOString(),
        links: {},
      },
    });

  it('lists, filters, reads and resolves; the second resolve is a conflict', async () => {
    const run = await newRun();
    await krama.engine.runs.plan(run.id);
    const d = await open(run.id);

    const inbox = (await call('GET', `/decisions?status=pending&runId=${run.id}`)).json() as {
      items: { id: string; links: Record<string, unknown> }[];
    };
    expect(inbox.items.map((x) => x.id)).toEqual([d.id]);
    expect(inbox.items[0]!.links['resolve']).toBeDefined();
    const perRun = (await call('GET', `/runs/${run.id}/decisions`)).json() as { items: unknown[] };
    expect(perRun.items).toHaveLength(1);
    expect(
      ((await call('GET', `/decisions?kind=review&runId=${run.id}`)).json() as { items: [] }).items,
    ).toEqual([]);
    expect(
      ((await call('GET', `/decisions?q=notes&runId=${run.id}`)).json() as { items: [] }).items,
    ).toHaveLength(1);
    expect((await call('GET', `/decisions/${d.id}`)).statusCode).toBe(200);
    expect((await call('GET', '/decisions/dec_missing')).statusCode).toBe(404);
    expect((await call('GET', '/decisions?status=maybe')).statusCode).toBe(422);

    const bad = await call('POST', `/decisions/${d.id}/resolve`, { body: { optionId: 'nope' } });
    expect(bad.statusCode).toBe(422);
    const ok = await call('POST', `/decisions/${d.id}/resolve`, { body: { optionId: 'approve' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ status: 'resolved', resolution: { optionId: 'approve' } });
    const twice = await call('POST', `/decisions/${d.id}/resolve`, {
      body: { optionId: 'approve' },
    });
    expect(twice.statusCode).toBe(409);
    expect(problemOf(twice).code).toBe('decision_resolved');
    const none = (await call('GET', `/decisions?status=pending&runId=${run.id}`)).json() as {
      items: unknown[];
    };
    expect(none.items).toEqual([]);
  });
});

describe('projects', () => {
  it('creates, lists, reads and changes a project against its version', async () => {
    const res = await call('POST', '/projects', {
      body: { name: 'Docs', defaultPackId: DEMO_PACK.id, budget: { max: 25 } },
    });
    expect(res.statusCode).toBe(201);
    const p = res.json() as { id: string; memoryScope: { id: string }; budget: { spent: null } };
    expect(res.headers['location']).toBe(`${V1}/projects/${p.id}`);
    expect(p.memoryScope.id).toBe(p.id);
    expect(p.budget.spent).toBeNull();

    const listed = (await call('GET', '/projects')).json() as { items: { id: string }[] };
    expect(listed.items.map((x) => x.id)).toContain(p.id);

    const got = await call('GET', `/projects/${p.id}`);
    const etag = got.headers['etag'] as string;
    expect(etag).toBeTruthy();
    expect((await call('PATCH', `/projects/${p.id}`, { body: { name: 'X' } })).statusCode).toBe(
      428,
    );
    const patched = await call('PATCH', `/projects/${p.id}`, {
      body: { name: 'Docs 2', budget: { max: 30 } },
      headers: { 'if-match': etag },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({ name: 'Docs 2', budget: { max: { amount: 30 } } });
    const stale = await call('PATCH', `/projects/${p.id}`, {
      body: { name: 'Late' },
      headers: { 'if-match': etag },
    });
    expect(stale.statusCode).toBe(412);
  });

  it('validates a project and uses it for runs', async () => {
    expect((await call('POST', '/projects', { body: { name: ' ' } })).statusCode).toBe(422);
    expect(
      (await call('POST', '/projects', { body: { name: 'a', budget: { max: 0 } } })).statusCode,
    ).toBe(422);
    expect(
      (await call('POST', '/projects', { body: { name: 'a', defaultPackId: 'pack_nope' } }))
        .statusCode,
    ).toBe(422);
    const p = (await call('POST', '/projects', { body: { name: 'Runs home' } })).json() as {
      id: string;
    };
    const run = await call('POST', '/runs', {
      body: { packId: DEMO_PACK.id, projectId: p.id, input: { text: 'in a project' } },
    });
    expect(run.statusCode).toBe(201);
    const inProject = (await call('GET', `/runs?project=${p.id}`)).json() as { items: Run[] };
    expect(inProject.items).toHaveLength(1);
    expect((await call('GET', '/projects/proj_missing')).statusCode).toBe(404);
  });
});

describe('workspaces', () => {
  let run: Run;
  let shared: string;
  const ws = (suffix: string) => `/runs/${run.id}/workspaces/shared${suffix}`;

  beforeAll(async () => {
    run = await newRun('workspace run');
    shared = join(krama.workspaceRoot, 'runs', run.id, 'shared');
    mkdirSync(join(shared, 'src'), { recursive: true });
    mkdirSync(join(krama.workspaceRoot, 'runs', run.id, 'agents', 'agt_private'), {
      recursive: true,
    });
    writeFileSync(join(shared, 'README.md'), '# Notes\nhello\n');
    writeFileSync(join(shared, 'src', 'index.ts'), 'export const x = 1;\n');
    writeFileSync(join(shared, 'blob.bin'), Buffer.from(Array.from({ length: 256 }, (_, i) => i)));
  });

  it('lists the shared and the private workspaces', async () => {
    const res = await call('GET', `/runs/${run.id}/workspaces`);
    const items = (res.json() as { items: { id: string; mode: string }[] }).items;
    expect(items.map((w) => [w.id, w.mode])).toEqual([
      ['shared', 'shared'],
      ['agt_private', 'isolated'],
    ]);
    expect((await call('GET', '/runs/run_missing/workspaces')).statusCode).toBe(404);
    expect((await call('GET', `/runs/${run.id}/workspaces/nope/tree`)).statusCode).toBe(404);
  });

  it('browses the tree, folders first', async () => {
    const root = (await call('GET', ws('/tree'))).json() as {
      items: { name: string; path: string; type: string; size?: number }[];
    };
    expect(root.items.map((e) => `${e.type}:${e.name}`)).toEqual([
      'dir:src',
      'file:blob.bin',
      'file:README.md',
    ]);
    const sub = (await call('GET', ws('/tree?path=src'))).json() as {
      items: { path: string; size: number }[];
    };
    expect(sub.items).toEqual([{ name: 'index.ts', path: 'src/index.ts', type: 'file', size: 20 }]);
    expect((await call('GET', ws('/tree?path=README.md'))).statusCode).toBe(422);
    expect((await call('GET', ws('/tree?path=missing'))).statusCode).toBe(404);
  });

  it('serves file bytes untouched, with ranges and validators', async () => {
    const res = await call('GET', ws('/file?path=blob.bin'));
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/octet-stream');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(
      Buffer.from(res.rawPayload).equals(Buffer.from(Array.from({ length: 256 }, (_, i) => i))),
    ).toBe(true);

    const part = await call('GET', ws('/file?path=blob.bin'), {
      headers: { range: 'bytes=10-19' },
    });
    expect(part.statusCode).toBe(206);
    expect(part.headers['content-range']).toBe('bytes 10-19/256');
    expect([...part.rawPayload]).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
    const suffix = await call('GET', ws('/file?path=blob.bin'), { headers: { range: 'bytes=-4' } });
    expect([...suffix.rawPayload]).toEqual([252, 253, 254, 255]);
    const beyond = await call('GET', ws('/file?path=blob.bin'), {
      headers: { range: 'bytes=999-' },
    });
    expect(beyond.statusCode).toBe(416);
    expect(beyond.headers['content-range']).toBe('bytes */256');

    const etag = res.headers['etag'] as string;
    const cached = await call('GET', ws('/file?path=blob.bin'), {
      headers: { 'if-none-match': etag },
    });
    expect(cached.statusCode).toBe(304);

    const md = await call('GET', ws('/file?path=README.md'));
    expect(md.headers['content-type']).toBe('text/markdown; charset=utf-8');
    expect(md.body).toBe('# Notes\nhello\n');
    expect((await call('GET', ws('/file?path=src'))).statusCode).toBe(422);
    expect((await call('GET', ws('/file'))).statusCode).toBe(422);
  });

  it('never leaves the workspace: not by .., not by an absolute path, not by a link', async () => {
    writeFileSync(join(home, 'secret.txt'), 'top secret');
    for (const path of [
      '../../../../../secret.txt',
      '..',
      '/etc/passwd',
      'C:\\Windows\\win.ini',
      'a\0b',
    ]) {
      const res = await call('GET', ws(`/file?path=${encodeURIComponent(path)}`));
      expect([403, 404, 422]).toContain(res.statusCode);
      expect(res.body).not.toContain('top secret');
    }
    let linked = false;
    try {
      symlinkSync(join(home, 'secret.txt'), join(shared, 'escape.txt'));
      symlinkSync(home, join(shared, 'escape-dir'));
      linked = true;
    } catch {
      // links need a privilege on some systems; the rest of the test still holds
    }
    if (linked) {
      const file = await call('GET', ws('/file?path=escape.txt'));
      expect(file.statusCode).toBe(403);
      expect(file.body).not.toContain('top secret');
      expect((await call('GET', ws('/file?path=escape-dir/secret.txt'))).statusCode).toBe(403);
      expect((await call('GET', ws('/tree?path=escape-dir'))).statusCode).toBe(403);
      const root = (await call('GET', ws('/tree'))).json() as { items: { name: string }[] };
      expect(root.items.map((e) => e.name)).not.toContain('escape.txt');
      expect(root.items.map((e) => e.name)).not.toContain('escape-dir');
    }
  });

  it.skipIf(!gitAvailable)(
    'reports git status and diff, and nothing outside a repository',
    async () => {
      const plain = await call('GET', ws('/git-status'));
      expect(plain.json()).toEqual({ files: [] });
      expect((await call('GET', ws('/diff'))).json()).toEqual({ base: 'HEAD', diff: '' });

      const git = (...args: string[]) =>
        execFileSync(
          'git',
          [
            '-c',
            'user.name=t',
            '-c',
            'user.email=t@example.com',
            '-c',
            'commit.gpgsign=false',
            ...args,
          ],
          { cwd: shared, stdio: 'ignore' },
        );
      git('init', '-q', '-b', 'work');
      git('add', 'README.md', 'src');
      git('commit', '-q', '-m', 'first');
      writeFileSync(join(shared, 'README.md'), '# Notes\nchanged\n');
      writeFileSync(join(shared, 'fresh.txt'), 'new');

      const status = (await call('GET', ws('/git-status'))).json() as {
        branch?: string;
        files: { path: string; status: string }[];
      };
      expect(status.branch).toBe('work');
      expect(status.files).toContainEqual({ path: 'README.md', status: 'modified' });
      expect(status.files).toContainEqual({ path: 'fresh.txt', status: 'untracked' });

      const diff = (await call('GET', ws('/diff'))).json() as { base: string; diff: string };
      expect(diff.base).toBe('HEAD');
      expect(diff.diff).toContain('-hello');
      expect(diff.diff).toContain('+changed');
      expect((await call('GET', ws('/diff?base=--output=/tmp/x'))).statusCode).toBe(422);
      expect((await call('GET', ws('/diff?base=nope-nope'))).json()).toEqual({
        base: 'nope-nope',
        diff: '',
      });
    },
  );

  it('parses porcelain status', () => {
    const out = [
      '## main...origin/main [ahead 1]',
      ' M a.ts',
      'A  b.ts',
      ' D c.ts',
      'R  new.ts',
      'old.ts',
      '?? d.ts',
      '',
    ].join('\0');
    expect(parseGitStatus(out)).toEqual({
      branch: 'main',
      files: [
        { path: 'a.ts', status: 'modified' },
        { path: 'b.ts', status: 'added' },
        { path: 'c.ts', status: 'deleted' },
        { path: 'new.ts', status: 'renamed' },
        { path: 'd.ts', status: 'untracked' },
      ],
    });
    expect(parseGitStatus('## No commits yet on trunk\0').branch).toBe('trunk');
    expect(parseGitStatus('## HEAD (no branch)\0').branch).toBeUndefined();
  });
});

describe('artifacts', () => {
  const put = (runId: string, name: string, text: string, o: Record<string, unknown> = {}) =>
    krama.ports.artifacts.put({
      runId,
      name,
      type: 'document',
      mediaType: 'text/plain',
      producer: { type: 'agent', id: 'agt_author' },
      bytes: new TextEncoder().encode(text),
      ...o,
    });

  it('lists a run’s artifacts and filters them', async () => {
    const run = await newRun();
    const a = await put(run.id, 'notes.txt', 'hello world', { phaseId: 'draft' });
    await put(run.id, 'other.json', '{}', { type: 'data', mediaType: 'application/json' });
    const all = (await call('GET', `/runs/${run.id}/artifacts`)).json() as {
      items: { id: string; links: Record<string, { href: string }> }[];
    };
    expect(all.items).toHaveLength(2);
    expect(all.items[0]!.links['content']!.href).toContain('/content');
    const byType = (await call('GET', `/runs/${run.id}/artifacts?type=data`)).json() as {
      items: unknown[];
    };
    expect(byType.items).toHaveLength(1);
    const byPhase = (await call('GET', `/runs/${run.id}/artifacts?phase=draft`)).json() as {
      items: { id: string }[];
    };
    expect(byPhase.items.map((i) => i.id)).toEqual([a.id]);
    expect((await call('GET', `/runs/${run.id}/artifacts?status=odd`)).statusCode).toBe(422);
    expect((await call('GET', `/artifacts/${a.id}`)).statusCode).toBe(200);
    expect((await call('GET', '/artifacts/art_missing')).statusCode).toBe(404);
  });

  it('serves content with its hash as ETag, ranges, and a safe filename', async () => {
    const run = await newRun();
    const a = await put(run.id, 'quo"te/d name.txt', '0123456789');
    const res = await call('GET', `/artifacts/${a.id}/content`);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('0123456789');
    expect(res.headers['etag']).toBe(`"${a.sha256}"`);
    expect(res.headers['content-type']).toBe('text/plain');
    expect(res.headers['content-disposition']).toBe("inline; filename*=UTF-8''quo_te_d%20name.txt");
    const part = await call('GET', `/artifacts/${a.id}/content`, {
      headers: { range: 'bytes=2-4' },
    });
    expect(part.statusCode).toBe(206);
    expect(part.body).toBe('234');
    expect(part.headers['content-range']).toBe('bytes 2-4/10');
    expect(
      (await call('GET', `/artifacts/${a.id}/content`, { headers: { range: 'bytes=50-' } }))
        .statusCode,
    ).toBe(416);
    const cached = await call('GET', `/artifacts/${a.id}/content`, {
      headers: { 'if-none-match': `"${a.sha256}"` },
    });
    expect(cached.statusCode).toBe(304);
  });

  it('sandboxes content a browser would run as a page', async () => {
    const run = await newRun();
    const page = await put(run.id, 'page.html', '<script>alert(1)</script>', {
      mediaType: 'text/html',
    });
    const res = await call('GET', `/artifacts/${page.id}/content`);
    expect(res.headers['content-security-policy']).toBe('sandbox');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    const text = await put(run.id, 'plain.txt', 'x');
    expect(
      (await call('GET', `/artifacts/${text.id}/content`)).headers['content-security-policy'],
    ).toBeUndefined();
  });

  it('walks the version chain', async () => {
    const run = await newRun();
    const v1 = await put(run.id, 'spec.txt', 'one');
    const v2 = await put(run.id, 'spec.txt', 'two', { supersedes: v1.id });
    const versions = (await call('GET', `/artifacts/${v2.id}/versions`)).json() as {
      items: { id: string; version: number }[];
    };
    expect(versions.items.map((v) => v.version)).toEqual([1, 2]);
    expect(versions.items.map((v) => v.id)).toEqual([v1.id, v2.id]);
    expect((await call('GET', '/artifacts/art_missing/versions')).statusCode).toBe(404);
  });
});

describe('packs, definitions, backends and fleet', () => {
  it('reads packs', async () => {
    const list = (await call('GET', '/packs?tag=demo')).json() as { items: { id: string }[] };
    expect(list.items.map((p) => p.id)).toEqual([DEMO_PACK.id]);
    expect(((await call('GET', '/packs?q=zzz')).json() as { items: [] }).items).toEqual([]);
    expect(((await call('GET', '/packs?status=available')).json() as { items: [] }).items).toEqual(
      [],
    );
    expect((await call('GET', `/packs/${DEMO_PACK.id}`)).statusCode).toBe(200);
    expect((await call('GET', `/packs/${DEMO_PACK.id}/manifest`)).statusCode).toBe(200);
    expect((await call('GET', `/packs/${DEMO_PACK.id}/inputs-schema`)).statusCode).toBe(200);
    expect((await call('GET', '/packs/pack_missing')).statusCode).toBe(404);
    const run = await newRun('pack runs');
    const runs = (await call('GET', `/packs/${DEMO_PACK.id}/runs?limit=200`)).json() as {
      items: Run[];
    };
    expect(runs.items.map((r) => r.id)).toContain(run.id);
  });

  it('reads definitions and backends', async () => {
    const defs = (await call('GET', '/agent-definitions?role=author')).json() as {
      items: { id: string }[];
    };
    expect(defs.items.map((d) => d.id)).toEqual(['author/default']);
    expect(
      ((await call('GET', '/agent-definitions?capability=nothing')).json() as { items: [] }).items,
    ).toEqual([]);
    // An id with a slash arrives encoded in one path segment.
    expect((await call('GET', '/agent-definitions/author%2Fdefault')).statusCode).toBe(200);
    expect((await call('GET', '/agent-definitions/nope%2Fnope')).statusCode).toBe(404);
    const backends = (await call('GET', '/backends')).json() as { items: { id: string }[] };
    expect(backends.items.map((b) => b.id)).toContain('a2a-demo');
    expect((await call('GET', '/backends/a2a-demo')).statusCode).toBe(200);
    expect((await call('GET', '/backends/nope')).statusCode).toBe(404);
  });

  it('matches agents, reports capacity and lists agents', async () => {
    const match = (
      await call('POST', '/agents/match', { body: { capabilities: ['author'] } })
    ).json() as {
      candidates: { definition: { id: string }; score: number }[];
    };
    expect(match.candidates.map((c) => c.definition.id)).toEqual(['author/default']);
    const preferred = (
      await call('POST', '/agents/match', {
        body: { capabilities: ['author'], backend: 'a2a-demo' },
      })
    ).json() as { candidates: { score: number }[] };
    expect(preferred.candidates[0]!.score).toBe(2);
    const none = (
      await call('POST', '/agents/match', { body: { capabilities: ['nope'] } })
    ).json() as {
      candidates: unknown[];
    };
    expect(none.candidates).toEqual([]);

    const capacity = (await call('GET', '/fleet/capacity')).json() as {
      used: number;
      backends: { wrapper: string; costToday: number | null }[];
    };
    expect(capacity.used).toBe(0);
    expect(capacity.backends.find((b) => b.wrapper === 'a2a-demo')?.costToday).toBeNull();

    const agents = (await call('GET', '/agents')).json() as { items: unknown[] };
    expect(agents.items).toEqual([]);
    expect((await call('GET', '/agents?status=asleep')).statusCode).toBe(422);
    expect((await call('GET', '/agents/agt_missing')).statusCode).toBe(404);
    expect((await call('DELETE', '/agents/agt_missing')).statusCode).toBe(404);
  });

  it('keeps answering 501 for what is not built yet', async () => {
    const run = await newRun();
    expect((await call('POST', `/runs/${run.id}/fork`)).statusCode).toBe(501);
    expect(
      (await call('POST', '/agents', { body: { definitionId: 'author/default' } })).statusCode,
    ).toBe(501);
  });
});

describe('coverage of the work routes', () => {
  // What M5.2 leaves to later tasks: installing packs (M9), the agent playground, and the families that are not "work"
  // (memory M8, schedules M11, governance M5.5 and later). Everything else in Cut 1 has a handler.
  const later = new Set([
    'previewPack',
    'installPack',
    'spawnAgent',
    'getAgentCard',
    'sendAgentMessage',
    'streamAgentMessage',
  ]);
  const work = new Set([
    'Runs',
    'Workspaces',
    'Artifacts',
    'Decisions',
    'Packs',
    'Agent definitions',
    'Projects',
    'Backends',
    'Fleet',
  ]);

  it('has a handler for every Cut 1 route of the work families', () => {
    const have = new Set(
      Object.keys({
        ...workHandlers({ autoStart: false }),
        ...workspaceHandlers(),
        ...artifactHandlers(),
        ...catalogHandlers(),
      }),
    );
    // Events are served by the stream handlers (M5.3).
    const missing = ROUTES.filter(
      (r) =>
        r.cut1 &&
        work.has(r.tag) &&
        !r.stream &&
        !later.has(r.operationId) &&
        !have.has(r.operationId),
    ).map((r) => r.operationId);
    expect(missing).toEqual([]);
  });
});
