import type { PhaseStatus, RunStatus } from '@kramahq/contract';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  DomainError,
  canTransitionRun,
  isTerminalRun,
  nextIteration,
  transitionPhase,
  transitionRun,
  type PhaseTrigger,
  type RunTrigger,
} from '../../src/index.js';

const RUN_TRIGGERS: RunTrigger[] = [
  'plan_ok',
  'pause',
  'resume',
  'await_decision',
  'decision_resolved',
  'block',
  'unblock',
  'complete',
  'fail',
  'stop',
  'interrupt',
  'recover',
];
const PHASE_TRIGGERS: PhaseTrigger[] = [
  'start',
  'await_decision',
  'approve',
  'revise',
  'complete',
  'fail',
  'skip',
  'loop',
  'restart',
];
const trigger = fc.constantFrom(...RUN_TRIGGERS);

describe('run state machine', () => {
  it('terminal runs accept no trigger', () => {
    for (const s of ['completed', 'failed', 'stopped'] as RunStatus[]) {
      expect(isTerminalRun(s)).toBe(true);
      for (const t of RUN_TRIGGERS) expect(canTransitionRun(s, t)).toBe(false);
    }
  });

  it('a random walk only visits valid statuses and never leaves a terminal status', () => {
    fc.assert(
      fc.property(fc.array(trigger, { maxLength: 60 }), (triggers) => {
        let s: RunStatus = 'planning';
        for (const t of triggers) {
          if (isTerminalRun(s)) {
            expect(() => transitionRun(s, t)).toThrow(DomainError);
            continue;
          }
          if (canTransitionRun(s, t)) s = transitionRun(s, t);
          else expect(() => transitionRun(s, t)).toThrow(DomainError);
        }
        expect([
          'planning',
          'running',
          'paused',
          'awaiting_decision',
          'blocked',
          'completed',
          'failed',
          'stopped',
          'interrupted',
        ]).toContain(s);
      }),
    );
  });

  it('a run waiting on a decision cannot complete until it is resolved', () => {
    expect(canTransitionRun('awaiting_decision', 'complete')).toBe(false);
    expect(transitionRun(transitionRun('running', 'await_decision'), 'decision_resolved')).toBe(
      'running',
    );
  });

  it('an interrupted run can be recovered', () => {
    expect(transitionRun('interrupted', 'recover')).toBe('running');
  });
});

describe('phase state machine', () => {
  it('failed and skipped phases are final; completed ones only reopen for an evaluator loop', () => {
    for (const s of ['failed', 'skipped'] as PhaseStatus[]) {
      for (const t of PHASE_TRIGGERS) expect(() => transitionPhase(s, t)).toThrow(DomainError);
    }
    for (const t of PHASE_TRIGGERS.filter((x) => x !== 'reopen'))
      expect(() => transitionPhase('completed', t)).toThrow(DomainError);
    expect(transitionPhase('completed', 'reopen')).toBe('active');
    expect(nextIteration('completed', 'reopen', 1)).toBe(2);
  });

  it('a gate approval completes, a revision re-enters active with a higher iteration', () => {
    expect(transitionPhase('awaiting_decision', 'approve')).toBe('completed');
    expect(transitionPhase('awaiting_decision', 'revise')).toBe('active');
    expect(nextIteration('pending', 'start', 0)).toBe(1);
    expect(nextIteration('awaiting_decision', 'revise', 1)).toBe(2);
    expect(nextIteration('looping', 'restart', 2)).toBe(3);
    expect(nextIteration('active', 'complete', 2)).toBe(2);
  });

  it('a phase cannot complete without having started', () => {
    expect(() => transitionPhase('pending', 'complete')).toThrow(DomainError);
  });
});
