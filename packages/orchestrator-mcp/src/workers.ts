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

/**
 * Returns the running instance of an agent in this run, starting it with `spec` when there is none. One instance per run
 * and key: an agent that several parents reference is started once and shared. Instances are recorded against the run, so
 * `releaseRun` stops them with it.
 */
export async function ensureInstance(
  env: WorkerEnv,
  run: Run,
  key: string,
  spec: () => Promise<SpawnSpec>,
): Promise<AgentRef> {
  const runtime = env.ports.agents;
  if (!runtime) throw new DomainError('not_found', 'No agent runtime is configured');
  const slot = `${run.id}:${key}`;
  const known = env.state.agents.get(slot);
  const live = known ? runtime.ref(known) : undefined;
  if (live) return live;
  const spawned = await runtime.spawn(await spec());
  env.state.agents.set(slot, spawned.id);
  const ref = runtime.ref(spawned.id);
  if (!ref) throw new DomainError('not_found', `The ${key} agent stopped right after starting`);
  return ref;
}
