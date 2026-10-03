import type { PhaseStatus } from '@kramahq/contract';
import { DomainError } from './errors.js';

export type PhaseTrigger =
  | 'start'
  | 'await_decision'
  | 'approve'
  | 'revise'
  | 'complete'
  | 'fail'
  | 'skip'
  | 'loop'
  | 'restart'
  | 'reopen';

type Table = Record<PhaseStatus, Partial<Record<PhaseTrigger, PhaseStatus>>>;

/** Phase: pending → active → (awaiting_decision) → completed | failed | skipped, with looping when an evaluator rejects. */
const TABLE: Table = {
  pending: { start: 'active', skip: 'skipped' },
  active: {
    await_decision: 'awaiting_decision',
    complete: 'completed',
    fail: 'failed',
    loop: 'looping',
    skip: 'skipped',
  },
  awaiting_decision: { approve: 'completed', revise: 'active', fail: 'failed' },
  looping: { restart: 'active', fail: 'failed' },
  // `reopen`: an evaluator in a later phase sent work back to this (already completed) producer phase.
  completed: { reopen: 'active' },
  failed: {},
  skipped: {},
};

export const transitionPhase = (from: PhaseStatus, trigger: PhaseTrigger): PhaseStatus => {
  const to = TABLE[from][trigger];
  if (!to)
    throw new DomainError('invalid_transition', `Phase cannot ${trigger} while ${from}`, {
      from,
      trigger,
    });
  return to;
};

/** Iteration increments whenever a phase re-enters `active` from a revision or a loop. */
export const nextIteration = (
  from: PhaseStatus,
  trigger: PhaseTrigger,
  iteration: number,
): number =>
  trigger === 'start'
    ? Math.max(iteration, 0) + 1
    : (from === 'awaiting_decision' && trigger === 'revise') ||
        (from === 'looping' && trigger === 'restart') ||
        trigger === 'reopen'
      ? iteration + 1
      : iteration;
