import type { ActorRef, Decision } from '@kramahq/contract';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  DomainError,
  aggregateSpend,
  aggregateUsage,
  cancel,
  expire,
  openDecision,
  resolve,
  type DecisionRecord,
} from '../../src/index.js';

const at = '2026-10-03T10:00:00.000Z';
const user = (id: string): ActorRef => ({ type: 'user', id, name: id });
const base = { runId: 'run_1', title: 'T', question: 'Q', createdAt: at, links: {} } as const;

const review = (need = 1): DecisionRecord =>
  openDecision({
    decision: {
      ...base,
      id: 'dec_1',
      kind: 'review',
      need,
      options: [
        { id: 'approve', label: 'Approve', style: 'primary' },
        {
          id: 'changes',
          label: 'Changes',
          style: 'neutral',
          input: { required: true, label: 'Notes', kind: 'text' },
        },
        { id: 'reject', label: 'Reject', style: 'danger' },
      ],
    } as Decision,
  });

describe('decisions', () => {
  it('a settled decision is final: every later resolve, expire or cancel throws', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('approve', 'reject'),
        fc.array(fc.constantFrom('approve', 'changes', 'reject', 'nope'), {
          minLength: 1,
          maxLength: 8,
        }),
        (first, later) => {
          const r = resolve(review(), { optionId: first, by: user('u1'), at });
          expect(r.settled).toBe(true);
          for (const o of later) {
            expect(() =>
              resolve(r.record, { optionId: o, input: 'x', by: user('u2'), at }),
            ).toThrow(expect.objectContaining({ code: 'decision_resolved' }));
          }
          expect(() => expire(r.record, at)).toThrow(DomainError);
          expect(() => cancel(r.record, at)).toThrow(DomainError);
        },
      ),
    );
  });

  it('positive options need `need` distinct approvers and settle exactly at the last one', () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 6 }), (need) => {
        let rec = review(need);
        for (let i = 1; i < need; i++) {
          const r = resolve(rec, { optionId: 'approve', by: user(`u${i}`), at });
          expect(r.settled).toBe(false);
          if (!r.settled) expect(r.remaining).toBe(need - i);
          rec = r.record;
        }
        expect(() => resolve(rec, { optionId: 'approve', by: user('u1'), at })).toThrow(
          expect.objectContaining({ code: 'already_approved' }),
        );
        const last = resolve(rec, { optionId: 'approve', by: user('last'), at });
        expect(last.settled).toBe(true);
        if (last.settled) expect(last.effect).toBe('advance');
        expect(last.record.decision.status).toBe('resolved');
      }),
    );
  });

  it('a negative option settles immediately even when several approvers are needed', () => {
    const r = resolve(review(3), { optionId: 'reject', by: user('u1'), at });
    expect(r.settled).toBe(true);
    if (r.settled) expect(r.effect).toBe('halt');
  });

  it('enforces required option input and rejects unknown options', () => {
    expect(() => resolve(review(), { optionId: 'changes', by: user('u1'), at })).toThrow(
      expect.objectContaining({ code: 'input_required' }),
    );
    expect(() =>
      resolve(review(), { optionId: 'changes', input: '  ', by: user('u1'), at }),
    ).toThrow(expect.objectContaining({ code: 'input_required' }));
    expect(() => resolve(review(), { optionId: 'nope', by: user('u1'), at })).toThrow(
      expect.objectContaining({ code: 'invalid_option' }),
    );
    const ok = resolve(review(), {
      optionId: 'changes',
      input: 'tighten scope',
      by: user('u1'),
      at,
    });
    expect(ok.settled && ok.effect).toBe('loop_back');
  });

  it('only offers options the engine implements', () => {
    const custom = (effects?: Record<string, 'advance'>) =>
      openDecision({
        decision: {
          ...base,
          id: 'dec_2',
          kind: 'approval',
          options: [{ id: 'ship_it', label: 'Ship', style: 'primary' }],
        } as Decision,
        ...(effects ? { effects } : {}),
      });
    expect(() => custom()).toThrow(expect.objectContaining({ code: 'invalid_option' }));
    expect(custom({ ship_it: 'advance' }).effects.ship_it).toBe('advance');
  });

  it('input decisions map any option to an answer', () => {
    const rec = openDecision({
      decision: {
        ...base,
        id: 'dec_3',
        kind: 'input',
        options: [{ id: 'oauth', label: 'OAuth', style: 'primary' }],
      } as Decision,
    });
    const r = resolve(rec, { optionId: 'oauth', by: user('u1'), at });
    expect(r.settled && r.effect).toBe('answer');
  });

  it('access decisions grant once, for the project, or deny', () => {
    const rec = openDecision({
      decision: {
        ...base,
        id: 'dec_4',
        kind: 'access',
        options: [
          { id: 'allow_once', label: 'Once', style: 'primary' },
          { id: 'allow_project', label: 'Project', style: 'neutral' },
          { id: 'deny', label: 'Deny', style: 'danger' },
        ],
      } as Decision,
    });
    expect(rec.effects).toEqual({
      allow_once: 'grant_once',
      allow_project: 'grant_project',
      deny: 'deny',
    });
  });

  it('a pending decision can expire once', () => {
    const e = expire(review(), at);
    expect(e.decision.status).toBe('expired');
    expect(() => expire(e, at)).toThrow(DomainError);
  });
});

describe('cost aggregation (provider-reported or null)', () => {
  const spend = fc.option(
    fc.integer({ min: 0, max: 10_000 }).map((c) => ({ amount: c / 100, currency: 'USD' as const })),
    { nil: null },
  );

  it('is null only when nothing was reported, and flags a partial total', () => {
    fc.assert(
      fc.property(fc.array(spend, { maxLength: 12 }), (items) => {
        const agg = aggregateSpend(items);
        const reported = items.filter((i) => i !== null);
        if (reported.length === 0) expect(agg.total).toBeNull();
        else {
          expect(agg.total?.amount).toBeCloseTo(
            reported.reduce((a, i) => a + i!.amount, 0),
            5,
          );
          expect(agg.partial).toBe(reported.length < items.length);
        }
      }),
    );
  });

  it('is order independent', () => {
    fc.assert(
      fc.property(fc.array(spend, { maxLength: 10 }), (items) => {
        const a = aggregateSpend([...items].reverse()).total;
        const b = aggregateSpend(items).total;
        expect(a === null).toBe(b === null);
        if (a && b) expect(a.amount).toBeCloseTo(b.amount, 5);
      }),
    );
  });

  it('never mixes usage units', () => {
    const out = aggregateUsage([
      [
        { unit: 'tokens', quantity: 10 },
        { unit: 'seconds', quantity: 2 },
      ],
      [{ unit: 'tokens', quantity: 5 }],
    ]);
    expect(out).toEqual([
      { unit: 'tokens', quantity: 15 },
      { unit: 'seconds', quantity: 2 },
    ]);
  });
});
