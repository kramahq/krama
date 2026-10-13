import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { BackendRegistry, validateOptions } from '@kramahq/agents';
import type { Pack } from '@kramahq/contract';
import { createEngine } from '@kramahq/engine';
import { createFakePorts, type FakePorts } from '@kramahq/engine/testing';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  OrchestratorMcp,
  OrchestratorRunner,
  resolveGraphBackends,
} from '@kramahq/orchestrator-mcp';
import { loadPackDir, permissionSurface, toPack, withAbsolutePaths } from '@kramahq/pack';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

/**
 * Each shipped pack is run through the real orchestrator server with fake agents, and an orchestrator that does what the
 * pack's prompt tells it to. The pack does not decide anything here: what is checked is that the pack loads and starts as
 * the platform will start it, and that the gates the method asks for are real decisions the run waits on, with the loops
 * and the order of the work the platform records. Whether a model follows the prompt is not tested.
 */
const dir = process.env.KRAMA_PACKS_DIR ?? resolve(__dirname, '../../../../krama-packs');
const available = existsSync(dir);
const scratch = mkdtempSync(join(tmpdir(), 'krama pack runs '));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const user = { type: 'user' as const, id: 'u1', name: 'U1' };
type Step =
  | { plan: { id: string; label: string; dependsOn?: string[] }[] }
  | { delegate: [phaseId: string, role: string, task: string] }
  | {
      outcome: [phaseId: string, status: 'success' | 'partial', gating: 'continue' | 'loop_back'];
      loopTarget?: string;
      feedback?: string;
    }
  | { ask: string };

async function load(name: string) {
  const backends = BackendRegistry.withBuiltins();
  const load = await loadPackDir(join(dir, name), {
    backends,
    checkProviderConfig: (d, s) =>
      validateOptions(d, s).map((i) => ({ path: i.path, message: i.message })),
    // An agent taken from another repository is stood in for by a minimal Claude agent, so this needs no network.
    resolveGit: async (s) => {
      const d = join(scratch, 'git', s.path.replace(/[^a-z0-9]+/gi, '-'));
      mkdirSync(d, { recursive: true });
      writeFileSync(
        join(d, 'config.json'),
        JSON.stringify({
          agentCard: {
            name: 'second',
            description: 'A read-only reviewer',
            skills: [{ id: 'review', name: 'Review', description: 'Reviews code' }],
          },
          claude: { model: 'claude-sonnet-5-5' },
        }),
      );
      return { dir: d, sha: 'b'.repeat(40) };
    },
  });
  expect(load.issues.filter((i) => i.severity === 'error')).toEqual([]);
  const pack: Pack = toPack(load, {
    source: {
      url: 'https://example.test/krama-packs.git',
      ref: 'v0.1.0',
      path: name,
      sha: 'a'.repeat(40),
    },
    trust: 'trusted',
    status: 'enabled',
    installedAt: new Date().toISOString(),
    permissions: await permissionSurface(load, backends),
    engineVersion: '0.3.0',
  });
  const files = Object.fromEntries(
    Object.values(load.agents).flatMap((r) =>
      r.config ? [[r.id, r.dir ? withAbsolutePaths(r.config, r.dir) : r.config]] : [],
    ),
  );
  return { pack, backends, files };
}

async function start(name: string) {
  const { pack, backends, files } = await load(name);
  const p: FakePorts = createFakePorts([pack]);
  p.backends = backends;
  const directory = {
    definitions: () => [],
    systemPrompt: () => '',
    backendUsable: () => true,
    agentFiles: (_p: Pack, id: string) => (files[id] ? { config: files[id]! } : undefined),
  };
  p.graphs = { resolve: (x) => resolveGraphBackends({ ports: p, directory }, x) };
  const engine = createEngine(p, { defaultDelegation: 'krama' });
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
  p.executor = runner;
  const run = await engine.runs.create(
    { packId: pack.id, input: { text: 'KAN-1' }, budget: { max: 10 } },
    user,
  );
  return { pack, p, engine, mcp, runner, url, runId: run.id, errors };
}
type Live = Awaited<ReturnType<typeof start>>;
const live: Live[] = [];
afterEach(async () => {
  for (const s of live.splice(0)) {
    await s.runner.shutdown();
    await s.mcp.close();
  }
});

const call = async (c: Client, name: string, args: Record<string, unknown>) => {
  const r = await c.callTool({ name, arguments: args });
  const text = (r.content as { text: string }[])[0]?.text ?? '{}';
  const body = JSON.parse(text);
  return { ok: !r.isError, data: r.isError ? (body.error ?? body) : body };
};

/** One orchestrator turn: the steps a pack's prompt tells the orchestrator to take, in order. */
function turn(s: Live, steps: Step[]) {
  return async function* () {
    yield { kind: 'state', state: 'working', taskId: 'o', contextId: 'oc' } as const;
    const spec = [...s.p.agents.spawned]
      .reverse()
      .find((x) => x.definition.role === 'orchestrator');
    const client = new Client({ name: 'scripted-orchestrator', version: '0.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${s.url}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${spec!.env!.KRAMA_MCP_TOKEN}` } },
      }),
    );
    try {
      for (const st of steps) {
        let r: { ok: boolean; data: Record<string, unknown> };
        if ('plan' in st) r = await call(client, 'set_plan', { phases: st.plan });
        else if ('delegate' in st) {
          const [phaseId, role, task] = st.delegate;
          r = await call(client, 'delegate_to_agent', { phaseId, role, task });
        } else if ('outcome' in st) {
          const [phaseId, status, gating] = st.outcome;
          r = await call(client, 'record_phase_outcome', {
            phaseId,
            status,
            reason: 'scripted',
            gating,
            ...(st.loopTarget ? { loopTarget: st.loopTarget } : {}),
            ...(st.feedback ? { feedback: st.feedback } : {}),
          });
        } else
          r = await call(client, 'request_decision', {
            kind: 'approval',
            title: st.ask,
            question: `Please decide: ${st.ask}`,
            options: [
              { id: 'approve', label: 'Approve', style: 'primary', effect: 'proceed' },
              {
                id: 'changes',
                label: 'Request changes',
                effect: 'answer',
                input: { required: true, label: 'What to change', kind: 'text' },
              },
            ],
          });
        expect(r.ok, JSON.stringify([st, r.data])).toBe(true);
      }
    } finally {
      await client.close().catch(() => undefined);
    }
    yield { kind: 'state', state: 'completed', taskId: 'o', contextId: 'oc' } as const;
  };
}

const until = async (cond: () => boolean | Promise<boolean>, ms = 15_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timed out waiting');
};
const status = async (s: Live) => (await s.p.store.runs.get(s.runId))!.value.run.status;
const pending = async (s: Live) =>
  (await s.p.store.decisions.list({ runId: s.runId, status: ['pending'] })).items[0]?.value
    .decision;

/**
 * Plays a whole run: one scripted turn per stretch of work, a person approving at each gate. Returns the titles of the
 * decisions the run waited on, in order, and the agents the platform called, in order.
 */
async function play(name: string, turns: Step[][]) {
  const s = await start(name);
  live.push(s);
  for (const steps of turns) s.p.gateway.queue('orchestrator', turn(s, steps));
  await s.runner.start(s.runId);
  const asked: string[] = [];
  for (;;) {
    await until(async () => {
      const st = await status(s);
      return (
        st === 'awaiting_decision' || st === 'completed' || st === 'blocked' || st === 'failed'
      );
    });
    if ((await status(s)) !== 'awaiting_decision') break;
    const d = (await pending(s))!;
    asked.push(d.title);
    await s.engine.decisions.resolve(d.id, { optionId: d.options[0]!.id }, user);
  }
  await s.runner.idle(s.runId);
  // By the agent's id in the pack (its role there is a label for people, not a key).
  const ids = new Map(s.p.agents.list().map((x) => [x.id, x.definitionId]));
  const called = s.p.gateway.sent
    .filter((x) => x.agent.role !== 'orchestrator')
    .map((x) => ids.get(x.agent.id) ?? x.agent.role);
  return { s, asked, called, status: await status(s) };
}

const phases = (ids: string[]) =>
  ids.map((id, i) => ({ id, label: id, ...(i ? { dependsOn: [ids[i - 1]!] } : {}) }));
const ok = (id: string): Step => ({ outcome: [id, 'success', 'continue'] });
const back = (id: string, to: string, feedback: string): Step => ({
  outcome: [id, 'partial', 'loop_back'],
  loopTarget: to,
  feedback,
});

describe.skipIf(!available)('the shipped packs, run with fake agents', () => {
  it('sdlc: analysis and design wait for a person, review loops back to the developer, then QA', async () => {
    const r = await play('sdlc', [
      [
        { plan: phases(['refinement', 'design', 'development', 'review', 'testing']) },
        { delegate: ['refinement', 'analyst', 'Refine KAN-1'] },
        ok('refinement'),
        { ask: 'Approve the requirements' },
      ],
      [
        { delegate: ['design', 'architect', 'Design KAN-1'] },
        ok('design'),
        { ask: 'Approve the design' },
      ],
      [
        { delegate: ['development', 'developer', 'Implement KAN-1-1'] },
        ok('development'),
        { delegate: ['review', 'reviewer', 'Review the pull request'] },
        back('review', 'development', 'Handle the empty case'),
        { delegate: ['development', 'developer', 'Fix the review findings'] },
        ok('development'),
        { delegate: ['review', 'reviewer', 'Review again'] },
        ok('review'),
        { delegate: ['testing', 'qa', 'Test KAN-1'] },
        ok('testing'),
      ],
    ]);
    expect(r.called).toEqual([
      'analyst',
      'architect',
      'developer',
      'reviewer',
      'developer',
      'reviewer',
      'qa',
    ]);
    expect(r.asked.slice(0, 2)).toEqual(['Approve the requirements', 'Approve the design']);
    expect(r.status).toBe('completed');
    expect(r.s.errors).toEqual([]);
  });

  it('tech-debt: research, then a person approves the plan before any patch', async () => {
    const r = await play('tech-debt', [
      [
        { plan: phases(['research', 'patch', 'review', 'testing']) },
        { delegate: ['research', 'security-architect', 'Research the finding on KAN-2'] },
        ok('research'),
        { ask: 'Approve the remediation plan' },
      ],
      [
        { delegate: ['patch', 'patch-developer', 'Apply KAN-2-1'] },
        ok('patch'),
        { delegate: ['review', 'reviewer', 'Review the pull request'] },
        ok('review'),
        { delegate: ['testing', 'qa', 'Check the finding is gone'] },
        ok('testing'),
      ],
    ]);
    // No patch work is called before the person answered: the first turn ends with the gate.
    expect(r.called).toEqual(['security-architect', 'patch-developer', 'reviewer', 'qa']);
    expect(r.asked[0]).toBe('Approve the remediation plan');
    expect(r.status).toBe('completed');
    expect(r.s.errors).toEqual([]);
  });

  it('ai-dlc: the mob-elaboration points are decisions, each after its reviewer', async () => {
    const r = await play('ai-dlc', [
      [
        { plan: phases(['ideation', 'inception', 'construction', 'operation']) },
        { delegate: ['ideation', 'product', 'Capture the intent'] },
        { delegate: ['ideation', 'delivery', 'Approval and hand-off'] },
        ok('ideation'),
        { delegate: ['inception', 'product', 'Requirements and user stories'] },
        { delegate: ['inception', 'product-lead', 'Review the requirements and stories'] },
        { ask: 'Validate the requirements and stories' },
      ],
      [
        { delegate: ['inception', 'architect', 'Domain design and units'] },
        { delegate: ['inception', 'architecture-reviewer', 'Review the design'] },
        { ask: 'Validate the design and units' },
      ],
      [
        { delegate: ['inception', 'delivery', 'Delivery plan'] },
        { ask: 'Approve the delivery plan' },
      ],
      [
        ok('inception'),
        { delegate: ['construction', 'developer', 'Unit 1: code generation'] },
        { ask: 'Approve Unit 1' },
      ],
      [
        ok('construction'),
        { delegate: ['operation', 'operations', 'Observability and feedback'] },
        ok('operation'),
      ],
    ]);
    expect(r.asked.slice(0, 4)).toEqual([
      'Validate the requirements and stories',
      'Validate the design and units',
      'Approve the delivery plan',
      'Approve Unit 1',
    ]);
    // A reviewer is called before each validation, never after it.
    expect(r.called.indexOf('product-lead')).toBeLessThan(r.called.indexOf('architect'));
    expect(r.called.indexOf('architecture-reviewer')).toBeLessThan(r.called.indexOf('operations'));
    expect(r.status).toBe('completed');
    expect(r.s.errors).toEqual([]);
  });

  it('deck: a person approves the outline before the deck is built', async () => {
    const r = await play('deck', [
      [
        { plan: phases(['research', 'outline', 'build', 'check']) },
        { delegate: ['research', 'researcher', 'Read the attached files'] },
        ok('research'),
        { delegate: ['outline', 'writer', 'Write the outline'] },
        { ask: 'Approve the outline' },
      ],
      [
        ok('outline'),
        { delegate: ['build', 'writer', 'Write the slides'] },
        { delegate: ['build', 'designer', 'Build the deck'] },
        ok('build'),
        ok('check'),
      ],
    ]);
    expect(r.called).toEqual(['researcher', 'writer', 'writer', 'designer']);
    expect(r.asked[0]).toBe('Approve the outline');
    expect(r.status).toBe('completed');
    expect(r.s.errors).toEqual([]);
  });
});

describe.skipIf(!available)('the shipped packs name no agent that is not in them', () => {
  it.each(
    available ? readdirSync(dir).filter((d) => existsSync(join(dir, d, 'krama-pack.yaml'))) : [],
  )('%s', async (name) => {
    const { pack } = await load(name);
    const ids = new Set(Object.keys(pack.agents ?? {}));
    for (const a of Object.values(pack.agents ?? {}))
      for (const ref of a.subAgents ?? []) expect(ids.has(ref.agent)).toBe(true);
  });
});

// The tools an orchestrator has (`packages/orchestrator-mcp/src/tools.ts`) plus the Jira tools its MCP server brings.
const TOOLS = new Set([
  'get_run',
  'query_agents',
  'delegate_to_agent',
  'record_phase_outcome',
  'set_plan',
  'request_decision',
  'store_artifact',
  'get_artifact',
  'get_budget',
  // Not tools but values the tools take (a gating decision).
  'loop_back',
  'skip_downstream',
]);

describe.skipIf(!available)('what the shipped orchestrators tell their model to call', () => {
  it.each(
    available ? readdirSync(dir).filter((d) => existsSync(join(dir, d, 'krama-pack.yaml'))) : [],
  )('%s names only tools that exist', async (name) => {
    const { pack } = await load(name);
    const lead = pack.agents![pack.orchestrator!]!;
    const text = JSON.stringify(lead.config);
    const named = [...text.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)].map((m) => m[1]!);
    expect(named.length).toBeGreaterThan(0);
    const unknown = named.filter((n) => !TOOLS.has(n) && !n.startsWith('jira_'));
    expect(unknown).toEqual([]);
  });
});
