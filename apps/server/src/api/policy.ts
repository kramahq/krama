import { readFileSync } from 'node:fs';
import { delegationMode, type DelegationMode } from '@kramahq/contract';
import type { Policy } from '@kramahq/engine';
import { z } from 'zod';

const backendId = z.string().regex(/^[a-z][a-z0-9-]*$/);

/** The platform policy file (`policy.json`): what the operator allows, whatever a pack or a run asks for. */
export const policyFile = z
  .object({
    /** Used only when the pack names no orchestrator. */
    defaultOrchestrator: z
      .object({ definitionId: z.string(), backend: backendId, model: z.string().optional() })
      .optional(),
    /** Empty or absent = every installed backend. */
    allowedBackends: z.array(backendId).optional(),
    delegation: z
      .object({
        mode: delegationMode.optional(),
        /** Route worker calls through Krama's A2A proxy (M4.7). */
        proxy: z.enum(['on', 'off']).optional(),
      })
      .strict()
      .optional(),
    /** Hosts external agents and webhooks may point at. Absent = none beyond loopback. */
    externalHosts: z.array(z.string().min(1)).optional(),
    defaultMaxLoops: z.number().int().min(0).optional(),
    defaultBudgetUsd: z.number().positive().optional(),
    raiseFactor: z.number().gt(1).optional(),
  })
  .strict();
export type PolicyFile = z.infer<typeof policyFile>;

/** What the server enforces: the engine's policy plus the parts only the server needs. */
export interface ServerPolicy {
  engine: Policy;
  delegation: { mode: DelegationMode; proxy: 'on' | 'off' };
  externalHosts: readonly string[];
}

export class PolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PolicyError';
  }
}

/** Reads and validates a policy file. A missing path means "no file"; a bad file is an error, never ignored. */
export function readPolicyFile(path: string): PolicyFile {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    throw new PolicyError(`Cannot read the policy file ${path}: ${(e as Error).message}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    throw new PolicyError(`The policy file ${path} is not valid JSON: ${(e as Error).message}`);
  }
  const r = policyFile.safeParse(json);
  if (!r.success)
    throw new PolicyError(
      `The policy file ${path} is not valid: ` +
        r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '),
    );
  return r.data;
}

const csv = (v: string | undefined): string[] | undefined =>
  v === undefined
    ? undefined
    : v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

/** Policy overrides from the environment (`KRAMA_*`). Invalid values are errors. */
export function policyFromEnv(env: NodeJS.ProcessEnv): PolicyFile {
  const out: Record<string, unknown> = {};
  const allowed = csv(env['KRAMA_ALLOWED_BACKENDS']);
  if (allowed) out['allowedBackends'] = allowed;
  const hosts = csv(env['KRAMA_EXTERNAL_HOSTS']);
  if (hosts) out['externalHosts'] = hosts;
  const delegation: Record<string, unknown> = {};
  if (env['KRAMA_DELEGATION_MODE']) delegation['mode'] = env['KRAMA_DELEGATION_MODE'];
  if (env['KRAMA_DELEGATION_PROXY']) delegation['proxy'] = env['KRAMA_DELEGATION_PROXY'];
  if (Object.keys(delegation).length) out['delegation'] = delegation;
  if (env['KRAMA_DEFAULT_BUDGET_USD'])
    out['defaultBudgetUsd'] = Number(env['KRAMA_DEFAULT_BUDGET_USD']);
  if (env['KRAMA_DEFAULT_MAX_LOOPS'])
    out['defaultMaxLoops'] = Number(env['KRAMA_DEFAULT_MAX_LOOPS']);
  const r = policyFile.safeParse(out);
  if (!r.success)
    throw new PolicyError(
      'Invalid policy in the environment: ' +
        r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    );
  return r.data;
}

/**
 * Layers policy sources, later ones winning per key: built-in defaults, the policy file, the environment, the
 * command line. A list replaces the earlier list; it is not merged.
 */
export function resolvePolicy(...layers: (PolicyFile | undefined)[]): ServerPolicy {
  const m: PolicyFile = {};
  const delegation: NonNullable<PolicyFile['delegation']> = {};
  for (const l of layers) {
    if (!l) continue;
    const { delegation: d, ...rest } = l;
    for (const [k, v] of Object.entries(rest))
      if (v !== undefined) (m as Record<string, unknown>)[k] = v;
    if (d?.mode) delegation.mode = d.mode;
    if (d?.proxy) delegation.proxy = d.proxy;
  }
  const engine: Policy = {
    ...(m.allowedBackends?.length ? { allowedBackends: m.allowedBackends } : {}),
    ...(m.defaultOrchestrator ? { defaultOrchestrator: m.defaultOrchestrator } : {}),
    ...(m.defaultMaxLoops !== undefined ? { defaultMaxLoops: m.defaultMaxLoops } : {}),
    ...(m.defaultBudgetUsd !== undefined ? { defaultBudgetUsd: m.defaultBudgetUsd } : {}),
    ...(m.raiseFactor !== undefined ? { raiseFactor: m.raiseFactor } : {}),
    defaultDelegation: delegation.mode ?? 'native',
  };
  return {
    engine,
    delegation: { mode: engine.defaultDelegation!, proxy: delegation.proxy ?? 'off' },
    externalHosts: m.externalHosts ?? [],
  };
}
