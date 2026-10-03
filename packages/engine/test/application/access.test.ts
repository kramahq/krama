import type { Project } from '@kramahq/contract';
import { describe, expect, it } from 'vitest';
import type { AgentRef, GatewayEvent } from '../../src/index.js';
import { priya, setup } from './helpers.js';

const agent: AgentRef = {
  id: 'agt_1',
  url: 'http://127.0.0.1:1',
  role: 'author',
  backend: 'a2a-copilot',
};

const askFor = (path: string, mode: 'read' | 'write' = 'read'): GatewayEvent[] => [
  { kind: 'state', state: 'working', taskId: 't1', contextId: 'ctx_1' },
  {
    kind: 'state',
    state: 'input_required',
    taskId: 't1',
    contextId: 'ctx_1',
    text: `May I ${mode} ${path}?`,
    request: { type: 'access', path, mode },
  },
];
const finish: GatewayEvent[] = [
  {
    kind: 'artifact',
    name: 'response',
    mediaType: 'text/plain',
    bytes: new TextEncoder().encode('done'),
  },
  { kind: 'state', state: 'completed', taskId: 't1', contextId: 'ctx_1' },
];

const started = async (projectId?: string) => {
  const h = setup();
  const run = await h.engine.runs.create(
    { packId: 'pack_demo', input: {}, ...(projectId ? { projectId: projectId as never } : {}) },
    priya,
  );
  await h.engine.runs.plan(run.id);
  return { h, run };
};
const pendingAccess = async (h: ReturnType<typeof setup>, runId: string) => {
  for (let i = 0; i < 200; i++) {
    const d = (await h.p.store.decisions.list({ runId, status: ['pending'], kind: ['access'] }))
      .items[0]?.value.decision;
    if (d) return d;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('no access decision appeared');
};

describe('an agent asking for a path outside its workspace', () => {
  it('raises an access Decision, waits for a person, then lets the same delegation carry on', async () => {
    const { h, run } = await started();
    h.p.gateway.queue('author', askFor('~/Downloads/spec.pdf'), finish);
    const delegating = h.engine.steps.delegate({
      runId: run.id,
      phaseId: 'draft',
      agent,
      text: 'Build from the spec',
    });

    const d = await pendingAccess(h, run.id);
    expect(d).toMatchObject({
      kind: 'access',
      title: 'author asks to read ~/Downloads/spec.pdf',
      access: { path: '~/Downloads/spec.pdf', agent: 'author', mode: 'read' },
    });
    expect(d.options.map((o) => o.id)).toEqual(['allow_once', 'allow_project', 'deny']);
    // While waiting: the run waits and the step shows it needs input. The orchestrator is not asked anything.
    expect((await h.p.store.runs.get(run.id))!.value.run.status).toBe('awaiting_decision');
    expect((await h.p.store.steps.listByRun(run.id))[0]!.status).toBe('input_required');

    await h.engine.decisions.resolve(d.id, { optionId: 'allow_once' }, priya);
    const r = await delegating;
    expect(r).toMatchObject({ status: 'completed', answer: 'done' });
    expect(r.question).toBeUndefined();
    expect(h.p.gateway.sent).toHaveLength(2);
    expect(h.p.gateway.sent[1]).toMatchObject({ contextId: 'ctx_1' });
    expect(h.p.gateway.sent[1]!.text).toBe(
      'Access to ~/Downloads/spec.pdf was granted once. Continue.',
    );
    expect((await h.p.store.runs.get(run.id))!.value.run.status).toBe('running');
    expect(h.p.executor.signals.at(-1)).toMatchObject({ effect: 'grant_once' });
    expect(
      (await h.p.store.audit.list({ action: 'access.granted' })).items[0]?.detail,
    ).toMatchObject({ path: '~/Downloads/spec.pdf', scope: 'once' });
  });

  it('a denial tells the agent to carry on without the file', async () => {
    const { h, run } = await started();
    h.p.gateway.queue('author', askFor('/etc/hosts', 'write'), finish);
    const delegating = h.engine.steps.delegate({
      runId: run.id,
      phaseId: 'draft',
      agent,
      text: 'x',
    });
    await h.engine.decisions.resolve(
      (await pendingAccess(h, run.id)).id,
      { optionId: 'deny' },
      priya,
    );
    expect((await delegating).status).toBe('completed');
    expect(h.p.gateway.sent[1]!.text).toContain('was denied');
    expect((await h.p.store.audit.list({ action: 'access.denied' })).items).toHaveLength(1);
  });

  it('"allow for project" is remembered: the same path (and anything under it) is not asked again in that project', async () => {
    const project = { id: 'proj_1', name: 'p', createdAt: 't', links: {} } as unknown as Project;
    const { h, run } = await started('proj_1');
    await h.p.store.projects.put(project);
    h.p.gateway.queue('author', askFor('/data/specs'), finish);
    const first = h.engine.steps.delegate({ runId: run.id, phaseId: 'draft', agent, text: 'one' });
    await h.engine.decisions.resolve(
      (await pendingAccess(h, run.id)).id,
      { optionId: 'allow_project' },
      priya,
    );
    await first;

    // Same path, a later step: no decision is raised; the agent is simply told it is allowed.
    h.p.gateway.queue('author', askFor('/data/specs/q3/report.pdf'), finish);
    const second = await h.engine.steps.delegate({
      runId: run.id,
      phaseId: 'draft',
      agent,
      text: 'two',
    });
    expect(second.status).toBe('completed');
    expect(
      (await h.p.store.decisions.list({ runId: run.id, kind: ['access'] })).items,
    ).toHaveLength(1);
    expect(h.p.gateway.sent.at(-1)!.text).toContain('granted for this project');

    // A path outside the granted directory still asks.
    h.p.gateway.queue('author', askFor('/data/specs-private/x'), finish);
    const third = h.engine.steps.delegate({
      runId: run.id,
      phaseId: 'draft',
      agent,
      text: 'three',
    });
    await h.engine.decisions.resolve(
      (await pendingAccess(h, run.id)).id,
      { optionId: 'deny' },
      priya,
    );
    await third;

    // Another project does not inherit the grant.
    const other = await h.engine.runs.create(
      { packId: 'pack_demo', input: {}, projectId: 'proj_2' as never },
      priya,
    );
    await h.engine.runs.plan(other.id);
    h.p.gateway.queue('author', askFor('/data/specs'), finish);
    const fourth = h.engine.steps.delegate({
      runId: other.id,
      phaseId: 'draft',
      agent,
      text: 'four',
    });
    await h.engine.decisions.resolve(
      (await pendingAccess(h, other.id)).id,
      { optionId: 'deny' },
      priya,
    );
    await fourth;
  });

  it('ends the step as canceled when the run is stopped while access is being decided', async () => {
    const { h, run } = await started();
    h.p.gateway.queue('author', askFor('~/Downloads/x.pdf'));
    const delegating = h.engine.steps.delegate({
      runId: run.id,
      phaseId: 'draft',
      agent,
      text: 'x',
    });
    await pendingAccess(h, run.id);
    await h.engine.runs.stop(run.id, priya);
    const r = await delegating;
    expect(r).toMatchObject({ status: 'canceled', error: expect.stringContaining('run ended') });
    expect(
      (await h.p.store.decisions.list({ runId: run.id, status: ['pending'] })).items,
    ).toHaveLength(0);
  });

  it('a plain question (no permission request) is still returned to the orchestrator, not turned into an access decision', async () => {
    const { h, run } = await started();
    h.p.gateway.queue('author', [
      { kind: 'state', state: 'working', taskId: 't' },
      { kind: 'state', state: 'input_required', taskId: 't', text: 'OAuth or API keys?' },
    ]);
    const r = await h.engine.steps.delegate({ runId: run.id, phaseId: 'draft', agent, text: 'x' });
    expect(r).toMatchObject({ status: 'input_required', question: 'OAuth or API keys?' });
    expect((await h.p.store.decisions.list({ runId: run.id })).items).toHaveLength(0);
  });
});
