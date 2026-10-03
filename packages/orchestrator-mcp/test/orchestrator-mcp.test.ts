import { afterEach, describe, expect, it } from 'vitest';
import { TokenRegistry, mcpEntryFor } from '../src/index.js';
import { call, connect, rig, type Rig } from './rig.js';

const open: Rig[] = [];
const make = async (o?: Parameters<typeof rig>[0]) => {
  const r = await rig(o);
  open.push(r);
  return r;
};
afterEach(async () => {
  await Promise.all(open.splice(0).map((r) => r.close()));
});

const raw = (r: Rig, init: RequestInit & { path?: string; token?: string | null } = {}) =>
  fetch(`${r.url}${init.path ?? '/mcp'}`, {
    method: init.method ?? 'POST',
    ...(init.method === 'GET'
      ? {}
      : { body: init.body ?? JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) }),
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(init.token === null ? {} : { authorization: `Bearer ${init.token ?? r.token}` }),
      ...(init.headers as Record<string, string> | undefined),
    },
  });

describe('authentication and transport', () => {
  it('rejects missing, wrong, expired and revoked tokens', async () => {
    const r = await make();
    expect((await raw(r, { token: null })).status).toBe(401);
    expect((await raw(r, { token: 'krm_wrong' })).status).toBe(401);
    expect((await raw(r)).status).toBe(200);
    expect(r.mcp.tokens.revokeRun(r.runId)).toBe(1);
    expect((await raw(r)).status).toBe(401);

    let now = 1000;
    const reg = new TokenRegistry(() => now);
    const t = reg.issue('run_1', 50);
    expect(reg.verify(t)).toMatchObject({ runId: 'run_1', role: 'orchestrator' });
    now += 100;
    expect(reg.verify(t)).toBeUndefined();
    expect(reg.size).toBe(0);
  });

  it('only accepts POST /mcp from loopback hosts with a sane body', async () => {
    const r = await make();
    expect((await raw(r, { method: 'GET' })).status).toBe(405);
    expect((await raw(r, { path: '/other' })).status).toBe(404);
    expect((await raw(r, { body: '{not json' })).status).toBe(400);
    expect((await raw(r, { body: 'x'.repeat(1024 * 1024 + 10) })).status).toBe(413);
  });

  it('never stores a token itself, only its hash, and builds the agent MCP entry with an env reference', () => {
    const reg = new TokenRegistry();
    const t = reg.issue('run_1');
    expect(
      JSON.stringify([...(reg as unknown as { byHash: Map<string, unknown> }).byHash.keys()]),
    ).not.toContain(t);
    expect(mcpEntryFor('http://127.0.0.1:4100/', t)).toEqual({
      mcp: {
        krama: {
          type: 'http',
          url: 'http://127.0.0.1:4100/mcp',
          headers: { Authorization: 'Bearer ${KRAMA_MCP_TOKEN}' },
        },
      },
      env: { KRAMA_MCP_TOKEN: t },
    });
  });
});

describe('an MCP client drives a whole run', () => {
  it('lists the orchestration verbs', async () => {
    const r = await make();
    const names = (await r.client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'delegate_to_agent',
      'get_artifact',
      'get_budget',
      'get_run',
      'query_agents',
      'record_phase_outcome',
      'request_decision',
      'store_artifact',
    ]);
  });

  it('plans from the roster, delegates, loops once, hits the gate, and completes after a person approves', async () => {
    const r = await make();
    const c = r.client;

    const state0 = (await call(c, 'get_run')).data;
    expect(state0).toMatchObject({ runId: r.runId, status: 'running', currentPhaseIds: ['draft'] });
    expect(state0.phases.map((p: { id: string; status: string }) => `${p.id}:${p.status}`)).toEqual(
      ['draft:active', 'review:pending'],
    );

    const roster = (await call(c, 'query_agents')).data;
    expect(
      roster.roles.map(
        (x: { role: string; selected: { definitionId: string; backend: string } }) =>
          `${x.role}=${x.selected.definitionId}@${x.selected.backend}`,
      ),
    ).toEqual(['author=author/default@a2a-codex', 'reviewer=reviewer/default@a2a-claude']);

    // Author drafts.
    r.p.gateway.queue('author', [
      { kind: 'state', state: 'working', taskId: 't1', contextId: 'ctx_a' },
      { kind: 'sideband', type: 'tool_call', toolName: 'fs.write', text: 'fs.write notes.md' },
      {
        kind: 'artifact',
        name: 'response',
        mediaType: 'text/plain',
        bytes: new TextEncoder().encode('Draft v1'),
      },
      { kind: 'usage', usage: [{ unit: 'tokens', quantity: 500 }], cost: null },
      { kind: 'state', state: 'completed', taskId: 't1', contextId: 'ctx_a' },
    ]);
    const d1 = (
      await call(c, 'delegate_to_agent', {
        phaseId: 'draft',
        role: 'author',
        task: 'Write release notes for 1.2',
      })
    ).data;
    expect(d1).toMatchObject({
      status: 'completed',
      answer: 'Draft v1',
      contextId: 'ctx_a',
      cost: null,
      usage: [{ unit: 'tokens', quantity: 500 }],
    });
    expect(d1.artifacts).toHaveLength(1);
    expect(r.p.agents.spawned[0]).toMatchObject({
      workspace: { mode: 'shared', key: r.runId },
      systemPrompt: 'You write.',
    });

    const advanced = (
      await call(c, 'record_phase_outcome', {
        phaseId: 'draft',
        status: 'success',
        reason: 'Looks complete',
        gating: 'continue',
      })
    ).data;
    expect(
      advanced.phases.map((p: { id: string; status: string }) => `${p.id}:${p.status}`),
    ).toEqual(['draft:completed', 'review:active']);

    // Reviewer sends it back; the engine reopens the producer phase.
    r.p.gateway.queue('reviewer', [
      { kind: 'state', state: 'completed', taskId: 't2', contextId: 'ctx_r' },
    ]);
    await call(c, 'delegate_to_agent', {
      phaseId: 'review',
      role: 'reviewer',
      task: 'Review the notes',
    });
    const looped = (
      await call(c, 'record_phase_outcome', {
        phaseId: 'review',
        status: 'partial',
        reason: 'Missing upgrade notes',
        gating: 'loop_back',
        loopTarget: 'draft',
        feedback: 'Add upgrade notes',
        findings: [{ severity: 'major', title: 'No upgrade section' }],
      })
    ).data;
    expect(
      looped.phases.map(
        (p: { id: string; status: string; iteration: number }) =>
          `${p.id}:${p.status}:${p.iteration}`,
      ),
    ).toEqual(['draft:active:2', 'review:looping:1']);

    // The author's second turn resumes its conversation and reuses the same agent instance.
    r.p.gateway.queue('author', [
      { kind: 'state', state: 'completed', taskId: 't3', contextId: 'ctx_a' },
    ]);
    await call(c, 'delegate_to_agent', {
      phaseId: 'draft',
      role: 'author',
      task: 'Add upgrade notes',
    });
    expect(r.p.gateway.sent.filter((s) => s.agent.role === 'author')).toHaveLength(2);
    expect(r.p.agents.spawned.filter((s) => s.definition.role === 'author')).toHaveLength(1);
    await call(c, 'record_phase_outcome', {
      phaseId: 'draft',
      status: 'success',
      reason: 'Fixed',
      gating: 'continue',
    });
    const gated = (
      await call(c, 'record_phase_outcome', {
        phaseId: 'review',
        status: 'success',
        reason: 'Good now',
        gating: 'continue',
      })
    ).data;
    expect(gated.status).toBe('awaiting_decision');
    expect(gated.pendingDecisions).toEqual([
      expect.objectContaining({ kind: 'approval', title: 'Publish approval' }),
    ]);

    // A person approves through the platform; the run completes.
    await r.engine.decisions.resolve(
      gated.pendingDecisions[0].id,
      { optionId: 'approve' },
      { type: 'user', id: 'u1' },
    );
    expect((await call(c, 'get_run')).data.status).toBe('completed');
  });

  it('asks a person a question with only engine-implemented options, and the run waits', async () => {
    const r = await make();
    const asked = (
      await call(r.client, 'request_decision', {
        kind: 'input',
        title: 'Which auth flow?',
        question: 'API keys or **OAuth**?',
        phaseId: 'draft',
        options: [
          { id: 'oauth', label: 'OAuth', style: 'primary', effect: 'answer' },
          { id: 'keys', label: 'API keys', effect: 'answer' },
        ],
      })
    ).data;
    expect(asked).toMatchObject({ status: 'pending' });
    const state = (await call(r.client, 'get_run')).data;
    expect(state.status).toBe('awaiting_decision');
    expect(state.pendingDecisions[0]).toMatchObject({ id: asked.decisionId, kind: 'input' });
    await r.engine.decisions.resolve(
      asked.decisionId,
      { optionId: 'oauth' },
      { type: 'user', id: 'u1' },
    );
    expect((await call(r.client, 'get_run')).data.status).toBe('running');
  });

  it('stores and reads artifacts, with versions and paging', async () => {
    const r = await make();
    const a1 = (
      await call(r.client, 'store_artifact', {
        name: 'plan.md',
        text: '# Plan\n' + 'x'.repeat(300),
        phaseId: 'draft',
      })
    ).data;
    expect(a1).toMatchObject({ version: 1, size: 307 });
    const a2 = (
      await call(r.client, 'store_artifact', {
        name: 'plan.md',
        text: '# Plan v2',
        supersedes: a1.id,
      })
    ).data;
    expect(a2.version).toBe(2);
    const read = (await call(r.client, 'get_artifact', { artifactId: a1.id, maxBytes: 100 })).data;
    expect(read).toMatchObject({
      truncated: true,
      mediaType: 'text/markdown',
      status: 'superseded',
    });
    expect(read.text).toHaveLength(100);
    const rest = (await call(r.client, 'get_artifact', { artifactId: a1.id, offset: 100 })).data;
    expect(rest).toMatchObject({ truncated: false, offset: 100 });
    const bin = (
      await call(r.client, 'store_artifact', {
        name: 'a.bin',
        mediaType: 'application/octet-stream',
        base64: Buffer.from([1, 2, 3]).toString('base64'),
      })
    ).data;
    expect((await call(r.client, 'get_artifact', { artifactId: bin.id })).data.base64).toBe('AQID');
    expect(
      (await r.p.events.read({ topics: [`run:${r.runId}`] })).filter(
        (e) => e.type === 'artifact.created',
      ),
    ).toHaveLength(3);
  });

  it('reports the budget with unreported cost as null, and usage by unit', async () => {
    const r = await make();
    await r.engine.budget.record({
      runId: r.runId,
      phaseId: 'draft',
      cost: null,
      usage: [
        { unit: 'tokens', quantity: 900 },
        { unit: 'credits', quantity: 2 },
      ],
    });
    const b = (await call(r.client, 'get_budget')).data;
    expect(b).toMatchObject({
      spent: null,
      percentUsed: null,
      status: 'unknown',
      max: { amount: 10 },
      costReported: false,
      usage: [
        { unit: 'tokens', quantity: 900 },
        { unit: 'credits', quantity: 2 },
      ],
    });
    await r.engine.budget.record({
      runId: r.runId,
      phaseId: 'draft',
      cost: { amount: 8.5, currency: 'USD' },
    });
    expect((await call(r.client, 'get_budget')).data).toMatchObject({
      spent: { amount: 8.5 },
      percentUsed: 85,
      status: 'warn',
      costReported: true,
    });
  });
});

describe('invariant violations come back as typed errors', () => {
  it('delegating to a phase that is not active', async () => {
    const r = await make();
    const e = await call(r.client, 'delegate_to_agent', {
      phaseId: 'review',
      role: 'reviewer',
      task: 'x',
    });
    expect(e).toMatchObject({
      ok: false,
      data: { code: 'invalid_transition', problemCode: 'conflict' },
    });
    expect(r.p.gateway.sent).toHaveLength(0);
  });

  it('an unknown role lists the roles that exist', async () => {
    const r = await make();
    const e = await call(r.client, 'delegate_to_agent', {
      phaseId: 'draft',
      role: 'wizard',
      task: 'x',
    });
    expect(e.data).toMatchObject({
      code: 'not_found',
      details: { role: 'wizard', roles: ['author', 'reviewer'] },
    });
  });

  it('a disallowed backend and an unusable backend are refused before anything starts', async () => {
    const a = await make({ policy: { allowedBackends: ['a2a-claude'] } });
    expect(
      (await call(a.client, 'delegate_to_agent', { phaseId: 'draft', role: 'author', task: 'x' }))
        .data.code,
    ).toBe('backend_not_allowed');
    const b = await make();
    b.directory.unusable.add('a2a-codex');
    const e = await call(b.client, 'delegate_to_agent', {
      phaseId: 'draft',
      role: 'author',
      task: 'x',
    });
    expect(e.data.code).toBe('roster_unsatisfied');
    expect(b.p.agents.spawned).toHaveLength(0);
  });

  it('delegation stops when the run is paused or the budget cap is reached', async () => {
    const r = await make();
    await r.engine.runs.pause(r.runId, { type: 'user', id: 'u1' });
    expect(
      (await call(r.client, 'delegate_to_agent', { phaseId: 'draft', role: 'author', task: 'x' }))
        .data.code,
    ).toBe('invalid_transition');
  });

  it('refuses a verdict on a phase that is not active, and cannot skip a required gate', async () => {
    const r = await make();
    expect(
      (
        await call(r.client, 'record_phase_outcome', {
          phaseId: 'review',
          status: 'success',
          reason: 'x',
          gating: 'continue',
        })
      ).data.code,
    ).toBe('invalid_transition');
    await call(r.client, 'record_phase_outcome', {
      phaseId: 'draft',
      status: 'success',
      reason: 'x',
      gating: 'continue',
    });
    const gated = (
      await call(r.client, 'record_phase_outcome', {
        phaseId: 'review',
        status: 'success',
        reason: 'x',
        gating: 'continue',
      })
    ).data;
    expect(gated.status).toBe('awaiting_decision');
    // Recording again cannot get past the gate.
    expect(
      (
        await call(r.client, 'record_phase_outcome', {
          phaseId: 'review',
          status: 'success',
          reason: 'x',
          gating: 'continue',
        })
      ).data.code,
    ).toBe('invalid_transition');
  });

  it('the automated loop cap halts the run (blocked) whatever the orchestrator wants', async () => {
    const r = await make();
    for (let i = 0; i < 2; i++) {
      await call(r.client, 'record_phase_outcome', {
        phaseId: 'draft',
        status: 'success',
        reason: 'x',
        gating: 'continue',
      });
      await call(r.client, 'record_phase_outcome', {
        phaseId: 'review',
        status: 'partial',
        reason: 'again',
        gating: 'loop_back',
        loopTarget: 'draft',
      });
    }
    await call(r.client, 'record_phase_outcome', {
      phaseId: 'draft',
      status: 'success',
      reason: 'x',
      gating: 'continue',
    });
    const last = (
      await call(r.client, 'record_phase_outcome', {
        phaseId: 'review',
        status: 'partial',
        reason: 'again',
        gating: 'loop_back',
        loopTarget: 'draft',
      })
    ).data;
    expect(last).toMatchObject({
      status: 'blocked',
      statusReason: expect.stringContaining('Maximum feedback loop iterations exceeded'),
    });
  });

  it('options with an effect the platform does not implement are refused by the schema', async () => {
    const r = await make();
    await expect(
      r.client.callTool({
        name: 'request_decision',
        arguments: {
          kind: 'input',
          title: 't',
          question: 'q',
          options: [{ id: 'yolo', label: 'YOLO', effect: 'deploy_to_prod' }],
        },
      }),
    ).resolves.toMatchObject({ isError: true });
    expect((await r.p.store.decisions.list({})).items).toHaveLength(0);
  });

  it('argument problems are typed too', async () => {
    const r = await make();
    expect(
      (await call(r.client, 'store_artifact', { name: 'x', text: 'a', base64: 'AA==' })).data.code,
    ).toBe('invalid_argument');
    expect((await call(r.client, 'store_artifact', { name: 'x' })).data.code).toBe(
      'invalid_argument',
    );
    expect(
      (
        await call(r.client, 'request_decision', {
          kind: 'input',
          title: 't',
          question: 'q',
          phaseId: 'nope',
          options: [{ id: 'a', label: 'A', effect: 'answer' }],
        })
      ).data.code,
    ).toBe('invalid_argument');
  });
});

describe('a token is scoped to one run', () => {
  it('cannot read, supersede or even detect artifacts of another run', async () => {
    const r = await make();
    const other = await r.engine.runs.create(
      { packId: 'pack_demo', input: {} },
      { type: 'user', id: 'u1' },
    );
    const foreign = await r.p.artifacts.put({
      runId: other.id,
      name: 'secret.md',
      type: 'doc',
      mediaType: 'text/markdown',
      producer: { type: 'user', id: 'u1' },
      bytes: new TextEncoder().encode('secret'),
    });
    expect((await call(r.client, 'get_artifact', { artifactId: foreign.id })).data.code).toBe(
      'not_found',
    );
    expect((await call(r.client, 'get_artifact', { artifactId: 'art_nope' })).data.code).toBe(
      'not_found',
    ); // same answer: no probing
    expect(
      (await call(r.client, 'store_artifact', { name: 'x', text: 'x', supersedes: foreign.id }))
        .data.code,
    ).toBe('out_of_scope');
  });

  it('a second token for another run acts only on that run', async () => {
    const r = await make();
    const other = await r.engine.runs.create(
      { packId: 'pack_demo', input: { text: 'other' } },
      { type: 'user', id: 'u1' },
    );
    const c2 = await connect(r.url, r.mcp.tokens.issue(other.id));
    try {
      expect((await call(c2, 'get_run')).data).toMatchObject({
        runId: other.id,
        status: 'planning',
      });
      expect((await call(r.client, 'get_run')).data.runId).toBe(r.runId);
    } finally {
      await c2.close();
    }
  });
});

describe('retries', () => {
  it('joins an identical in-flight delegation instead of starting a second', async () => {
    const r = await make();
    let sends = 0;
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    r.p.gateway.send = async function* () {
      sends++;
      await gate;
      yield { kind: 'state' as const, state: 'completed' as const, taskId: 't' };
    };
    const args = { phaseId: 'draft', role: 'author', task: 'Write it' };
    const [a, b] = [
      call(r.client, 'delegate_to_agent', args),
      connect(r.url, r.token).then((c2) => call(c2, 'delegate_to_agent', args)),
    ];
    await new Promise((x) => setTimeout(x, 150));
    release();
    const [ra, rb] = await Promise.all([a, b]);
    expect(sends).toBe(1);
    expect(ra.data.stepId).toBe(rb.data.stepId);
  });
});
