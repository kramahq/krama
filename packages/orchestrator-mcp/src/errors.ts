import { DomainError, VersionConflictError } from '@kramahq/engine';

export interface ToolErrorBody {
  code: string;
  /** Contract problem code (HTTP-style) for the same condition. */
  problemCode?: string;
  message: string;
  details?: Record<string, unknown>;
}

/** Typed errors: the orchestrator can branch on `code`; nothing internal (stacks, paths) leaks. */
export function toToolError(e: unknown): ToolErrorBody {
  if (e instanceof DomainError)
    return {
      code: e.code,
      problemCode: e.problemCode,
      message: e.message,
      ...(e.details ? { details: e.details } : {}),
    };
  if (e instanceof VersionConflictError)
    return {
      code: 'conflict',
      problemCode: 'precondition_failed',
      message: 'The resource changed while you were working; read it again and retry.',
    };
  if (e instanceof ScopeError)
    return { code: e.code, problemCode: 'forbidden', message: e.message };
  return {
    code: 'internal',
    message: 'The platform failed to complete the call. It has been logged.',
  };
}

/** The caller asked for something outside its scoped run. */
export class ScopeError extends Error {
  constructor(
    readonly code: 'out_of_scope' | 'invalid_argument',
    message: string,
  ) {
    super(message);
    this.name = 'ScopeError';
  }
}
