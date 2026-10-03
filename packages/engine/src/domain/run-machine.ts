import type { RunStatus } from '@kramahq/contract';
import { DomainError } from './errors.js';

export type RunTrigger =
  | 'plan_ok'
  | 'pause'
  | 'resume'
  | 'await_decision'
  | 'decision_resolved'
  | 'block'
  | 'unblock'
  | 'complete'
  | 'fail'
  | 'stop'
  | 'interrupt'
  | 'recover';

type Table = Record<RunStatus, Partial<Record<RunTrigger, RunStatus>>>;

/** Run state machine (contract section 15). */
const TABLE: Table = {
  planning: {
    plan_ok: 'running',
    pause: 'paused',
    fail: 'failed',
    stop: 'stopped',
    interrupt: 'interrupted',
  },
  running: {
    pause: 'paused',
    await_decision: 'awaiting_decision',
    block: 'blocked',
    complete: 'completed',
    fail: 'failed',
    stop: 'stopped',
    interrupt: 'interrupted',
  },
  paused: { resume: 'running', stop: 'stopped', interrupt: 'interrupted' },
  awaiting_decision: {
    decision_resolved: 'running',
    pause: 'paused',
    block: 'blocked',
    fail: 'failed',
    stop: 'stopped',
    interrupt: 'interrupted',
  },
  blocked: {
    unblock: 'running',
    resume: 'running',
    fail: 'failed',
    stop: 'stopped',
    interrupt: 'interrupted',
  },
  interrupted: { recover: 'running', resume: 'running', stop: 'stopped' },
  completed: {},
  failed: {},
  stopped: {},
};

export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = ['completed', 'failed', 'stopped'];
export const isTerminalRun = (s: RunStatus): boolean => TERMINAL_RUN_STATUSES.includes(s);

export const canTransitionRun = (from: RunStatus, trigger: RunTrigger): boolean =>
  TABLE[from][trigger] !== undefined;

export function transitionRun(from: RunStatus, trigger: RunTrigger): RunStatus {
  const to = TABLE[from][trigger];
  if (!to)
    throw new DomainError('invalid_transition', `Run cannot ${trigger} while ${from}`, {
      from,
      trigger,
    });
  return to;
}
