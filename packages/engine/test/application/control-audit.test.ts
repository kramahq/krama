import { describe, expect, it } from 'vitest';
import { authorReviewerPack, ok, setup } from './helpers.js';

const priya = { type: 'user', id: 'u_priya', name: 'Priya', role: 'operator' } as const;
const arjun = { type: 'user', id: 'u_arjun', name: 'Arjun', role: 'approver' } as const;

describe('who did what is on the hash-chained control record (M5.5)', () => {
  it('records each command with the principal that gave it, in order, as a chain that verifies', async () => {
    const h = setup(authorReviewerPack());
    const run = await h.engine.runs.create({ packId: 'pack_demo', input: { text: 'go' } }, priya);
    await h.engine.runs.update(run.id, { title: 'Renamed' }, arjun);
    await h.engine.runs.plan(run.id);
    await h.engine.runs.recordPhaseOutcome(run.id, 'draft', ok);
    await h.engine.runs.recordPhaseOutcome(run.id, 'review', ok);
    const dec = (await h.p.store.decisions.list({ runId: run.id, status: ['pending'] })).items[0]!;
    await h.engine.decisions.resolve(dec.value.decision.id, { optionId: 'approve' }, arjun);

    const control = await h.p.ledger.read('control');
    const by = (kind: string) => control.find((r) => r.kind === kind)!;
    expect(control.map((r) => r.kind)).toEqual(['run.created', 'run.updated', 'decision.resolved']);
    expect(by('run.created')).toMatchObject({
      actor: { type: 'user', id: 'u_priya', role: 'operator' },
      runId: run.id,
      source: 'api',
      payload: { subject: { type: 'run', id: run.id }, actorName: 'Priya' },
    });
    expect(by('run.updated')).toMatchObject({
      actor: { id: 'u_arjun', role: 'approver' },
      payload: { detail: { changed: ['title'] } },
    });
    expect(by('decision.resolved')).toMatchObject({
      actor: { id: 'u_arjun', role: 'approver' },
      decisionId: dec.value.decision.id,
      payload: { detail: { optionId: 'approve' } },
    });
    expect((await h.p.ledger.verify('control')).ok).toBe(true);
  });

  it('records a control action by a person as an api action, with its reason', async () => {
    const h = setup(authorReviewerPack());
    const run = await h.engine.runs.create({ packId: 'pack_demo', input: {} }, priya);
    await h.engine.runs.plan(run.id);
    await h.engine.runs.stop(run.id, priya, 'enough');
    const stop = (await h.p.ledger.read('control')).find((r) => r.kind === 'run.stop')!;
    expect(stop).toMatchObject({ actor: { id: 'u_priya', role: 'operator' }, source: 'api' });
  });
});
