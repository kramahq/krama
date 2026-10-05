import { DomainError } from './errors.js';

/** A reference from one agent to another it may call. */
export interface GraphRef {
  agent: string;
  /** Guidance for the caller about when to use the referenced agent. Never grants anything. */
  hint?: string | undefined;
}

/** What the graph needs to know about one catalogue entry. */
export interface GraphAgentSpec {
  /** An agent Krama does not run (a remote A2A service). External agents are leaves. */
  external?: boolean | undefined;
  subAgents?: readonly GraphRef[] | undefined;
}

export interface AgentGraphInput {
  orchestrator: string;
  agents: Readonly<Record<string, GraphAgentSpec>>;
}

export interface GraphIssue {
  /** Path in the pack, e.g. `agents.reviewer.subAgents[0].agent`. */
  path: string;
  message: string;
}

export interface AgentGraph {
  orchestrator: string;
  /** Leaf-first: every agent appears after everything it references, the orchestrator last. Each id once. */
  order: string[];
  /** Direct references per reachable agent, in declared order. */
  children: Record<string, GraphRef[]>;
  /** Reachable agents that reference each reachable agent. An agent with two parents is one shared instance. */
  parents: Record<string, string[]>;
  /** Catalogue entries the orchestrator cannot reach. They are never started. */
  unreachable: string[];
}

/** Ids double as the wrapper's sub-agent names, so they follow its name rule. */
export const AGENT_ID = /^[a-z][a-z0-9-]*$/;

/** Every structural problem in the graph, each with the path that caused it. Empty when the graph is sound. */
export function validateAgentGraph(input: AgentGraphInput): GraphIssue[] {
  const issues: GraphIssue[] = [];
  const { orchestrator, agents } = input;

  for (const id of Object.keys(agents))
    if (!AGENT_ID.test(id))
      issues.push({
        path: `agents.${id}`,
        message: `"${id}" is not a valid agent id (lowercase letters, digits and hyphens, starting with a letter)`,
      });

  const root = agents[orchestrator];
  if (!root)
    issues.push({
      path: 'orchestrator',
      message: `The orchestrator "${orchestrator}" is not in the agent catalogue`,
    });
  else if (root.external)
    issues.push({
      path: 'orchestrator',
      message: `The orchestrator "${orchestrator}" is external; it must be an agent Krama runs`,
    });

  for (const [id, spec] of Object.entries(agents)) {
    const refs = spec.subAgents ?? [];
    if (spec.external && refs.length > 0)
      issues.push({
        path: `agents.${id}.subAgents`,
        message: `"${id}" is external and cannot declare sub-agents`,
      });
    const seen = new Set<string>();
    refs.forEach((r, i) => {
      const path = `agents.${id}.subAgents[${i}].agent`;
      if (!(r.agent in agents))
        issues.push({ path, message: `"${r.agent}" is not in the agent catalogue` });
      else if (seen.has(r.agent))
        issues.push({ path, message: `"${id}" lists "${r.agent}" more than once` });
      seen.add(r.agent);
    });
  }

  // Cycles, found depth-first from every agent so a cycle off the orchestrator's path is reported too.
  const state = new Map<string, 'open' | 'done'>();
  const stack: string[] = [];
  const visit = (id: string): void => {
    state.set(id, 'open');
    stack.push(id);
    (agents[id]?.subAgents ?? []).forEach((r, i) => {
      if (!(r.agent in agents)) return;
      const s = state.get(r.agent);
      if (s === 'open') {
        const loop = [...stack.slice(stack.indexOf(r.agent)), r.agent];
        issues.push({
          path: `agents.${id}.subAgents[${i}].agent`,
          message: `Cycle: ${loop.join(' -> ')}`,
        });
      } else if (s === undefined) visit(r.agent);
    });
    stack.pop();
    state.set(id, 'done');
  };
  for (const id of Object.keys(agents)) if (!state.has(id)) visit(id);

  return issues;
}

/**
 * Resolves the agents reachable from the orchestrator into a start order. Throws `invalid_graph` listing every
 * problem when the graph is unsound, so a pack with several mistakes reports them all at once.
 */
export function resolveAgentGraph(input: AgentGraphInput): AgentGraph {
  const issues = validateAgentGraph(input);
  if (issues.length > 0)
    throw new DomainError(
      'invalid_graph',
      `The agent graph is invalid: ${issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`,
      { issues },
    );

  const { orchestrator, agents } = input;
  const order: string[] = [];
  const children: Record<string, GraphRef[]> = {};
  const parents: Record<string, string[]> = {};
  const seen = new Set<string>();
  const visit = (id: string): void => {
    seen.add(id);
    const refs = (agents[id]?.subAgents ?? []).map((r) => ({ ...r }));
    children[id] = refs;
    parents[id] ??= [];
    for (const r of refs) {
      (parents[r.agent] ??= []).push(id);
      if (!seen.has(r.agent)) visit(r.agent);
    }
    order.push(id); // post-order: after everything it references
  };
  visit(orchestrator);

  return {
    orchestrator,
    order,
    children,
    parents,
    unreachable: Object.keys(agents).filter((id) => !seen.has(id)),
  };
}
