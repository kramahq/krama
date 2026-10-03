import type { ProblemCode } from '@kramahq/contract';

export type DomainErrorCode =
  | 'invalid_transition'
  | 'decision_resolved'
  | 'invalid_option'
  | 'input_required'
  | 'already_approved'
  | 'gate_required'
  | 'loop_cap_reached'
  | 'budget_exceeded'
  | 'backend_not_allowed'
  | 'unknown_phase';

/** Contract problem code a domain error maps to at the API edge. */
const PROBLEM: Record<DomainErrorCode, ProblemCode> = {
  invalid_transition: 'conflict',
  decision_resolved: 'decision_resolved',
  invalid_option: 'validation_failed',
  input_required: 'validation_failed',
  already_approved: 'conflict',
  gate_required: 'conflict',
  loop_cap_reached: 'conflict',
  budget_exceeded: 'budget_policy',
  backend_not_allowed: 'forbidden',
  unknown_phase: 'not_found',
};

/** A rule of the platform was violated. Never thrown for ordinary outcomes (those are return values). */
export class DomainError extends Error {
  constructor(
    readonly code: DomainErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'DomainError';
  }
  get problemCode(): ProblemCode {
    return PROBLEM[this.code];
  }
}
