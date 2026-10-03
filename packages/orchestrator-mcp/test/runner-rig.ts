import type { Pack } from '@kramahq/contract';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  createEngine,
  type Engine,
  type GatewayEvent,
  type GatewayTurn,
  type SendMessage,
} from '@kramahq/engine';
import { FakeAgentRuntime, createFakePorts, type FakePorts } from '@kramahq/engine/testing';
import { OrchestratorMcp, OrchestratorRunner } from '../src/index.js';
import { call, connect, def, pack } from './rig.js';

export const user = { type: 'user' as const, id: 'u1', name: 'U1' };

export interface System {
  p: FakePorts;
  engine: Engine;
  mcp: OrchestratorMcp;
  runner: OrchestratorRunner;
  url: string;
  errors: unknown[];
  stop(): Promise<void>;
}

/** A full server-side stack over a set of ports. Pass `shared` to "restart" onto the same store, events and artifacts. */
export async function system(
  shared?: FakePorts,
  policy: object = {},
  packs: Pack[] = [pack()],
): Promise<System> {
  const base = shared ?? createFakePorts(packs);
  const p: FakePorts = shared ? { ...base, agents: new FakeAgentRuntime() } : base;
  const engine = createEngine(p, policy);
  const defs = [
    def('author', ['write']),
    def('reviewer', ['review'], 'a2a-claude'),
    { ...def('orchestrator', ['orchestrate'], 'a2a-claude'), description: 'Orchestrates runs' },
  ];
  const directory = {
    definitions: () => defs,
    systemPrompt: (id: string) => (id === 'orchestrator/default' ? '' : ''),
    backendUsable: () => true,
  };
  const errors: unknown[] = [];
  const mcp = new OrchestratorMcp({ engine, ports: p, directory, onError: (e) => errors.push(e) });
  const url = await mcp.listen();
  const runner = new OrchestratorRunner({
    engine,
    ports: p,
    mcp,
    mcpBaseUrl: url,
    directory,
    onError: (e) => errors.push(e),
    maxNudges: 2,
  });
  p.executor = runner; // the runner is told whenever a decision settles
  return {
    p,
    engine,
    mcp,
    runner,
    url,
    errors,
    stop: async () => {
      await runner.shutdown();
      await mcp.close();
    },
  };
}

export async function newRun(s: System, text = 'Write the release notes'): Promise<string> {
  const run = await s.engine.runs.create(
    { packId: 'pack_demo', input: { text }, budget: { max: 10 } },
    user,
  );
  return run.id;
}

const tokenOf = (s: System) => {
  const spec = [...s.p.agents.spawned].reverse().find((x) => x.definition.role === 'orchestrator');
  if (!spec?.env?.KRAMA_MCP_TOKEN) throw new Error('orchestrator was not spawned with a token');
  return spec.env.KRAMA_MCP_TOKEN;
};

/** Plays the orchestrator LLM: connects over MCP with the token it was given and runs `script`, then ends its turn. */
export function playOrchestrator(
  s: System,
  script: (c: Client, message: SendMessage) => Promise<void>,
  end: Partial<Extract<GatewayEvent, { kind: 'state' }>> = {},
): GatewayTurn {
  return async function* (message) {
    yield { kind: 'state', state: 'working', taskId: 'orch_task', contextId: 'orch_ctx' };
    const client = await connect(s.url, tokenOf(s));
    try {
      await script(client, message);
    } finally {
      await client.close().catch(() => undefined);
    }
    yield {
      kind: 'state',
      state: 'completed',
      taskId: 'orch_task',
      contextId: 'orch_ctx',
      ...end,
    } as GatewayEvent;
  };
}

export const worker = (text: string, ctx = 'ctx_w'): GatewayEvent[] => [
  { kind: 'state', state: 'working', taskId: `t_${text.slice(0, 4)}`, contextId: ctx },
  {
    kind: 'artifact',
    name: 'response',
    mediaType: 'text/plain',
    bytes: new TextEncoder().encode(text),
  },
  { kind: 'state', state: 'completed', taskId: `t_${text.slice(0, 4)}`, contextId: ctx },
];

export { call };
export const until = async (cond: () => boolean | Promise<boolean>, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timed out waiting');
};
export const statusOf = async (s: System, runId: string) =>
  (await s.p.store.runs.get(runId))!.value.run.status;
