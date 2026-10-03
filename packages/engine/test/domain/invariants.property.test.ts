import type { GateRule, Methodology, Run } from '@kramahq/contract';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  DomainError,
  assertBackendAllowed,
  assertCanAdvance,
  assertWithinBudget,
  budgetAction,
  budgetStatus,
  evaluate,
  gateRequired,
  requiredGatesAfter,
  type GateContext,
  type LoopCounts,
} from '../../src/index.js';

const usd = (amount: number) => ({ amount, currency: 'USD' as const });
const budget = (max: number, spent: number | null, onExceed: 'pause' | 'stop'): Run['budget'] => ({
  max: usd(max),
  spent: spent === null ? null : usd(spent),
  warnAtPct: 80,
  onExceed,
});

describe('budget cap', () => {
  it('halts (per onExceed) as soon as reported spend reaches the cap, never before', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1000 }),
        fc.integer({ min: 0, max: 2000 }),
        fc.constantFrom('pause', 'stop' as const),
        (max, spent, onExceed) => {
          const action = budgetAction(budget(max, spent, onExceed));
          if (spent >= max) expect(action).toBe(onExceed);
          else expect(['none', 'warn']).toContain(action);
        },
      ),
    );
  });

  it('warns at the threshold', () => {
    expect(budgetStatus(usd(100), usd(80), 80)).toBe('warn');
    expect(budgetStatus(usd(100), usd(79), 80)).toBe('ok');
  });

  it('cannot enforce on spend that is not reported', () => {
    expect(budgetStatus(usd(10), null, 80)).toBe('unknown');
    expect(budgetAction(budget(10, null, 'stop'))).toBe('none');
  });

  it('assertWithinBudget throws once exceeded', () => {
    expect(() => assertWithinBudget(budget(10, 10, 'stop'))).toThrow(DomainError);
    expect(() => assertWithinBudget(budget(10, 9.99, 'stop'))).not.toThrow();
  });
});

describe('evaluator loop cap', () => {
  const loopBack = {
    gating: 'loop_back' as const,
    loopTarget: 'dev',
    reason: 'issues',
    feedback: 'fix',
  };

  it('automated loops never exceed maxLoops, and the next one halts', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 6 }),
        fc.integer({ min: 1, max: 20 }),
        (maxLoops, attempts) => {
          let counts: LoopCounts = new Map();
          let revisions = 0;
          let halted = false;
          for (let i = 0; i < attempts && !halted; i++) {
            const step = evaluate(counts, { phaseId: 'review', outcome: loopBack, maxLoops });
            counts = step.counts;
            if (step.verdict.action === 'revise') revisions++;
            else halted = step.verdict.action === 'halt';
            expect(Math.max(0, ...counts.values())).toBeLessThanOrEqual(maxLoops);
          }
          expect(revisions).toBeLessThanOrEqual(maxLoops);
          if (attempts > maxLoops) expect(halted).toBe(true);
        },
      ),
    );
  });

  it('human-requested re-runs are never counted and never halt', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 3 }),
        fc.integer({ min: 1, max: 15 }),
        (maxLoops, n) => {
          let counts: LoopCounts = new Map();
          for (let i = 0; i < n; i++) {
            const step = evaluate(counts, {
              phaseId: 'design',
              outcome: { ...loopBack, loopTarget: 'design' },
              maxLoops,
              human: true,
            });
            counts = step.counts;
            expect(step.verdict.action).toBe('revise');
          }
          expect(counts.size).toBe(0);
        },
      ),
    );
  });

  it('counts loops per from→to pair independently', () => {
    let counts: LoopCounts = new Map();
    counts = evaluate(counts, {
      phaseId: 'qa',
      outcome: { ...loopBack, loopTarget: 'dev' },
      maxLoops: 1,
    }).counts;
    const other = evaluate(counts, {
      phaseId: 'review',
      outcome: { ...loopBack, loopTarget: 'dev' },
      maxLoops: 1,
    });
    expect(other.verdict.action).toBe('revise');
    const again = evaluate(counts, {
      phaseId: 'qa',
      outcome: { ...loopBack, loopTarget: 'dev' },
      maxLoops: 1,
    });
    expect(again.verdict.action).toBe('halt');
  });

  it('continue accepts, halt halts, skip_downstream skips', () => {
    const c: LoopCounts = new Map();
    expect(
      evaluate(c, { phaseId: 'p', outcome: { gating: 'continue', reason: 'ok' }, maxLoops: 2 })
        .verdict.action,
    ).toBe('accept');
    expect(
      evaluate(c, { phaseId: 'p', outcome: { gating: 'halt', reason: 'bad' }, maxLoops: 2 })
        .verdict,
    ).toEqual({ action: 'halt', reason: 'bad' });
    expect(
      evaluate(c, {
        phaseId: 'p',
        outcome: { gating: 'skip_downstream', reason: 'n/a' },
        maxLoops: 2,
      }).verdict.action,
    ).toBe('skip_downstream');
  });
});

describe('required gates', () => {
  const gate = fc.record({
    afterPhase: fc.constantFrom('a', 'b'),
    kind: fc.constantFrom('review', 'approval', 'budget', 'access' as const),
    policy: fc.constantFrom('human_required', 'auto', 'conditional' as const),
    label: fc.string({ minLength: 1, maxLength: 8 }),
  });
  const method = (gates: GateRule[]): Methodology => ({
    id: 'm',
    name: 'm',
    phases: [],
    gates,
    evaluators: [],
  });

  it('cannot advance unless every required gate after the phase is approved', () => {
    fc.assert(
      fc.property(
        fc.array(gate, { maxLength: 6 }),
        fc.array(fc.boolean(), { maxLength: 6 }),
        fc.constantFrom('review', 'autopilot' as const),
        (gates, approvals, mode) => {
          const unique = gates.filter((g, i) => gates.findIndex((x) => x.label === g.label) === i);
          const m = method(unique);
          const ctx: GateContext = { mode };
          const approved = new Map(unique.map((g, i) => [g.label, approvals[i] ?? false]));
          const required = requiredGatesAfter(m, 'a', ctx);
          const allApproved = required.every((g) => approved.get(g.label) === true);
          if (allApproved) expect(() => assertCanAdvance(m, 'a', ctx, approved)).not.toThrow();
          else expect(() => assertCanAdvance(m, 'a', ctx, approved)).toThrow(DomainError);
        },
      ),
    );
  });

  it('autopilot waives review gates but never approval gates', () => {
    const review: GateRule = {
      afterPhase: 'a',
      kind: 'review',
      policy: 'human_required',
      label: 'Review',
    };
    const approval: GateRule = {
      afterPhase: 'a',
      kind: 'approval',
      policy: 'human_required',
      label: 'Production',
    };
    expect(gateRequired(review, { mode: 'autopilot' })).toBe(false);
    expect(gateRequired(review, { mode: 'review' })).toBe(true);
    expect(gateRequired(approval, { mode: 'autopilot' })).toBe(true);
    expect(gateRequired({ ...approval, policy: 'auto' }, { mode: 'review' })).toBe(false);
  });

  it('conditional gates are required unless the condition says otherwise', () => {
    const g: GateRule = {
      afterPhase: 'a',
      kind: 'approval',
      policy: 'conditional',
      condition: 'cost>10',
      label: 'Costly',
    };
    expect(gateRequired(g, { mode: 'review' })).toBe(true);
    expect(gateRequired(g, { mode: 'review', conditionMet: () => false })).toBe(false);
  });
});

describe('allowed backends', () => {
  it('rejects a backend outside a non-empty allow-list', () => {
    expect(() => assertBackendAllowed('a2a-codex', ['a2a-claude'])).toThrow(DomainError);
    expect(() => assertBackendAllowed('a2a-claude', ['a2a-claude'])).not.toThrow();
    expect(() => assertBackendAllowed('anything', [])).not.toThrow();
    expect(() => assertBackendAllowed('anything', undefined)).not.toThrow();
  });
});
