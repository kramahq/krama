import type { Pack } from '@kramahq/contract';
import { describe, expect, it } from 'vitest';
import { authorReviewerPack, ok, priya, setup } from './helpers.js';

/** An agents-only pack: no methodology, so no phases, gates or loop rules of its own (D16). */
const agentsOnly = (): Pack => {
  const pack: Pack = structuredClone(authorReviewerPack());
  delete pack.methodology;
  delete pack.roster;
  return {
    ...pack,
    orchestrator: 'lead',
    agents: { lead: { definition: 'orchestrator/default' } },
  };
};

const start = async (mode: 'review' | 'autopilot', policy = {}) => {
  const h = setup(agentsOnly(), policy);
  const run = await h.engine.runs.create(
    { packId: 'pack_demo', input: { text: 'do it' }, mode },
    priya,
  );
  await h.engine.runs.plan(run.id);
  return { h, runId: run.id };
};
const runOf = async (h: ReturnType<typeof setup>, id: string) =>
  (await h.p.store.runs.get(id))!.value.run;
const pending = async (h: ReturnType<typeof setup>, runId: string) =>
  (await h.p.store.decisions.list({ runId, status: ['pending'] })).items.map((i) => i.value);

describe('a run without a methodology (M4.9)', () => {
  it('has one implicit phase until the orchestrator plans', async () => {
    const { h, runId } = await start('autopilot');
    const run = await runOf(h, runId);
    expect(run.phases?.map((p) => [p.id, p.status])).toEqual([['run', 'active']]);
    const done = await h.engine.runs.recordPhaseOutcome(runId, 'run', ok);
    expect(done.status).toBe('completed');
  });

  it('autopilot completes with no final approval', async () => {
    const { h, runId } = await start('autopilot');
    await h.engine.runs.recordPhaseOutcome(runId, 'run', ok);
    expect(await pending(h, runId)).toHaveLength(0);
  });

  it('review mode cannot complete without a person: it raises one final approval and waits', async () => {
    const { h, runId } = await start('review');
    const waiting = await h.engine.runs.recordPhaseOutcome(runId, 'run', ok);
    expect(waiting.status).toBe('awaiting_decision');
    expect(waiting.endedAt).toBeUndefined();
    const [dec] = await pending(h, runId);
    expect(dec!.decision).toMatchObject({ kind: 'approval', title: 'Final approval' });

    await h.engine.decisions.resolve(dec!.decision.id, { optionId: 'approve' }, priya);
    const done = await runOf(h, runId);
    expect(done.status).toBe('completed');
    expect(done.pendingDecisions).toBe(0);
    expect(done.endedAt).toBeDefined();
  });

  it('rejecting the final approval stops the run and does not complete it', async () => {
    const { h, runId } = await start('review');
    await h.engine.runs.recordPhaseOutcome(runId, 'run', ok);
    const [dec] = await pending(h, runId);
    await h.engine.decisions.resolve(dec!.decision.id, { optionId: 'reject' }, priya);
    expect((await runOf(h, runId)).status).toBe('stopped');
  });

  it('a methodology pack keeps its own gates and gets no extra final approval', async () => {
    const h = setup();
    const run = await h.engine.runs.create({ packId: 'pack_demo', input: {} }, priya);
    await h.engine.runs.plan(run.id);
    await h.engine.runs.recordPhaseOutcome(run.id, 'draft', ok);
    await h.engine.runs.recordPhaseOutcome(run.id, 'review', ok);
    const titles = (await pending(h, run.id)).map((r) => r.decision.title);
    expect(titles).toEqual(['Publish approval']);
    await h.engine.decisions.resolve(
      (await pending(h, run.id))[0]!.decision.id,
      { optionId: 'approve' },
      priya,
    );
    expect((await runOf(h, run.id)).status).toBe('completed');
  });

  it('a loop_back beyond the platform cap stops the run for a person', async () => {
    const { h, runId } = await start('autopilot', { defaultMaxLoops: 1 });
    await h.engine.runs.setPlan(runId, [
      { id: 'draft', label: 'Draft' },
      { id: 'review', label: 'Review', dependsOn: ['draft'] },
    ]);
    const back = (n: number) => ({
      status: 'partial' as const,
      reason: `round ${n}`,
      gating: 'loop_back' as const,
      loopTarget: 'draft',
      feedback: 'again',
    });
    await h.engine.runs.recordPhaseOutcome(runId, 'draft', ok);
    await h.engine.runs.recordPhaseOutcome(runId, 'review', back(1)); // within the cap
    expect((await runOf(h, runId)).status).toBe('running');
    await h.engine.runs.recordPhaseOutcome(runId, 'draft', ok);
    const stopped = await h.engine.runs.recordPhaseOutcome(runId, 'review', back(2)); // beyond it
    expect(stopped.status).toBe('blocked');
    expect(stopped.statusReason).toMatch(/loop/i);
  });
});

describe('set_plan (M4.9)', () => {
  const plan = [
    { id: 'research', label: 'Research' },
    { id: 'write', label: 'Write', dependsOn: ['research'] },
  ];

  it('replaces the implicit phase and starts what is ready', async () => {
    const { h, runId } = await start('autopilot');
    const run = await h.engine.runs.setPlan(runId, plan);
    expect(run.phases?.map((p) => [p.id, p.status])).toEqual([
      ['research', 'active'],
      ['write', 'pending'],
    ]);
    expect(run.currentPhaseIds).toEqual(['research']);
  });

  it('can be revised while running, but a started phase must stay with the same dependencies', async () => {
    const { h, runId } = await start('autopilot');
    await h.engine.runs.setPlan(runId, plan);
    await h.engine.runs.setPlan(runId, [
      ...plan,
      { id: 'publish', label: 'Publish', dependsOn: ['write'] },
    ]);
    expect((await runOf(h, runId)).phases?.map((p) => p.id)).toEqual([
      'research',
      'write',
      'publish',
    ]);
    await expect(
      h.engine.runs.setPlan(runId, [{ id: 'write', label: 'Write' }]),
    ).rejects.toMatchObject({
      code: 'invalid_option',
    });
    await expect(
      h.engine.runs.setPlan(runId, [
        { id: 'research', label: 'Research', dependsOn: ['write'] },
        { id: 'write', label: 'Write', dependsOn: ['research'] },
      ]),
    ).rejects.toMatchObject({ code: 'invalid_option' });
  });

  it('refuses a plan that is not valid, naming the field', async () => {
    const { h, runId } = await start('autopilot');
    const bad = async (p: Parameters<typeof h.engine.runs.setPlan>[1]) =>
      h.engine.runs
        .setPlan(runId, p)
        .catch((e: unknown) => e as { details?: { errors?: { field: string }[] } });
    expect(await bad([])).toMatchObject({ code: 'invalid_option' });
    expect((await bad([{ id: 'Bad Id', label: 'x' }])).details?.errors?.[0]?.field).toBe(
      'phases.0.id',
    );
    expect(
      (
        await bad([
          { id: 'a', label: 'x' },
          { id: 'a', label: 'y' },
        ])
      ).details?.errors?.[0]?.field,
    ).toBe('phases.1.id');
    expect(
      (await bad([{ id: 'a', label: 'x', dependsOn: ['nope'] }])).details?.errors?.[0]?.field,
    ).toBe('phases.0.dependsOn');
    expect(
      (await bad([{ id: 'a', label: 'x', dependsOn: ['a'] }])).details?.errors?.[0]?.field,
    ).toBe('phases.0.dependsOn');
  });

  it('is refused for a pack that declares its own phases, and for a run that is over', async () => {
    const h = setup();
    const run = await h.engine.runs.create({ packId: 'pack_demo', input: {} }, priya);
    await h.engine.runs.plan(run.id);
    await expect(h.engine.runs.setPlan(run.id, plan)).rejects.toMatchObject({
      code: 'invalid_option',
    });

    const { h: h2, runId } = await start('autopilot');
    await h2.engine.runs.recordPhaseOutcome(runId, 'run', ok);
    await expect(h2.engine.runs.setPlan(runId, plan)).rejects.toMatchObject({
      code: 'invalid_transition',
    });
  });
});
