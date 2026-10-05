import type { AgentRef } from '@kramahq/engine';

/** One entry of an a2a-wrapper `subAgents.agents[]` list. */
export interface SubAgentEntry {
  name: string;
  agentCardUrl: string;
  auth?:
    | { mode: 'none' }
    | { mode: 'bearer'; token: string }
    | { mode: 'api_key'; [k: string]: unknown };
}

/** The wrapper's shared `subAgents` config section. The wrapper turns it into the reserved `a2a-subagents` MCP entry (a2a-mcp-skillmap). */
export interface SubAgentsConfig {
  agents: SubAgentEntry[];
  options: { responseMode: 'artifact' | 'message'; probeTimeoutMs: number; syncBudgetMs: number };
}

export interface SubAgentsOptions {
  /** How long skillmap waits for an agent card at startup. Default 5 s. */
  probeTimeoutMs?: number;
  /** How long a call blocks before skillmap returns a task handle to poll. Default 30 s. */
  syncBudgetMs?: number;
}

/** Roles become tool prefixes, so keep them to a safe alphabet. */
export const subAgentName = (role: string): string =>
  role.toLowerCase().replace(/[^a-z0-9_-]+/g, '-');

/**
 * The orchestrator's `subAgents` section, generated from the run's resolved roster: one entry per local worker,
 * pointing at that worker's agent card. The orchestrator can only reach agents that are listed here, which is how
 * the allowed-agents rule holds in `native` mode without a handler to check it.
 */
export function buildSubAgents(
  workers: readonly AgentRef[],
  o: SubAgentsOptions = {},
): SubAgentsConfig {
  return {
    agents: workers.map((w) => ({
      name: subAgentName(w.role),
      agentCardUrl: `${w.url.replace(/\/$/, '')}/.well-known/agent-card.json`,
      auth: { mode: 'none' as const },
    })),
    options: {
      responseMode: 'artifact',
      probeTimeoutMs: o.probeTimeoutMs ?? 5_000,
      syncBudgetMs: o.syncBudgetMs ?? 30_000,
    },
  };
}
