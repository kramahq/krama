import type { AgentDefinition, Pack, PackAgent, Run } from '@kramahq/contract';
import {
  DomainError,
  resolveAgentGraph,
  type AgentGraph,
  type AgentGraphInput,
  type AgentRef,
  type Ports,
  type ResolvedRole,
  type SpawnSpec,
} from '@kramahq/engine';
import type { EventClaims } from './collector.js';
import { renderAgentsSection, type AgentLine } from './hints.js';
import type { OrchestratorMcp } from './server.js';
import {
  cardUrl,
  subAgentName,
  subAgentsConfig,
  type SubAgentEntry,
  type SubAgentsOptions,
} from './subagents.js';
import type { AgentDirectory } from './tools.js';

/** The id the orchestrator gets in a graph built from a roster. */
export const ORCHESTRATOR_ID = 'orchestrator';

/** An agent catalogue with an orchestrator: written in the pack, or derived from a roster for packs that predate the graph. */
export interface GraphPlan {
  orchestrator: string;
  agents: Record<string, PackAgent>;
  /** Per agent, a backend or model other than its definition's own (a roster that pins one). */
  overrides: Record<string, { backend?: string; model?: string }>;
}

/** The graph a pack declares, or undefined for a pack that only has a roster. */
export function planFromPack(pack: Pack): GraphPlan | undefined {
  if (!pack.agents) return undefined;
  if (!pack.orchestrator)
    throw new DomainError('invalid_graph', 'The agent graph is invalid: orchestrator: not set', {
      issues: [{ path: 'orchestrator', message: 'The pack has agents but names no orchestrator' }],
    });
  return { orchestrator: pack.orchestrator, agents: pack.agents, overrides: {} };
}

/**
 * The graph a roster implies: the orchestrator calls each rostered worker directly and the workers call nobody. Roles
 * become agent ids (and so sub-agent tool prefixes).
 */
export function planFromRoster(
  roster: readonly ResolvedRole[],
  orchestrator: { definitionId: string; backend: string; model?: string | undefined },
): GraphPlan {
  const agents: Record<string, PackAgent> = {};
  const overrides: GraphPlan['overrides'] = {
    [ORCHESTRATOR_ID]: {
      backend: orchestrator.backend,
      ...(orchestrator.model ? { model: orchestrator.model } : {}),
    },
  };
  for (const r of roster) {
    const id = subAgentName(r.role);
    if (id in agents || id === ORCHESTRATOR_ID)
      throw new DomainError(
        'invalid_graph',
        `The agent graph is invalid: role "${r.role}" maps to the id "${id}", which is already taken`,
        {
          issues: [{ path: `roster.${r.role}`, message: `"${id}" is already an agent id` }],
        },
      );
    agents[id] = {
      role: r.role,
      description: r.definition.description,
      definition: r.definition.id,
    };
    overrides[id] = { backend: r.backend };
  }
  agents[ORCHESTRATOR_ID] = {
    definition: orchestrator.definitionId,
    subAgents: Object.keys(agents).map((agent) => ({ agent })),
  };
  return { orchestrator: ORCHESTRATOR_ID, agents, overrides };
}

export const graphOf = (plan: GraphPlan): AgentGraph => {
  const input: AgentGraphInput = {
    orchestrator: plan.orchestrator,
    agents: Object.fromEntries(
      Object.entries(plan.agents).map(([id, a]) => [
        id,
        { external: a.external !== undefined, subAgents: a.subAgents },
      ]),
    ),
  };
  return resolveAgentGraph(input);
};

export interface GraphEnv {
  ports: Ports;
  directory: AgentDirectory;
  mcp: Pick<OrchestratorMcp, 'ensureInstance'>;
  subAgents?: SubAgentsOptions | undefined;
  /**
   * The event sink for agents Krama does not call itself. Their own tool calls and usage reach Krama only this way, because
   * a caller sees just the result of a sub-agent. Agents Krama calls directly report on the A2A stream, so they get no sink
   * (usage reported on both would count twice).
   */
  events?: { url: string; issue(claims: EventClaims): string } | undefined;
}

/** What one agent may call: the `subAgents` entries for its config, the lines for its prompt, and the secrets those entries need. */
export interface Children {
  entries: SubAgentEntry[];
  lines: AgentLine[];
  /** Environment variable -> secret reference, for `${VAR}` tokens of external agents the caller references. */
  secrets: Record<string, string>;
}

const asJson = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

/** A running agent's own description, from its agent card. */
const cardDescription = (env: GraphEnv, ref: AgentRef): string | undefined => {
  const d = asJson(env.ports.agents?.get(ref.id)?.card)?.description;
  return typeof d === 'string' ? d : undefined;
};

/** The agents `parent` may call, with the live endpoints of those Krama runs. Everything it references must be running or external. */
export function childrenOf(
  env: GraphEnv,
  plan: GraphPlan,
  graph: AgentGraph,
  parent: string,
  started: ReadonlyMap<string, AgentRef>,
): Children {
  const out: Children = { entries: [], lines: [], secrets: {} };
  for (const ref of graph.children[parent] ?? []) {
    const child = plan.agents[ref.agent]!;
    if (child.external) {
      const { name, agentCardUrl, endpointUrlOverride, auth } = child.external;
      out.entries.push({
        name,
        agentCardUrl,
        ...(endpointUrlOverride ? { endpointUrlOverride } : {}),
        ...(auth ? { auth } : {}),
      });
      out.lines.push({ id: name, description: child.description ?? name, hint: ref.hint });
      Object.assign(out.secrets, child.secrets);
      continue;
    }
    const running = started.get(ref.agent);
    if (!running)
      throw new DomainError(
        'not_found',
        `${ref.agent} is not running, so ${parent} cannot be given its address`,
      );
    out.entries.push({ name: ref.agent, agentCardUrl: cardUrl(running), auth: { mode: 'none' } });
    out.lines.push({
      id: ref.agent,
      description:
        child.description ??
        definitionOf(env, plan, ref.agent)?.description ??
        cardDescription(env, running),
      hint: ref.hint,
    });
  }
  return out;
}

function definitionOf(env: GraphEnv, plan: GraphPlan, id: string): AgentDefinition | undefined {
  const name = plan.agents[id]?.definition;
  return name ? env.directory.definitions().find((d) => d.id === name) : undefined;
}

/** The backend whose provider key appears at the top of a wrapper config. Exactly one must. */
function detectBackend(env: GraphEnv, id: string, config: Record<string, unknown>): string {
  const matches = (env.ports.backends?.list() ?? []).filter((b) => b.providerKey in config);
  if (matches.length === 1) return matches[0]!.id;
  const path = `agents.${id}.config`;
  throw new DomainError(
    'invalid_graph',
    `The agent graph is invalid: ${path}: ${
      matches.length === 0
        ? 'no registered backend has its provider key in this config'
        : `more than one backend matches (${matches.map((b) => b.id).join(', ')})`
    }`,
    { issues: [{ path, message: 'cannot tell which backend this config is for' }] },
  );
}

interface Managed {
  definition: AgentDefinition;
  baseConfig?: { json: Record<string, unknown> };
}

/** The definition (a projection of the agent's own config, D17) and base config a managed agent starts from. */
function managed(env: GraphEnv, pack: Pack, plan: GraphPlan, id: string): Managed {
  const spec = plan.agents[id]!;
  const over = plan.overrides[id] ?? {};
  if (spec.config) {
    const backend = detectBackend(env, id, spec.config);
    const card = asJson(spec.config.agentCard);
    return {
      baseConfig: { json: spec.config },
      definition: {
        id,
        role: spec.role ?? id,
        variant: 'default',
        name: id,
        description:
          spec.description ?? (typeof card?.description === 'string' ? card.description : id),
        backend: { wrapper: backend, ...(spec.secrets ? { secrets: spec.secrets } : {}) },
        skills: [],
        mcpServers: [],
        permissions: { tools: {} },
        memory: { enabled: false, scopes: [] },
        capabilities: [],
        source: { type: 'pack', packId: pack.id },
        links: {},
      },
    };
  }
  if (spec.definition) {
    const def = env.directory.definitions().find((d) => d.id === spec.definition);
    if (!def)
      throw new DomainError(
        'not_found',
        `Agent definition "${spec.definition}" (agents.${id}) not found`,
      );
    return {
      definition: {
        ...def,
        backend: {
          ...def.backend,
          ...(over.backend ? { wrapper: over.backend } : {}),
          ...(over.model ? { model: over.model } : {}),
        },
      },
    };
  }
  const path = `agents.${id}`;
  throw new DomainError(
    'invalid_graph',
    `The agent graph is invalid: ${path}: ${spec.git ? 'git sources are loaded by the pack loader and cannot be started yet' : 'has no config, definition or external source'}`,
    { issues: [{ path, message: 'no source Krama can start' }] },
  );
}

export interface SpecExtras {
  /** Text placed before the agent's hints: for the orchestrator, the core protocol and the run's request. */
  prompt?: string | undefined;
  /** Add the "Agents you can call" section. The orchestrator's prompt already carries its own. Default true. */
  hints?: boolean;
  mcp?: Record<string, unknown> | undefined;
  env?: Record<string, string> | undefined;
}

/** Everything needed to start one agent of the graph, given what it may call. */
export async function specFor(
  env: GraphEnv,
  run: Run,
  pack: Pack,
  plan: GraphPlan,
  id: string,
  children: Children,
  extra: SpecExtras = {},
): Promise<SpawnSpec> {
  const { definition, baseConfig } = managed(env, pack, plan, id);
  const ext = env.directory.extras?.(definition, run.id);
  // Secrets that external sub-agents' `${VAR}` tokens need: the caller's wrapper resolves them at its own start-up.
  const childEnv: Record<string, string> = {};
  for (const [name, ref] of Object.entries(children.secrets)) {
    const v = await env.ports.secrets.resolve(ref);
    if (v !== undefined) childEnv[name] = v;
  }
  const hints = extra.hints === false ? '' : renderAgentsSection(children.lines);
  // A config with its own prompt gets ours appended; a definition's persona text comes first.
  const persona = baseConfig ? '' : env.directory.systemPrompt(definition.id);
  const systemPrompt = [persona, extra.prompt, hints].filter(Boolean).join('\n\n');
  const hasOwnSubAgents = baseConfig !== undefined && 'subAgents' in baseConfig.json;
  const instanceId = env.events && id !== plan.orchestrator ? env.ports.ids.next('agt') : undefined;
  const sink =
    env.events && instanceId
      ? {
          enabled: true,
          transport: 'http',
          httpUrl: `${env.events.url.replace(/\/$/, '')}/agent-events`,
          // The wrapper does not substitute variables in header values, so the token is written into the owner-only derived config.
          httpHeaders: {
            Authorization: `Bearer ${env.events.issue({
              runId: run.id,
              instanceId,
              agent: id,
              role: definition.role,
              backend: definition.backend.wrapper,
            })}`,
          },
          httpTimeout: 5000,
        }
      : undefined;
  const overrides = {
    // The graph decides who an agent can call: its generated list replaces any `subAgents` in its own config.
    ...(children.entries.length > 0 || hasOwnSubAgents
      ? { subAgents: subAgentsConfig(children.entries, env.subAgents) }
      : {}),
    ...(sink ? { events: sink } : {}),
  };
  const mcp = { ...(ext?.mcp ?? {}), ...(extra.mcp ?? {}) };
  const spawnEnv = { ...(ext?.env ?? {}), ...childEnv, ...(extra.env ?? {}) };
  return {
    definition,
    workspace: { mode: 'shared', key: run.id },
    assignment: { runId: run.id },
    ...(systemPrompt ? { systemPrompt } : {}),
    ...(instanceId ? { instanceId } : {}),
    ...(baseConfig ? { baseConfig } : {}),
    ...(Object.keys(overrides).length > 0 ? { overrides } : {}),
    ...(Object.keys(mcp).length > 0 ? { mcp } : {}),
    ...(Object.keys(spawnEnv).length > 0 ? { env: spawnEnv } : {}),
  };
}

/**
 * Starts every agent the orchestrator can reach, leaves first, and waits for each to answer before its parents start, so
 * each parent is configured with its children's live addresses. An agent with several parents is one shared instance.
 * External agents are never started. The orchestrator is not started here.
 */
export async function startWorkers(
  env: GraphEnv,
  run: Run,
  pack: Pack,
  plan: GraphPlan,
  graph: AgentGraph,
): Promise<Map<string, AgentRef>> {
  const started = new Map<string, AgentRef>();
  for (const id of graph.order) {
    if (id === graph.orchestrator || plan.agents[id]!.external) continue;
    const children = childrenOf(env, plan, graph, id, started);
    started.set(
      id,
      await env.mcp.ensureInstance(run, id, () => specFor(env, run, pack, plan, id, children)),
    );
  }
  return started;
}
