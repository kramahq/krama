import type { AgentDefinition, Pack } from '@kramahq/contract';
import { createEngine, type Engine } from '@kramahq/engine';
import { authorReviewerPack, createFakePorts, type FakePorts } from '@kramahq/engine/testing';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { OrchestratorMcp, type AgentDirectory } from '../src/index.js';

export const def = (role: string, caps: string[], backend = 'a2a-codex'): AgentDefinition => ({
  id: `${role}/default`,
  role,
  variant: 'default',
  name: role,
  description: role,
  backend: { wrapper: backend },
  skills: [],
  mcpServers: [],
  permissions: { tools: {} },
  memory: { enabled: false, scopes: [] },
  capabilities: caps,
  source: { type: 'local' },
  links: {},
});

export const pack = (): Pack => ({
  ...authorReviewerPack(),
  roster: [
    { role: 'author', select: { capabilities: ['write'] } },
    { role: 'reviewer', select: { capabilities: ['review'] } },
  ],
});

export interface Rig {
  p: FakePorts;
  engine: Engine;
  mcp: OrchestratorMcp;
  url: string;
  runId: string;
  token: string;
  client: Client;
  directory: AgentDirectory & { prompts: Record<string, string>; unusable: Set<string> };
  close(): Promise<void>;
}

const user = { type: 'user' as const, id: 'u1', name: 'U1' };

export async function rig(opts: { policy?: object; start?: boolean } = {}): Promise<Rig> {
  const p = createFakePorts([pack()]);
  const engine = createEngine(p, opts.policy ?? {});
  const defs = [def('author', ['write']), def('reviewer', ['review'], 'a2a-claude')];
  const directory = {
    prompts: { 'author/default': 'You write.', 'reviewer/default': 'You review.' } as Record<
      string,
      string
    >,
    unusable: new Set<string>(),
    definitions: () => defs,
    systemPrompt(id: string) {
      return this.prompts[id] ?? '';
    },
    backendUsable(b: string) {
      return !this.unusable.has(b);
    },
  };
  const mcp = new OrchestratorMcp({ engine, ports: p, directory });
  const url = await mcp.listen();
  const run = await engine.runs.create(
    { packId: 'pack_demo', input: { text: 'Write the release notes' }, budget: { max: 10 } },
    user,
  );
  if (opts.start !== false) await engine.runs.plan(run.id);
  const token = mcp.tokens.issue(run.id);
  const client = await connect(url, token);
  return {
    p,
    engine,
    mcp,
    url,
    runId: run.id,
    token,
    client,
    directory,
    close: async () => {
      await client.close().catch(() => undefined);
      await mcp.close();
    },
  };
}

export async function connect(url: string, token: string): Promise<Client> {
  const client = new Client({ name: 'test-orchestrator', version: '0.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}

/** Result bodies are plain JSON whose shape each test asserts on. */
export type ToolData = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Calls a tool and returns its structured result, or the typed error body. */
export async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ ok: boolean; data: ToolData }> {
  const r = await client.callTool({ name, arguments: args });
  const text = (r.content as { type: string; text: string }[])[0]?.text ?? '{}';
  const body = JSON.parse(text);
  return r.isError ? { ok: false, data: body.error ?? body } : { ok: true, data: body };
}
