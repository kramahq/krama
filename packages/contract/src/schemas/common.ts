import { z } from 'zod';

import { API_VERSION } from '../version.js';
export const API_BASE_PATH = `/api/${API_VERSION}` as const;

/** ISO-8601 UTC timestamp. */
export const iso = z.iso.datetime();

/** Opaque prefixed id, e.g. `run_01J…`. */
export const id = <P extends string>(prefix: P) => z.templateLiteral([prefix, '_', z.string()]);

export const link = z.object({
  href: z.string(),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).optional(),
  title: z.string().optional(),
});
export type Link = z.infer<typeof link>;
export const links = z.record(z.string(), link);
export type Links = z.infer<typeof links>;

export const page = <T extends z.ZodType>(item: T) =>
  z.object({
    items: z.array(item),
    nextCursor: z.string().optional(),
    total: z.number().optional(),
  });

export const money = z.object({ amount: z.number(), currency: z.literal('USD') });
export type Money = z.infer<typeof money>;

/** Provider-reported spend. `null` means "not reported"; it is never estimated. */
export const spend = money.nullable();
export type Spend = z.infer<typeof spend>;

export const usage = z.object({
  unit: z.enum(['usd', 'tokens', 'characters', 'seconds', 'images', 'calls', 'credits']),
  quantity: z.number(),
});
export type Usage = z.infer<typeof usage>;

export const actorRef = z.object({
  type: z.enum(['user', 'agent', 'system', 'schedule', 'orchestrator']),
  id: z.string(),
  name: z.string().optional(),
});
export type ActorRef = z.infer<typeof actorRef>;

export const packRef = z.object({ id: id('pack'), version: z.string(), sha: z.string() });
export type PackRef = z.infer<typeof packRef>;

export const jsonSchema = z.record(z.string(), z.unknown());
export type JsonSchema = z.infer<typeof jsonSchema>;

export const problem = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number(),
  detail: z.string().optional(),
  code: z.string(),
  errors: z.array(z.object({ field: z.string(), message: z.string() })).optional(),
  traceId: z.string().optional(),
});
export type Problem = z.infer<typeof problem>;

export const PROBLEM_CODES = {
  validation_failed: 422,
  not_found: 404,
  forbidden: 403,
  unauthenticated: 401,
  conflict: 409,
  precondition_failed: 412,
  rate_limited: 429,
  budget_policy: 403,
  roster_unsatisfied: 409,
  decision_resolved: 409,
  pack_blocked: 403,
  engine_incompatible: 409,
  consent_incomplete: 403,
  gone: 410,
} as const;
export type ProblemCode = keyof typeof PROBLEM_CODES;
