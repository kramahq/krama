import type { Problem } from '@kramahq/contract';

/** An error response from the API (RFC 9457 problem+json), or a failure to reach it. */
export class ApiError extends Error {
  constructor(
    message: string,
    /** HTTP status; 0 when the server could not be reached. */
    readonly status: number,
    readonly problem?: Problem,
  ) {
    super(message);
    this.name = 'ApiError';
  }
  get code(): string {
    return this.problem?.code ?? (this.status === 0 ? 'unreachable' : 'error');
  }
  get traceId(): string | undefined {
    return this.problem?.traceId;
  }
}
