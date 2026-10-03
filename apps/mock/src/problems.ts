import { PROBLEM_CODES, type Problem, type ProblemCode } from '@kramahq/contract';

/** Thrown by handlers; the error handler renders it as `application/problem+json`. */
export class ProblemError extends Error {
  readonly problem: Problem;
  constructor(
    code: ProblemCode | 'not_implemented',
    title: string,
    detail?: string,
    errors?: Problem['errors'],
  ) {
    super(title);
    const status = code === 'not_implemented' ? 501 : PROBLEM_CODES[code];
    this.problem = {
      type: `https://kramahq.dev/problems/${code}`,
      title,
      status,
      code,
      ...(detail ? { detail } : {}),
      ...(errors ? { errors } : {}),
    };
  }
}

export const notFound = (what: string, id: string) =>
  new ProblemError('not_found', `${what} not found`, `No ${what} with id ${id}`);
