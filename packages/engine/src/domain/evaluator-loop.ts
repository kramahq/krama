import type { PhaseOutcome } from '@kramahq/contract';

/** Loop iterations per `from→to` pair. Only automated loops count; a human asking for changes does not. */
export type LoopCounts = ReadonlyMap<string, number>;

export const pairKey = (from: string, to: string): string => `${from}→${to}`;

export type LoopVerdict =
  | { action: 'accept' }
  | { action: 'revise'; target: string; iteration: number; feedback?: string }
  | { action: 'skip_downstream' }
  | { action: 'halt'; reason: string };

export interface LoopStep {
  verdict: LoopVerdict;
  counts: LoopCounts;
}

export interface LoopInput {
  phaseId: string;
  outcome: Pick<PhaseOutcome, 'gating' | 'loopTarget' | 'feedback' | 'reason'>;
  /** Engine-enforced cap (`EvaluatorRule.maxLoops`). */
  maxLoops: number;
  /** True when a person requested the re-run: always allowed and never counted against the cap. */
  human?: boolean;
}

/**
 * Generic produce → evaluate → revise primitive. Given an evaluator's gating decision,
 * decides whether to accept, send the producer back, skip downstream phases, or halt.
 * The cap is enforced here, never left to the orchestrator.
 */
export function evaluate(counts: LoopCounts, input: LoopInput): LoopStep {
  const { phaseId, outcome, maxLoops, human } = input;
  switch (outcome.gating) {
    case 'continue':
      return { verdict: { action: 'accept' }, counts };
    case 'skip_downstream':
      return { verdict: { action: 'skip_downstream' }, counts };
    case 'halt':
      return { verdict: { action: 'halt', reason: outcome.reason }, counts };
    case 'loop_back': {
      const target = outcome.loopTarget ?? phaseId;
      const key = pairKey(phaseId, target);
      const feedback = outcome.feedback ?? outcome.reason;
      if (human) {
        return {
          verdict: { action: 'revise', target, iteration: (counts.get(key) ?? 0) + 1, feedback },
          counts,
        };
      }
      const next = (counts.get(key) ?? 0) + 1;
      if (next > maxLoops) {
        return {
          verdict: {
            action: 'halt',
            reason: `Maximum feedback loop iterations exceeded for ${key}`,
          },
          counts,
        };
      }
      const updated = new Map(counts);
      updated.set(key, next);
      return { verdict: { action: 'revise', target, iteration: next, feedback }, counts: updated };
    }
  }
}
