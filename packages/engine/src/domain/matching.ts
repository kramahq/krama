import type { AgentDefinition } from '@kramahq/contract';

export interface MatchRequest {
  /** Restrict to a role (e.g. "developer"). */
  role?: string;
  /** Tags the agent must offer. More coverage ranks higher; zero coverage is excluded when capabilities are given. */
  capabilities?: string[];
  /** Preferred backend id; an exact match ranks above other backends. */
  backend?: string;
  /** Exclude definitions whose cost hint is above this (USD per million tokens). Unknown cost is kept. */
  maxCostPerMTok?: number;
}

export interface Candidate {
  definition: AgentDefinition;
  /** Fraction of requested capabilities covered (1 when none were requested). */
  coverage: number;
  backendMatch: boolean;
  /** USD per million tokens when the definition declares it. */
  costPerMTok: number | undefined;
  reasons: string[];
}

const cost = (d: AgentDefinition): number | undefined => d.costHint?.perMillionTokens?.amount;

/**
 * Ranks usable agent definitions for a request: capability coverage first, then backend preference,
 * then cost hint (cheaper first, unknown last), then id so the result is deterministic.
 * `usable` lets the caller drop definitions whose backend is unregistered, disallowed or cannot do the job.
 */
export function matchDefinitions(
  defs: readonly AgentDefinition[],
  req: MatchRequest,
  usable: (d: AgentDefinition) => boolean = () => true,
): Candidate[] {
  const want = [...new Set(req.capabilities ?? [])];
  const out: Candidate[] = [];
  for (const d of defs) {
    if (req.role && d.role !== req.role) continue;
    if (!usable(d)) continue;
    const hit = want.filter((c) => d.capabilities.includes(c));
    if (want.length > 0 && hit.length === 0) continue;
    const c = cost(d);
    if (req.maxCostPerMTok !== undefined && c !== undefined && c > req.maxCostPerMTok) continue;
    const backendMatch = req.backend !== undefined && d.backend.wrapper === req.backend;
    out.push({
      definition: d,
      coverage: want.length ? hit.length / want.length : 1,
      backendMatch,
      costPerMTok: c,
      reasons: [
        ...hit.map((x) => `capability:${x}`),
        ...(backendMatch ? [`backend:${req.backend}`] : []),
        ...(c !== undefined ? [`cost:${c}`] : []),
      ],
    });
  }
  return out.sort(
    (a, b) =>
      b.coverage - a.coverage ||
      Number(b.backendMatch) - Number(a.backendMatch) ||
      (a.costPerMTok ?? Number.POSITIVE_INFINITY) - (b.costPerMTok ?? Number.POSITIVE_INFINITY) ||
      a.definition.id.localeCompare(b.definition.id),
  );
}
