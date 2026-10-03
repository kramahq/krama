import type { Decision, MemoryRecord } from '@kramahq/contract';
import { describe, expect, it } from 'vitest';
import { ok, priya, setup } from './helpers.js';

const started = async (budget?: number, policy = {}) => {
  const h = setup(undefined, policy);
  const run = await h.engine.runs.create(
    { packId: 'pack_demo', input: {}, ...(budget ? { budget: { max: budget } } : {}) },
    priya,
  );
  await h.engine.runs.plan(run.id);
  return { h, run };
};
const stored = async (h: Awaited<ReturnType<typeof started>>['h'], id: string) =>
  (await h.p.store.runs.get(id))!.value;
const pendingOf = async (h: Awaited<ReturnType<typeof started>>['h'], runId: string) =>
  (await h.p.store.decisions.list({ runId, status: ['pending'] })).items.map(
    (i) => i.value.decision,
  );

describe('budget cap', () => {
  it('accumulates provider-reported cost per run and phase, and keeps null as "not reported"', async () => {
    const { h, run } = await started(10);
    await h.engine.budget.record({
      runId: run.id,
      phaseId: 'draft',
      cost: null,
      usage: [{ unit: 'tokens', quantity: 100 }],
    });
    expect((await stored(h, run.id)).run.budget.spent).toBeNull();
    await h.engine.budget.record({
      runId: run.id,
      phaseId: 'draft',
      cost: { amount: 2.5, currency: 'USD' },
    });
    await h.engine.budget.record({ runId: run.id, phaseId: 'draft', cost: null });
    const r = (await stored(h, run.id)).run;
    expect(r.budget.spent?.amount).toBe(2.5);
    expect(r.phases?.find((p) => p.id === 'draft')?.cost?.amount).toBe(2.5);
    expect(await h.p.store.usage.forRun(run.id)).toHaveLength(3);
  });

  it('warns once at the threshold', async () => {
    const { h, run } = await started(10);
    await h.engine.budget.record({ runId: run.id, cost: { amount: 8, currency: 'USD' } });
    await h.engine.budget.record({ runId: run.id, cost: { amount: 0.5, currency: 'USD' } });
    const warns = (await h.p.events.read({ topics: [`run:${run.id}`] })).filter(
      (e) => e.type === 'budget.threshold',
    );
    expect(warns).toHaveLength(1);
  });

  it('pauses behind a budget decision when the cap is reached, and raising the cap resumes', async () => {
    const { h, run } = await started(10);
    await h.engine.budget.record({ runId: run.id, cost: { amount: 10, currency: 'USD' } });
    expect((await stored(h, run.id)).run.status).toBe('awaiting_decision');
    const [dec] = await pendingOf(h, run.id);
    expect(dec?.kind).toBe('budget');
    await h.engine.decisions.resolve(dec!.id, { optionId: 'raise', input: '25' }, priya);
    const r = (await stored(h, run.id)).run;
    expect(r.status).toBe('running');
    expect(r.budget.max.amount).toBe(25);
    expect(h.p.executor.signals.at(-1)?.effect).toBe('raise_cap');
  });

  it('raises by the default factor when no number is given', async () => {
    const { h, run } = await started(10);
    await h.engine.budget.record({ runId: run.id, cost: { amount: 11, currency: 'USD' } });
    await h.engine.decisions.resolve(
      (await pendingOf(h, run.id))[0]!.id,
      { optionId: 'raise' },
      priya,
    );
    expect((await stored(h, run.id)).run.budget.max.amount).toBe(15);
  });

  it('stops the run when onExceed is stop, and when a person chooses to stop', async () => {
    const { h, run } = await started(10);
    await h.engine.budget.record({ runId: run.id, cost: { amount: 10, currency: 'USD' } });
    await h.engine.decisions.resolve(
      (await pendingOf(h, run.id))[0]!.id,
      { optionId: 'stop' },
      priya,
    );
    expect((await stored(h, run.id)).run.status).toBe('stopped');

    const { h: h2, run: r2 } = await started(10);
    const rec = (await h2.p.store.runs.get(r2.id))!;
    rec.value.run.budget.onExceed = 'stop';
    await h2.p.store.runs.put(rec.value, rec.version);
    await h2.engine.budget.record({ runId: r2.id, cost: { amount: 12, currency: 'USD' } });
    const s = (await stored(h2, r2.id)).run;
    expect(s.status).toBe('stopped');
    expect(s.statusReason).toBe('Budget cap reached');
  });

  it('"continue without a cap" waives enforcement for that run only', async () => {
    const { h, run } = await started(10);
    await h.engine.budget.record({ runId: run.id, cost: { amount: 10, currency: 'USD' } });
    await h.engine.decisions.resolve(
      (await pendingOf(h, run.id))[0]!.id,
      { optionId: 'cap' },
      priya,
    );
    await h.engine.budget.record({ runId: run.id, cost: { amount: 50, currency: 'USD' } });
    const r = await stored(h, run.id);
    expect(r.run.status).toBe('running');
    expect(r.capWaived).toBe(true);
  });

  it('cannot enforce on unreported spend', async () => {
    const { h, run } = await started(0.01);
    await h.engine.budget.record({
      runId: run.id,
      cost: null,
      usage: [{ unit: 'tokens', quantity: 9_999_999 }],
    });
    expect((await stored(h, run.id)).run.status).toBe('running');
  });

  it('updates step cost and usage per unit', async () => {
    const { h, run } = await started(100);
    await h.p.store.steps.put({
      id: 'step_1',
      runId: run.id,
      phaseId: 'draft',
      agent: { id: 'agt_1', role: 'author', backend: 'b' },
      summary: 's',
      status: 'working',
      a2a: { resumed: false },
    } as never);
    await h.engine.budget.record({
      runId: run.id,
      phaseId: 'draft',
      stepId: 'step_1',
      cost: { amount: 1, currency: 'USD' },
      usage: [{ unit: 'tokens', quantity: 10 }],
    });
    await h.engine.budget.record({
      runId: run.id,
      phaseId: 'draft',
      stepId: 'step_1',
      cost: { amount: 2, currency: 'USD' },
      usage: [{ unit: 'tokens', quantity: 5 }],
    });
    const s = (await h.p.store.steps.get('step_1'))!.value;
    expect(s.cost?.amount).toBe(3);
    expect(s.usage).toEqual([{ unit: 'tokens', quantity: 15 }]);
  });
});

describe('other decision kinds', () => {
  const req = (
    h: Awaited<ReturnType<typeof started>>['h'],
    over: Partial<Decision> & Pick<Decision, 'kind' | 'options'>,
  ) =>
    h.engine.decisions.request({
      decision: {
        id: h.p.ids.next('dec'),
        title: 't',
        question: 'q',
        createdAt: h.p.clock.now().toISOString(),
        links: {},
        ...over,
      } as never,
    });

  it('an access request pauses the run until allowed, and is audited', async () => {
    const { h, run } = await started();
    const d = await req(h, {
      kind: 'access',
      runId: run.id,
      access: { path: '~/Downloads/spec.pdf', agent: 'developer-2' },
      options: [
        { id: 'allow_once', label: 'Once', style: 'primary' },
        { id: 'allow_project', label: 'Project', style: 'neutral' },
        { id: 'deny', label: 'Deny', style: 'danger' },
      ],
    });
    expect((await stored(h, run.id)).run.status).toBe('awaiting_decision');
    await h.engine.decisions.resolve(d.id, { optionId: 'allow_project' }, priya);
    expect((await stored(h, run.id)).run.status).toBe('running');
    const audit = await h.p.store.audit.list({ action: 'access.granted' });
    expect(audit.items[0]?.detail).toEqual({
      path: '~/Downloads/spec.pdf',
      agent: 'developer-2',
      scope: 'project',
    });
    expect(h.p.executor.signals.at(-1)?.effect).toBe('grant_project');
  });

  it('denying access resumes the run so the agent can continue without the file', async () => {
    const { h, run } = await started();
    const d = await req(h, {
      kind: 'access',
      runId: run.id,
      access: { path: '/x', agent: 'a' },
      options: [{ id: 'deny', label: 'Deny', style: 'danger' }],
    });
    await h.engine.decisions.resolve(d.id, { optionId: 'deny' }, priya);
    expect((await stored(h, run.id)).run.status).toBe('running');
    expect((await h.p.store.audit.list({ action: 'access.denied' })).items).toHaveLength(1);
  });

  it('an input decision carries the answer back and un-blocks the waiting step', async () => {
    const { h, run } = await started();
    await h.p.store.steps.put({
      id: 'step_2',
      runId: run.id,
      phaseId: 'draft',
      agent: { id: 'agt_2', role: 'author', backend: 'b' },
      summary: 's',
      status: 'input_required',
      a2a: { resumed: false },
    } as never);
    const d = await req(h, {
      kind: 'input',
      runId: run.id,
      phaseId: 'draft',
      options: [
        { id: 'oauth', label: 'OAuth', style: 'primary' },
        { id: 'keys', label: 'Keys', style: 'neutral' },
      ],
    });
    await h.engine.decisions.resolve(d.id, { optionId: 'oauth' }, priya);
    expect((await h.p.store.steps.get('step_2'))!.value.status).toBe('working');
    expect(h.p.executor.signals.at(-1)).toMatchObject({ effect: 'answer', optionId: 'oauth' });
  });

  it('two blocking decisions keep the run waiting until both are resolved', async () => {
    const { h, run } = await started();
    const mk = () =>
      req(h, {
        kind: 'input',
        runId: run.id,
        options: [{ id: 'a', label: 'A', style: 'primary' }],
      });
    const [d1, d2] = [await mk(), await mk()];
    expect((await stored(h, run.id)).run.pendingDecisions).toBe(2);
    await h.engine.decisions.resolve(d1.id, { optionId: 'a' }, priya);
    expect((await stored(h, run.id)).run.status).toBe('awaiting_decision');
    await h.engine.decisions.resolve(d2.id, { optionId: 'a' }, priya);
    expect((await stored(h, run.id)).run.status).toBe('running');
  });

  it('options the engine cannot implement are refused up front', async () => {
    const { h, run } = await started();
    await expect(
      req(h, {
        kind: 'approval',
        runId: run.id,
        options: [{ id: 'yolo', label: 'YOLO', style: 'primary' }],
      }),
    ).rejects.toMatchObject({ code: 'invalid_option' });
  });

  it('memory proposals activate or reject the record; untrusted content stays as proposed until a person decides', async () => {
    const { h } = await started();
    const rec = {
      id: 'mem_1',
      scope: { type: 'project', id: 'proj_1' },
      type: 'semantic',
      content: 'c',
      tags: [],
      status: 'proposed',
      trust: 'untrusted',
      confidence: { initial: 0.5, current: 0.5 },
      provenance: { method: 'agent_inference' },
      contentHash: 'h',
      version: 1,
      access: { read: [], write: [] },
      createdAt: 't',
      updatedAt: 't',
      links: {},
    } as MemoryRecord;
    await h.p.memory.put(rec);
    const accept = await req(h, {
      kind: 'memory',
      subject: { type: 'memory', id: 'mem_1' },
      options: [
        { id: 'accept', label: 'Accept', style: 'primary' },
        { id: 'reject', label: 'Reject', style: 'neutral' },
      ],
    });
    expect((await h.p.memory.get('mem_1'))!.value.status).toBe('proposed');
    await h.engine.decisions.resolve(accept.id, { optionId: 'accept' }, priya);
    expect((await h.p.memory.get('mem_1'))!.value.status).toBe('active');
    expect((await h.p.events.read({ topics: ['memory'] })).map((e) => e.type)).toEqual([
      'memory.accepted',
    ]);
  });

  it('expires a decision past its deadline and blocks the run; auto_approve resolves it instead', async () => {
    const { h, run } = await started();
    const soon = new Date(h.p.clock.now().getTime() + 1000).toISOString();
    const d = await req(h, {
      kind: 'input',
      runId: run.id,
      deadline: soon,
      onTimeout: 'expire',
      options: [{ id: 'a', label: 'A', style: 'primary' }],
    });
    expect(await h.engine.decisions.sweepExpired()).toEqual([]);
    h.p.clock.advance(5000);
    expect(await h.engine.decisions.sweepExpired()).toEqual([d.id]);
    expect((await h.p.store.decisions.get(d.id))!.value.decision.status).toBe('expired');
    const r = (await stored(h, run.id)).run;
    expect(r.status).toBe('blocked');
    expect(r.statusReason).toContain('Decision expired');

    const { h: h2, run: r2 } = await started();
    const d2 = await req(h2, {
      kind: 'approval',
      runId: r2.id,
      deadline: soon,
      onTimeout: 'auto_approve',
      options: [{ id: 'approve', label: 'Approve', style: 'primary' }],
    });
    h2.p.clock.advance(5000);
    await h2.engine.decisions.sweepExpired();
    expect((await h2.p.store.decisions.get(d2.id))!.value.decision.status).toBe('resolved');
  });

  it('consent and publish decisions settle without touching a run, and the executor is told about every kind of resolution', async () => {
    const { h } = await started();
    const consent = await req(h, {
      kind: 'consent',
      subject: { type: 'pack', id: 'pack_x' },
      options: [
        { id: 'approve', label: 'Install', style: 'primary' },
        { id: 'decline', label: 'Decline', style: 'danger' },
      ],
    });
    const publish = await req(h, {
      kind: 'publish',
      subject: { type: 'draft', id: 'draft_1' },
      options: [
        { id: 'approve', label: 'Publish', style: 'primary' },
        { id: 'reject', label: 'Reject', style: 'danger' },
      ],
    });
    expect(
      (await h.engine.decisions.resolve(consent.id, { optionId: 'approve' }, priya)).status,
    ).toBe('resolved');
    expect(
      (await h.engine.decisions.resolve(publish.id, { optionId: 'reject' }, priya)).resolution
        ?.optionId,
    ).toBe('reject');
    expect(
      (await h.p.events.read({ topics: ['inbox'] })).filter((e) => e.type === 'decision.resolved'),
    ).toHaveLength(2);
  });

  it('rejecting a memory proposal marks the record rejected', async () => {
    const { h } = await started();
    const rec = {
      id: 'mem_9',
      scope: { type: 'project', id: 'p' },
      type: 'semantic',
      content: 'c',
      tags: [],
      status: 'proposed',
      trust: 'trusted',
      confidence: { initial: 1, current: 1 },
      provenance: { method: 'human' },
      contentHash: 'h',
      version: 1,
      access: { read: [], write: [] },
      createdAt: 't',
      updatedAt: 't',
      links: {},
    } as MemoryRecord;
    await h.p.memory.put(rec);
    const d = await req(h, {
      kind: 'memory',
      subject: { type: 'memory', id: 'mem_9' },
      options: [
        { id: 'accept', label: 'Accept', style: 'primary' },
        { id: 'reject', label: 'Reject', style: 'neutral' },
      ],
    });
    await h.engine.decisions.resolve(d.id, { optionId: 'reject' }, priya);
    expect((await h.p.memory.get('mem_9'))!.value.status).toBe('rejected');
    expect((await h.p.events.read({ topics: ['memory'] })).map((e) => e.type)).toEqual([
      'memory.rejected',
    ]);
  });

  it('unknown decision and option ids are reported, not swallowed', async () => {
    const { h, run } = await started();
    await expect(
      h.engine.decisions.resolve('dec_nope', { optionId: 'x' }, priya),
    ).rejects.toMatchObject({ code: 'not_found' });
    const d = await req(h, {
      kind: 'input',
      runId: run.id,
      options: [{ id: 'a', label: 'A', style: 'primary' }],
    });
    await expect(
      h.engine.decisions.resolve(d.id, { optionId: 'zzz' }, priya),
    ).rejects.toMatchObject({ code: 'invalid_option' });
    expect(ok.status).toBe('success');
  });
});
