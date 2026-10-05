import type { Agent, Run } from '@kramahq/contract';
import {
  DomainError,
  type AgentRef,
  type Ports,
  type ResolvedRole,
  type SpawnSpec,
} from '@kramahq/engine';
import type { AgentDirectory, SharedState } from './tools.js';

export interface WorkerEnv {
  ports: Ports;
  directory: AgentDirectory;
  state: SharedState;
}

/**
 * Returns the running worker agent for a run and role, starting it when needed. One instance is kept per run and
 * role, so its session and workspace persist across delegations. Used by both delegation modes: `krama` starts a
 * worker on first delegation; `native` starts every rostered worker up front so the orchestrator can reach them.
 */
export async function ensureWorker(
  env: WorkerEnv,
  run: Run,
  resolved: ResolvedRole,
  assignment: Agent['assignment'] = { runId: run.id },
): Promise<AgentRef> {
  const runtime = env.ports.agents;
  if (!runtime) throw new DomainError('not_found', 'No agent runtime is configured');
  const slot = `${run.id}:${resolved.role}`;
  let agentId = env.state.agents.get(slot);
  if (!agentId || !runtime.ref(agentId)) {
    const extras = env.directory.extras?.(resolved.definition, run.id);
    const spawned = await runtime.spawn({
      definition:
        resolved.backend === resolved.definition.backend.wrapper
          ? resolved.definition
          : {
              ...resolved.definition,
              backend: { ...resolved.definition.backend, wrapper: resolved.backend },
            },
      workspace: { mode: 'shared', key: run.id },
      assignment,
      systemPrompt: env.directory.systemPrompt(resolved.definition.id),
      ...(extras?.mcp ? { mcp: extras.mcp } : {}),
      ...(extras?.env ? { env: extras.env } : {}),
    });
    agentId = spawned.id;
    env.state.agents.set(slot, agentId);
  }
  const ref = runtime.ref(agentId);
  if (!ref)
    throw new DomainError('not_found', `The ${resolved.role} agent stopped right after starting`);
  return ref;
}

/** A running agent of the run's graph, and whether it came back at a different address than its callers were given. */
export interface Instance {
  ref: AgentRef;
  moved: boolean;
}

const portOf = (url: string | undefined): number | undefined => {
  const p = url ? Number(new URL(url).port) : NaN;
  return Number.isInteger(p) && p > 0 ? p : undefined;
};

/**
 * Returns the running instance of an agent in this run, starting it with `spec` when there is none. One instance per run
 * and key: an agent that several parents reference is started once and shared. Instances are recorded against the run, so
 * `releaseRun` stops them with it.
 *
 * An instance that has died is brought back where it was: restarted in place (same id, same port, same configuration),
 * or, when that is not possible, started afresh asking for its old port. Only if the old address cannot be kept is
 * `moved` set, so the caller can reconfigure the agents that were given that address.
 */
export async function ensureInstance(
  env: WorkerEnv,
  run: Run,
  key: string,
  spec: () => Promise<SpawnSpec>,
): Promise<Instance> {
  const runtime = env.ports.agents;
  if (!runtime) throw new DomainError('not_found', 'No agent runtime is configured');
  const slot = `${run.id}:${key}`;
  const known = env.state.agents.get(slot);
  const before = env.state.urls.get(slot);
  const live = known ? runtime.ref(known) : undefined;
  if (live) return { ref: live, moved: false };

  let id: string | undefined;
  if (known) {
    // It was running and is not: the supervisor already tried its restart policy, so bring it back in place.
    try {
      await runtime.restart(known);
      id = known;
    } catch {
      /* start it afresh below */
    }
  }
  if (!id) {
    const base = await spec();
    const preferredPort = portOf(before);
    id = (await runtime.spawn({ ...base, ...(preferredPort ? { preferredPort } : {}) })).id;
    env.state.agents.set(slot, id);
  }
  const ref = runtime.ref(id);
  if (!ref) throw new DomainError('not_found', `The ${key} agent stopped right after starting`);
  env.state.urls.set(slot, ref.url);
  return { ref, moved: before !== undefined && before !== ref.url };
}

/** Stops an instance and forgets it, so the next `ensureInstance` starts it afresh. Its last address is kept, to ask for the same port. */
export async function stopInstance(env: WorkerEnv, run: Run, key: string): Promise<void> {
  const slot = `${run.id}:${key}`;
  const id = env.state.agents.get(slot);
  env.state.agents.delete(slot);
  if (id) await env.ports.agents?.stop(id).catch(() => undefined);
}
