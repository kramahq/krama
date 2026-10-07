import { PROBLEM_CODES, type Problem } from '@kramahq/contract';
import { DomainError, VersionConflictError } from '@kramahq/engine';
import { z } from 'zod';

export const PROBLEM_TYPE_BASE = 'https://kramahq.dev/problems/';

/** Codes this server raises beyond the contract's table (still RFC 7807 `Problem`s with a stable `code`). */
const EXTRA_CODES = {
  not_implemented: 501,
  payload_too_large: 413,
  precondition_required: 428,
  internal: 500,
} as const;

export type ProblemCode = keyof typeof PROBLEM_CODES | keyof typeof EXTRA_CODES;

const STATUS: Record<string, number> = { ...PROBLEM_CODES, ...EXTRA_CODES };

const TITLES: Record<string, string> = {
  validation_failed: 'Validation failed',
  not_found: 'Not found',
  forbidden: 'Forbidden',
  unauthenticated: 'Authentication required',
  conflict: 'Conflict',
  precondition_failed: 'Precondition failed',
  precondition_required: 'Precondition required',
  rate_limited: 'Too many requests',
  gone: 'Gone',
  not_implemented: 'Not implemented',
  payload_too_large: 'Payload too large',
  internal: 'Internal error',
};

/** An error that is rendered as `application/problem+json`. */
export class ApiProblem extends Error {
  readonly problem: Problem;
  readonly headers: Record<string, string>;

  constructor(
    code: ProblemCode,
    detail?: string,
    o: {
      title?: string;
      errors?: Problem['errors'];
      headers?: Record<string, string>;
      traceId?: string;
    } = {},
  ) {
    const title = o.title ?? TITLES[code] ?? code;
    super(detail ?? title);
    this.name = 'ApiProblem';
    this.headers = o.headers ?? {};
    this.problem = {
      type: `${PROBLEM_TYPE_BASE}${code}`,
      title,
      status: STATUS[code]!,
      code,
      ...(detail ? { detail } : {}),
      ...(o.errors ? { errors: o.errors } : {}),
      ...(o.traceId ? { traceId: o.traceId } : {}),
    };
  }
}

export const notFound = (what: string, id?: string) =>
  new ApiProblem('not_found', id ? `${what} ${id} does not exist` : `${what} does not exist`);

/** A zod failure as a 422 with per-field errors. */
export function validationProblem(where: 'query' | 'body', e: z.ZodError): ApiProblem {
  return new ApiProblem('validation_failed', `The ${where} is not valid`, {
    errors: e.issues.map((i) => ({
      field: i.path.length ? i.path.join('.') : where,
      message: i.message,
    })),
  });
}

/** Any thrown value as a problem; unexpected errors never leak their message. */
export function toProblem(err: unknown, traceId: string): ApiProblem {
  if (err instanceof ApiProblem) return err;
  if (err instanceof z.ZodError) return validationProblem('body', err);
  // A rule of the platform, raised by the engine: it already names the contract code it maps to.
  if (err instanceof DomainError) return new ApiProblem(err.problemCode, err.message, { traceId });
  if (err instanceof VersionConflictError)
    return new ApiProblem(
      'precondition_failed',
      'The resource changed since you read it; fetch it again and retry',
    );
  const e = err as { statusCode?: number; code?: string; message?: string };
  // Fastify's own errors (bad JSON, body too large, unsupported media type...).
  if (typeof e.statusCode === 'number' && e.statusCode >= 400 && e.statusCode < 500) {
    if (e.statusCode === 413)
      return new ApiProblem('payload_too_large', 'The request body is too large');
    if (e.statusCode === 404) return new ApiProblem('not_found');
    return new ApiProblem('validation_failed', e.message ?? 'Bad request', {
      title: 'Bad request',
    });
  }
  return new ApiProblem('internal', undefined, { traceId });
}
