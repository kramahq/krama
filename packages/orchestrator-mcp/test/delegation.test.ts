import { afterEach, describe, expect, it } from 'vitest';
import { buildSubAgents, renderOrchestratorPrompt, subAgentName } from '../src/index.js';
import { connect, pack, rig, type Rig } from './rig.js';
import {
  call,
  newRun,
  playOrchestrator,
  statusOf,
  system,
  until,
  user,
  type System,
} from './runner-rig.js';

const live: System[] = [];
const rigs: Rig[] = [];
afterEach(async () => {
  await Promise.allSettled([
    ...live.splice(0).map((s) => s.stop()),
    ...rigs.splice(0).map((r) => r.close()),
  ]);
});
// Native is the default; `system()` pins the relay for the older scenarios, so these opt back in.
const make = async (policy: object = { defaultDelegation: 'native' }) => {
  const s = await system(undefined, policy);
  live.push(s);
  return s;
};

const RELAY_ONLY = ['delegate_to_agent', 'query_agents'];
const toolNames = async (url: string, token: string) => {
  const c = await connect(url, token);
  try {
    return (await c.listTools()).tools.map((t) => t.name);
  } finally {
    await c.close();
  }
};

describe('delegation mode on the run', () => {
  const newRunWith = async (s: System, delegation?: 'krama' | 'native') =>
    (
      await s.engine.runs.create(
        {
          packId: 'pack_demo',
          input: { text: 'x' },
          ...(delegation ? { orchestrator: { delegation } } : {}),
        },
        user,
      )
    ).orchestrator.delegation;

  it('follows policy, and the run request wins (the built-in default is covered in the engine tests)', async () => {
    const k = await make({ defaultDelegation: 'krama' });
    expect(await newRunWith(k)).toBe('krama');
    expect(await newRunWith(k, 'native')).toBe('native');
    const n = await make({ defaultDelegation: 'native' });
    expect(await newRunWith(n)).toBe('native');
    expect(await newRunWith(n, 'krama')).toBe('krama');
  });
});

describe('the orchestrator tool surface', () => {
  it('offers the relay tools in krama mode and withholds them in native mode', async () => {
    const r = await rig();
    rigs.push(r);
    const relay = await toolNames(r.url, r.mcp.tokens.issue(r.runId, undefined, 'krama'));
    expect(relay).toEqual(expect.arrayContaining([...RELAY_ONLY, 'record_phase_outcome']));

    const native = await toolNames(r.url, r.mcp.tokens.issue(r.runId, undefined, 'native'));
    for (const t of RELAY_ONLY) expect(native).not.toContain(t);
    expect(native).toEqual(
      expect.arrayContaining([
        'get_run',
        'record_phase_outcome',
        'request_decision',
        'store_artifact',
        'get_artifact',
        'get_budget',
      ]),
    );
  });

  it('refuses a relay call made with a native token', async () => {
    const r = await rig();
    rigs.push(r);
    const c = await connect(r.url, r.mcp.tokens.issue(r.runId, undefined, 'native'));
    try {
      await expect(
        call(c, 'delegate_to_agent', { phaseId: 'draft', role: 'author', task: 'x' }),
      ).rejects.toThrow();
    } finally {
      await c.close();
    }
  });
});

describe('sub-agent config', () => {
  it('lists each worker by its agent card and nothing else', () => {
    const cfg = buildSubAgents([
      { id: 'agt_1', url: 'http://127.0.0.1:4101/', role: 'author', backend: 'a2a-codex' },
      { id: 'agt_2', url: 'http://127.0.0.1:4102', role: 'Code Reviewer', backend: 'a2a-claude' },
    ]);
    expect(cfg.agents).toEqual([
      {
        name: 'author',
        agentCardUrl: 'http://127.0.0.1:4101/.well-known/agent-card.json',
        auth: { mode: 'none' },
      },
      {
        name: 'code-reviewer',
        agentCardUrl: 'http://127.0.0.1:4102/.well-known/agent-card.json',
        auth: { mode: 'none' },
      },
    ]);
    expect(cfg.options).toEqual({
      responseMode: 'artifact',
      probeTimeoutMs: 5000,
      syncBudgetMs: 30000,
    });
    expect(buildSubAgents([], { syncBudgetMs: 90_000 }).options.syncBudgetMs).toBe(90_000);
    expect(subAgentName('QA / Tester')).toBe('qa-tester');
  });
});

describe('a run in native delegation mode', () => {
  it('starts every rostered worker first, gives the orchestrator a sub-agent config for exactly that roster, and runs to completion', async () => {
    const s = await make();
    const runId = await newRun(s);
    let seenTools: string[] = [];
    s.p.gateway.queue(
      'orchestrator',
      playOrchestrator(s, async (c) => {
        seenTools = (await c.listTools()).tools.map((t) => t.name);
        // The orchestrator calls workers itself in this mode; Krama only hears about the outcomes.
        await call(c, 'record_phase_outcome', {
          phaseId: 'draft',
          status: 'success',
          reason: 'author agent finished',
          gating: 'continue',
        });
        await call(c, 'record_phase_outcome', {
          phaseId: 'review',
          status: 'success',
          reason: 'reviewer agent approved',
          gating: 'continue',
        });
      }),
    );
    await s.runner.start(runId);
    await until(async () => (await statusOf(s, runId)) === 'awaiting_decision');

    const spawned = s.p.agents.spawned;
    const roles = spawned.map((x) => x.definition.role);
    expect(roles.slice(0, 2).sort()).toEqual(['author', 'reviewer']);
    expect(roles[2]).toBe('orchestrator'); // workers first: the orchestrator probes them at startup

    const orch = spawned.find((x) => x.definition.role === 'orchestrator')!;
    const subAgents = orch.definition.backend.common?.subAgents as ReturnType<
      typeof buildSubAgents
    >;
    const workers = s.p.agents.list().filter((a) => a.role !== 'orchestrator');
    expect(subAgents.agents.map((a) => a.name).sort()).toEqual(['author', 'reviewer']);
    for (const w of workers)
      expect(subAgents.agents.map((a) => a.agentCardUrl)).toContain(
        `${w.url}/.well-known/agent-card.json`,
      );

    expect(orch.mcp).toMatchObject({ krama: { type: 'http', url: `${s.url}/mcp` } });
    expect(orch.systemPrompt).toContain('Agents you can call');
    expect(orch.systemPrompt).not.toContain('delegate_to_agent');
    expect(orch.systemPrompt).not.toContain('query_agents');
    for (const t of RELAY_ONLY) expect(seenTools).not.toContain(t);
    expect(seenTools).toContain('record_phase_outcome');

    const dec = (await s.p.store.decisions.list({ runId, status: ['pending'] })).items[0]!.value
      .decision;
    await s.engine.decisions.resolve(dec.id, { optionId: 'approve' }, user);
    await until(async () => (await statusOf(s, runId)) === 'completed');
    await s.runner.idle(runId);

    // Workers are released with the run, like the orchestrator.
    expect(s.p.agents.list({ status: ['idle', 'busy', 'starting'] })).toEqual([]);
    expect(s.mcp.tokens.size).toBe(0);
    expect(s.errors).toEqual([]);
  });

  it('keeps the relay mode working side by side', async () => {
    const s = await make({ defaultDelegation: 'krama' });
    const runId = await newRun(s);
    s.p.gateway.queue(
      'orchestrator',
      playOrchestrator(s, async (c) => {
        const names = (await c.listTools()).tools.map((t) => t.name);
        for (const t of RELAY_ONLY) expect(names).toContain(t);
      }),
    );
    await s.runner.start(runId);
    await until(() => s.p.agents.spawned.length > 0);
    // No worker starts until something is delegated.
    expect(s.p.agents.spawned.map((x) => x.definition.role)).toEqual(['orchestrator']);
    const orch = s.p.agents.spawned[0]!;
    expect(orch.definition.backend.common?.subAgents).toBeUndefined();
    expect(orch.systemPrompt).toContain('delegate_to_agent');
  });
});

describe('the prompt follows the mode', () => {
  const run = (delegation?: 'krama' | 'native') =>
    ({
      id: 'run_1',
      title: 'T',
      input: {},
      mode: 'review',
      orchestrator: {
        definitionId: 'orchestrator/default',
        backend: 'a2a-claude',
        ...(delegation ? { delegation } : {}),
      },
    }) as never;
  const roster = [
    { role: 'author', definition: { description: 'Writes' }, backend: 'a2a-codex', count: 1 },
  ] as never;

  it('treats a run without a recorded mode as the relay it was created under', () => {
    const text = renderOrchestratorPrompt({ run: run(), pack: pack(), roster });
    expect(text).toContain('delegate_to_agent');
  });

  it('tells a native orchestrator how to handle long jobs and that calls are not de-duplicated', () => {
    const text = renderOrchestratorPrompt({ run: run('native'), pack: pack(), roster });
    expect(text).toContain('task handle');
    expect(text).toContain('does not de-duplicate');
    expect(text).toContain('**author** — Writes');
  });
});
