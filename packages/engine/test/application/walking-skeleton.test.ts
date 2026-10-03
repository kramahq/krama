import { describe, expect, it } from 'vitest';
import { DomainError } from '../../src/index.js';
import { arjun, authorReviewerPack, loop, ok, priya, setup, types } from './helpers.js';

const phase = async (h: ReturnType<typeof setup>, runId: string, id: string) =>
  (await h.p.store.runs.get(runId))!.value.run.phases!.find((p) => p.id === id)!;

describe('a full run on fakes only: plan → gate → resolve → complete', () => {
  it('completes a run through a loop and one human gate', async () => {
    const h = setup();
    const { runs, decisions } = h.engine;

    const run = await runs.create(
      { packId: 'pack_demo', input: { text: 'Write the release notes' } },
      priya,
    );
    expect(run.status).toBe('planning');
    expect(run.phases?.map((p) => p.status)).toEqual(['pending', 'pending']);

    const planned = await runs.plan(run.id);
    expect(planned.status).toBe('running');
    expect(planned.currentPhaseIds).toEqual(['draft']);

    await runs.recordPhaseOutcome(run.id, 'draft', ok);
    expect((await phase(h, run.id, 'review')).status).toBe('active');

    // Reviewer sends it back once: draft is reopened (iteration 2), review waits.
    await runs.recordPhaseOutcome(run.id, 'review', loop('add a summary'));
    expect((await phase(h, run.id, 'draft')).status).toBe('active');
    expect((await phase(h, run.id, 'draft')).iteration).toBe(2);
    expect((await phase(h, run.id, 'review')).status).toBe('looping');

    await runs.recordPhaseOutcome(run.id, 'draft', ok);
    expect((await phase(h, run.id, 'review')).status).toBe('active');
    expect((await phase(h, run.id, 'review')).iteration).toBe(2);

    // Reviewer accepts: the methodology's gate blocks the run until a person decides.
    const gated = await runs.recordPhaseOutcome(run.id, 'review', ok);
    expect(gated.status).toBe('awaiting_decision');
    expect(gated.pendingDecisions).toBe(1);
    const pending = (await h.p.store.decisions.list({ runId: run.id, status: ['pending'] })).items;
    expect(pending).toHaveLength(1);
    const dec = pending[0]!.value.decision;
    expect(dec.title).toBe('Publish approval');
    expect(h.p.notifier.sent.map((e) => e.type)).toContain('decision.requested');

    await decisions.resolve(dec.id, { optionId: 'approve' }, priya);
    const done = (await h.p.store.runs.get(run.id))!.value.run;
    expect(done.status).toBe('completed');
    expect(done.pendingDecisions).toBe(0);
    expect(done.phases?.every((p) => p.status === 'completed')).toBe(true);
    expect(done.endedAt).toBeDefined();

    // The executor was told, and the event log tells the whole story in order.
    expect(h.p.executor.signals.map((s) => s.effect)).toEqual(['advance']);
    const t = await types(h.p, run.id);
    for (const expected of [
      'run.created',
      'run.planned',
      'phase.started',
      'phase.looped',
      'decision.requested',
      'decision.resolved',
      'phase.completed',
      'run.completed',
    ]) {
      expect(t).toContain(expected);
    }
    expect(t.indexOf('run.created')).toBeLessThan(t.indexOf('run.completed'));
  });

  it('a required gate cannot be skipped by recording the phase as complete another way', async () => {
    const h = setup();
    const run = await h.engine.runs.create({ packId: 'pack_demo', input: {} }, priya);
    await h.engine.runs.plan(run.id);
    await h.engine.runs.recordPhaseOutcome(run.id, 'draft', ok);
    await h.engine.runs.recordPhaseOutcome(run.id, 'review', ok);
    // The review phase is awaiting its gate: it cannot be re-recorded, and the run cannot finish.
    await expect(h.engine.runs.recordPhaseOutcome(run.id, 'review', ok)).rejects.toThrow(
      DomainError,
    );
    expect((await h.p.store.runs.get(run.id))!.value.run.status).toBe('awaiting_decision');
  });

  it('rejecting the gate stops the run and still notifies the executor', async () => {
    const h = setup();
    const run = await h.engine.runs.create({ packId: 'pack_demo', input: {} }, priya);
    await h.engine.runs.plan(run.id);
    await h.engine.runs.recordPhaseOutcome(run.id, 'draft', ok);
    await h.engine.runs.recordPhaseOutcome(run.id, 'review', ok);
    const dec = (await h.p.store.decisions.list({ runId: run.id, status: ['pending'] })).items[0]!
      .value.decision;
    await h.engine.decisions.resolve(dec.id, { optionId: 'reject', input: 'not now' }, priya);
    const r = (await h.p.store.runs.get(run.id))!.value.run;
    expect(r.status).toBe('stopped');
    expect(h.p.executor.signals).toHaveLength(1);
    expect(h.p.executor.signals[0]?.effect).toBe('halt');
  });

  it('a resolved decision is final: the second resolve fails and changes nothing', async () => {
    const h = setup();
    const run = await h.engine.runs.create({ packId: 'pack_demo', input: {} }, priya);
    await h.engine.runs.plan(run.id);
    await h.engine.runs.recordPhaseOutcome(run.id, 'draft', ok);
    await h.engine.runs.recordPhaseOutcome(run.id, 'review', ok);
    const dec = (await h.p.store.decisions.list({ runId: run.id, status: ['pending'] })).items[0]!
      .value.decision;
    await h.engine.decisions.resolve(dec.id, { optionId: 'approve' }, priya);
    await expect(
      h.engine.decisions.resolve(dec.id, { optionId: 'reject' }, arjun),
    ).rejects.toMatchObject({ code: 'decision_resolved' });
    expect((await h.p.store.runs.get(run.id))!.value.run.status).toBe('completed');
    expect(h.p.executor.signals).toHaveLength(1);
  });
});

describe('evaluator loop cap (engine-enforced)', () => {
  it('halts the run as blocked when the automated cap is exceeded', async () => {
    const h = setup();
    const { runs } = h.engine;
    const run = await runs.create({ packId: 'pack_demo', input: {} }, priya);
    await runs.plan(run.id);
    for (let i = 0; i < 2; i++) {
      await runs.recordPhaseOutcome(run.id, 'draft', ok);
      await runs.recordPhaseOutcome(run.id, 'review', loop());
    }
    await runs.recordPhaseOutcome(run.id, 'draft', ok);
    const blocked = await runs.recordPhaseOutcome(run.id, 'review', loop());
    expect(blocked.status).toBe('blocked');
    expect(blocked.statusReason).toContain('Maximum feedback loop iterations exceeded');
    expect((await phase(h, run.id, 'review')).status).toBe('failed');
  });

  it('human-requested changes at a review gate never count towards the cap', async () => {
    const pack = authorReviewerPack({
      gates: [
        { afterPhase: 'review', kind: 'review', policy: 'human_required', label: 'Editor review' },
      ],
    });
    const h = setup(pack);
    const { runs, decisions } = h.engine;
    const run = await runs.create({ packId: 'pack_demo', input: {} }, priya);
    await runs.plan(run.id);
    await runs.recordPhaseOutcome(run.id, 'draft', ok);
    await runs.recordPhaseOutcome(run.id, 'review', ok);
    for (let i = 0; i < 4; i++) {
      const dec = (await h.p.store.decisions.list({ runId: run.id, status: ['pending'] })).items[0]!
        .value.decision;
      await decisions.resolve(dec.id, { optionId: 'changes', input: `round ${i}` }, priya);
      expect((await phase(h, run.id, 'review')).status).toBe('active');
      await runs.recordPhaseOutcome(run.id, 'review', ok);
    }
    expect((await phase(h, run.id, 'review')).iteration).toBe(5);
    expect((await h.p.store.runs.get(run.id))!.value.run.status).toBe('awaiting_decision');
  });
});

describe('multi-approver gates', () => {
  it('needs `need` distinct approvers and keeps the run waiting until the last', async () => {
    const pack = authorReviewerPack({
      gates: [
        {
          afterPhase: 'review',
          kind: 'approval',
          policy: 'human_required',
          label: 'Two-person rule',
          need: 2,
        },
      ],
    });
    const h = setup(pack);
    const run = await h.engine.runs.create({ packId: 'pack_demo', input: {} }, priya);
    await h.engine.runs.plan(run.id);
    await h.engine.runs.recordPhaseOutcome(run.id, 'draft', ok);
    await h.engine.runs.recordPhaseOutcome(run.id, 'review', ok);
    const dec = (await h.p.store.decisions.list({ runId: run.id, status: ['pending'] })).items[0]!
      .value.decision;
    expect(dec.need).toBe(2);
    const first = await h.engine.decisions.resolve(dec.id, { optionId: 'approve' }, priya);
    expect(first.status).toBe('pending');
    expect((await h.p.store.runs.get(run.id))!.value.run.status).toBe('awaiting_decision');
    await expect(
      h.engine.decisions.resolve(dec.id, { optionId: 'approve' }, priya),
    ).rejects.toMatchObject({ code: 'already_approved' });
    const second = await h.engine.decisions.resolve(dec.id, { optionId: 'approve' }, arjun);
    expect(second.status).toBe('resolved');
    expect((await h.p.store.runs.get(run.id))!.value.run.status).toBe('completed');
  });
});

describe('autopilot', () => {
  it('waives review gates but still stops at approval gates', async () => {
    const pack = authorReviewerPack({
      gates: [
        { afterPhase: 'draft', kind: 'review', policy: 'human_required', label: 'Editor review' },
        {
          afterPhase: 'review',
          kind: 'approval',
          policy: 'human_required',
          label: 'Publish approval',
        },
      ],
    });
    const h = setup(pack);
    const run = await h.engine.runs.create(
      { packId: 'pack_demo', input: {}, mode: 'autopilot' },
      priya,
    );
    await h.engine.runs.plan(run.id);
    await h.engine.runs.recordPhaseOutcome(run.id, 'draft', ok);
    expect((await phase(h, run.id, 'review')).status).toBe('active');
    const gated = await h.engine.runs.recordPhaseOutcome(run.id, 'review', ok);
    expect(gated.status).toBe('awaiting_decision');
  });

  it('"approve and switch to autopilot" flips the mode for later review gates', async () => {
    const pack = authorReviewerPack({
      gates: [
        { afterPhase: 'draft', kind: 'review', policy: 'human_required', label: 'Editor review' },
        { afterPhase: 'review', kind: 'review', policy: 'human_required', label: 'Final review' },
      ],
    });
    const h = setup(pack);
    const run = await h.engine.runs.create({ packId: 'pack_demo', input: {} }, priya);
    await h.engine.runs.plan(run.id);
    await h.engine.runs.recordPhaseOutcome(run.id, 'draft', ok);
    const dec = (await h.p.store.decisions.list({ runId: run.id, status: ['pending'] })).items[0]!
      .value.decision;
    await h.engine.decisions.resolve(dec.id, { optionId: 'autopilot' }, priya);
    const finish = await h.engine.runs.recordPhaseOutcome(run.id, 'review', ok);
    expect(finish.mode).toBe('autopilot');
    expect(finish.status).toBe('completed');
  });
});

describe('run controls and recovery', () => {
  it('follows the state machine and rejects illegal moves', async () => {
    const h = setup();
    const run = await h.engine.runs.create({ packId: 'pack_demo', input: {} }, priya);
    await h.engine.runs.plan(run.id);
    expect((await h.engine.runs.pause(run.id, priya)).status).toBe('paused');
    await expect(h.engine.runs.pause(run.id, priya)).rejects.toMatchObject({
      code: 'invalid_transition',
    });
    expect((await h.engine.runs.resume(run.id, priya)).status).toBe('running');
    expect((await h.engine.runs.stop(run.id, priya, 'enough')).status).toBe('stopped');
    await expect(h.engine.runs.resume(run.id, priya)).rejects.toMatchObject({
      code: 'invalid_transition',
    });
  });

  it('stopping cancels pending decisions', async () => {
    const h = setup();
    const run = await h.engine.runs.create({ packId: 'pack_demo', input: {} }, priya);
    await h.engine.runs.plan(run.id);
    await h.engine.runs.recordPhaseOutcome(run.id, 'draft', ok);
    await h.engine.runs.recordPhaseOutcome(run.id, 'review', ok);
    await h.engine.runs.stop(run.id, priya);
    expect(
      (await h.p.store.decisions.list({ runId: run.id, status: ['pending'] })).items,
    ).toHaveLength(0);
    expect(
      (await h.p.store.decisions.list({ runId: run.id, status: ['canceled'] })).items,
    ).toHaveLength(1);
  });

  it('marks running runs interrupted on restart, then recovers them with durable state intact', async () => {
    const h = setup();
    const run = await h.engine.runs.create({ packId: 'pack_demo', input: {} }, priya);
    await h.engine.runs.plan(run.id);
    await h.engine.runs.recordPhaseOutcome(run.id, 'draft', ok);
    expect(await h.engine.runs.markInterrupted()).toEqual([run.id]);
    expect((await h.p.store.runs.get(run.id))!.value.run.status).toBe('interrupted');
    const resumed = await h.engine.runs.resume(run.id, priya);
    expect(resumed.status).toBe('running');
    expect((await phase(h, run.id, 'draft')).status).toBe('completed');
    expect((await phase(h, run.id, 'review')).status).toBe('active');
  });

  it('is idempotent per key and validates the pack and backend policy', async () => {
    const h = setup(undefined, { allowedBackends: ['a2a-claude'] });
    const a = await h.engine.runs.create({ packId: 'pack_demo', input: {} }, priya, {
      idempotencyKey: 'k',
    });
    const b = await h.engine.runs.create({ packId: 'pack_demo', input: {} }, priya, {
      idempotencyKey: 'k',
    });
    expect(b.id).toBe(a.id);
    await expect(
      h.engine.runs.create({ packId: 'pack_nope', input: {} }, priya),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      h.engine.runs.create(
        { packId: 'pack_demo', input: {}, orchestrator: { backend: 'a2a-codex' } },
        priya,
      ),
    ).rejects.toMatchObject({ code: 'backend_not_allowed' });
  });
});
