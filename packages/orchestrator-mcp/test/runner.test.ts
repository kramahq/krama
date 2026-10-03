import { afterEach, describe, expect, it } from 'vitest';
import { renderOrchestratorPrompt } from '../src/index.js';
import { pack } from './rig.js';
import {
  call,
  newRun,
  playOrchestrator,
  statusOf,
  system,
  until,
  user,
  worker,
  type System,
} from './runner-rig.js';

const live: System[] = [];
const make = async (
  shared?: Parameters<typeof system>[0],
  policy?: object,
  packs?: Parameters<typeof system>[2],
) => {
  const s = await system(shared, policy, packs);
  live.push(s);
  return s;
};
afterEach(async () => {
  await Promise.allSettled(live.splice(0).map((s) => s.stop()));
});

const pendingDecision = async (s: System, runId: string) =>
  (await s.p.store.decisions.list({ runId, status: ['pending'] })).items[0]?.value.decision;
const orchestratorSends = (s: System) =>
  s.p.gateway.sent.filter((x) => x.agent.role === 'orchestrator');

describe('a run driven by the orchestrator agent', () => {
  it('starts the orchestrator with a methodology prompt and a scoped token, drives to the gate, and completes after approval', async () => {
    const s = await make();
    const runId = await newRun(s);
    s.p.gateway.queue('author', worker('Draft v1'));
    s.p.gateway.queue('reviewer', worker('Looks good'));
    s.p.gateway.queue(
      'orchestrator',
      playOrchestrator(s, async (c) => {
        expect((await call(c, 'get_run')).data.status).toBe('running');
        expect(
          (
            await call(c, 'delegate_to_agent', {
              phaseId: 'draft',
              role: 'author',
              task: 'Write notes',
            })
          ).data.status,
        ).toBe('completed');
        await call(c, 'record_phase_outcome', {
          phaseId: 'draft',
          status: 'success',
          reason: 'ok',
          gating: 'continue',
        });
        await call(c, 'delegate_to_agent', {
          phaseId: 'review',
          role: 'reviewer',
          task: 'Review notes',
        });
        const gated = (
          await call(c, 'record_phase_outcome', {
            phaseId: 'review',
            status: 'success',
            reason: 'good',
            gating: 'continue',
          })
        ).data;
        expect(gated.status).toBe('awaiting_decision');
      }),
    );
    await s.runner.start(runId);

    // The orchestrator turn ended with the run waiting on a person: the runner waits too, without nudging.
    await until(async () => (await statusOf(s, runId)) === 'awaiting_decision');
    await new Promise((r) => setTimeout(r, 150));
    expect(orchestratorSends(s)).toHaveLength(1);

    const spec = s.p.agents.spawned.find((x) => x.definition.role === 'orchestrator')!;
    expect(spec.definition.backend.wrapper).toBe('a2a-claude');
    expect(spec.systemPrompt).toContain('Publish approval');
    expect(spec.systemPrompt).toContain('**draft** (Draft)');
    expect(spec.mcp).toMatchObject({ krama: { type: 'http', url: `${s.url}/mcp` } });
    expect(spec.env?.KRAMA_MCP_TOKEN).toMatch(/^krm_/);
    expect(s.p.gateway.sent[0]!.text).toContain('get_run');

    const dec = await pendingDecision(s, runId);
    await s.engine.decisions.resolve(dec!.id, { optionId: 'approve' }, user);
    await until(async () => (await statusOf(s, runId)) === 'completed');
    await s.runner.idle(runId);

    // Everything is released: token revoked, orchestrator and worker agents stopped.
    expect(s.p.agents.list({ status: ['idle', 'busy', 'starting'] })).toEqual([]);
    expect(s.mcp.tokens.size).toBe(0);
    // The orchestrator's tool calls are in the activity feed as a participant.
    expect(s.errors).toEqual([]);
  });

  it('turns an orchestrator question into a Decision, then sends the answer back on the same conversation', async () => {
    const s = await make();
    const runId = await newRun(s);
    s.p.gateway.queue(
      'orchestrator',
      [
        { kind: 'state', state: 'working', taskId: 'o1', contextId: 'orch_ctx' },
        {
          kind: 'state',
          state: 'input_required',
          taskId: 'o1',
          contextId: 'orch_ctx',
          text: 'Which release channel: stable or beta?',
        },
      ],
      playOrchestrator(s, async (_c, m) => {
        expect(m.text).toContain('beta');
      }),
    );
    await s.runner.start(runId);
    await until(async () => Boolean(await pendingDecision(s, runId)));
    const dec = (await pendingDecision(s, runId))!;
    expect(dec).toMatchObject({
      kind: 'input',
      question: 'Which release channel: stable or beta?',
    });
    expect(await statusOf(s, runId)).toBe('awaiting_decision');
    await s.engine.decisions.resolve(dec.id, { optionId: 'answer', input: 'beta' }, user);
    await until(() => orchestratorSends(s).length >= 2);
    expect(orchestratorSends(s)[1]).toMatchObject({ contextId: 'orch_ctx' });
    expect(orchestratorSends(s)[1]!.text).toContain('A person answered your question');
    expect(orchestratorSends(s)[1]!.text).toContain('beta');
  });

  it("relays a person's change request at a gate back to the orchestrator and reopens the phase", async () => {
    const reviewGate = {
      ...pack(),
      methodology: {
        ...pack().methodology,
        gates: [
          {
            afterPhase: 'draft',
            kind: 'review' as const,
            policy: 'human_required' as const,
            label: 'Editor review',
          },
        ],
      },
    };
    const t = await make(undefined, {}, [reviewGate]);
    const runId = await newRun(t);
    t.p.gateway.queue(
      'orchestrator',
      playOrchestrator(t, async (c) => {
        await call(c, 'record_phase_outcome', {
          phaseId: 'draft',
          status: 'success',
          reason: 'drafted',
          gating: 'continue',
        });
      }),
      playOrchestrator(t, async (c, m) => {
        expect(m.text).toContain('Changes were requested on "Editor review"');
        expect(m.text).toContain('add upgrade notes');
        const st = (await call(c, 'get_run')).data;
        expect(st.phases[0]).toMatchObject({ id: 'draft', status: 'active', iteration: 2 });
      }),
    );
    await t.runner.start(runId);
    await until(async () => Boolean(await pendingDecision(t, runId)));
    await t.engine.decisions.resolve(
      (await pendingDecision(t, runId))!.id,
      { optionId: 'changes', input: 'add upgrade notes' },
      user,
    );
    await until(() => orchestratorSends(t).length >= 2);
    await until(
      async () => (await t.p.store.runs.get(runId))!.value.run.phases![0]!.iteration === 2,
    );
    expect(t.errors).toEqual([]);
  });
});

describe('an orchestrator that stops early, fails or is interrupted', () => {
  it('nudges twice, then parks the run as blocked with a reason instead of hanging', async () => {
    const s = await make();
    const runId = await newRun(s);
    s.p.gateway.queue(
      'orchestrator',
      playOrchestrator(s, async () => undefined),
      playOrchestrator(s, async () => undefined),
      playOrchestrator(s, async () => undefined),
    );
    await s.runner.start(runId);
    await until(async () => (await statusOf(s, runId)) === 'blocked');
    expect(orchestratorSends(s)).toHaveLength(3);
    expect(orchestratorSends(s)[1]!.text).toContain('the run is still running');
    expect((await s.p.store.runs.get(runId))!.value.run.statusReason).toContain(
      'did not continue when asked',
    );
  });

  it('a failed orchestrator turn blocks the run; resuming starts a fresh turn that continues', async () => {
    const s = await make();
    const runId = await newRun(s);
    s.p.gateway.queue('orchestrator', [
      { kind: 'state', state: 'working', taskId: 'o1' },
      { kind: 'state', state: 'failed', taskId: 'o1', text: 'rate limited' },
    ]);
    await s.runner.start(runId);
    await until(async () => (await statusOf(s, runId)) === 'blocked');
    expect((await s.p.store.runs.get(runId))!.value.run.statusReason).toContain('rate limited');
    await s.runner.idle(runId);

    s.p.gateway.queue(
      'orchestrator',
      playOrchestrator(
        s,
        async (c, m) => {
          expect(m.text).toContain('resumed');
          await call(c, 'record_phase_outcome', {
            phaseId: 'draft',
            status: 'success',
            reason: 'ok',
            gating: 'continue',
          });
        },
        { state: 'input_required', text: 'Waiting for you' },
      ),
    );
    await s.runner.resume(runId);
    await until(async () => Boolean(await pendingDecision(s, runId)));
    expect(await statusOf(s, runId)).toBe('awaiting_decision');
  });

  it('pausing ends the orchestrator turn; resuming continues it on the same agent and conversation', async () => {
    const s = await make();
    const runId = await newRun(s);
    let started = false;
    s.p.gateway.queue(
      'orchestrator',
      async function* (message) {
        yield { kind: 'state', state: 'working', taskId: 'o1', contextId: 'orch_ctx' } as const;
        started = true;
        await new Promise<void>((resolve) =>
          message.signal?.addEventListener('abort', () => resolve()),
        );
      },
      playOrchestrator(
        s,
        async (_c, m) => {
          expect(m.text).toContain('resumed');
        },
        { state: 'input_required', text: 'done for now' },
      ),
    );
    await s.runner.start(runId);
    await until(() => started);
    await s.engine.runs.pause(runId, user);
    await until(
      () => orchestratorSends(s).length === 1 && s.runner['drives'].get(runId)?.turn === undefined,
    );
    expect(await statusOf(s, runId)).toBe('paused');
    await s.runner.resume(runId, user);
    await until(() => orchestratorSends(s).length >= 2);
    expect(orchestratorSends(s)[1]).toMatchObject({ contextId: 'orch_ctx' });
    expect(s.p.agents.spawned.filter((x) => x.definition.role === 'orchestrator')).toHaveLength(1);
  });

  it('stopping a run ends the drive and releases its agents and token', async () => {
    const s = await make();
    const runId = await newRun(s);
    let started = false;
    s.p.gateway.queue('orchestrator', async function* (message) {
      yield { kind: 'state', state: 'working', taskId: 'o1' } as const;
      started = true;
      await new Promise<void>((resolve) =>
        message.signal?.addEventListener('abort', () => resolve()),
      );
    });
    await s.runner.start(runId);
    await until(() => started);
    await s.engine.runs.stop(runId, user);
    await s.runner.idle(runId);
    expect(await statusOf(s, runId)).toBe('stopped');
    expect(s.p.agents.list({ status: ['idle', 'busy'] })).toEqual([]);
    expect(s.mcp.tokens.size).toBe(0);
  });
});

describe('restart in the middle of a phase', () => {
  it('resumes without duplicating a delegation that already completed', async () => {
    const s1 = await make();
    const runId = await newRun(s1);
    const authorTask = 'Write the release notes for 1.2';
    s1.p.gateway.queue('author', worker('Draft v1'));
    let crashed = false;
    s1.p.gateway.queue(
      'orchestrator',
      playOrchestrator(s1, async (c, m) => {
        const d = (
          await call(c, 'delegate_to_agent', { phaseId: 'draft', role: 'author', task: authorTask })
        ).data;
        expect(d.status).toBe('completed');
        crashed = true; // the server dies here: the verdict was never recorded
        await new Promise<void>((resolve) => m.signal?.addEventListener('abort', () => resolve()));
      }),
    );
    await s1.runner.start(runId);
    await until(() => crashed);
    // A step is left half-way: simulate the one that was in flight when the process died.
    await s1.p.store.steps.put({
      id: 'step_inflight',
      runId,
      phaseId: 'draft',
      agent: { id: 'agt_x', role: 'author', backend: 'a2a-codex' },
      summary: 'in flight',
      status: 'working',
      a2a: { resumed: false },
    } as never);

    // Crash: the first server's process memory is gone; only the store, events and artifacts survive.
    await s1.mcp.close();
    const s2 = await make(s1.p);
    expect(await s2.engine.runs.markInterrupted()).toEqual([runId]);
    expect(await statusOf(s2, runId)).toBe('interrupted');

    s2.p.gateway.queue(
      'orchestrator',
      playOrchestrator(
        s2,
        async (c, m) => {
          expect(m.text).toContain('interrupted');
          const st = (await call(c, 'get_run')).data;
          expect(st.phases[0]).toMatchObject({ id: 'draft', status: 'active' });
          // The new orchestrator does not know the delegation finished, so it asks again. The platform answers from the record.
          const again = (
            await call(c, 'delegate_to_agent', {
              phaseId: 'draft',
              role: 'author',
              task: authorTask,
            })
          ).data;
          expect(again).toMatchObject({ status: 'completed', cached: true, answer: 'Draft v1' });
          await call(c, 'record_phase_outcome', {
            phaseId: 'draft',
            status: 'success',
            reason: 'ok',
            gating: 'continue',
          });
        },
        { state: 'input_required', text: 'Handing over' },
      ),
    );
    await s2.runner.resume(runId);
    await until(
      async () => (await s2.p.store.runs.get(runId))!.value.run.phases![0]!.status === 'completed',
    );

    expect(s2.p.gateway.sent.filter((x) => x.agent.role === 'author')).toHaveLength(1); // one author turn across both lives
    expect((await s2.p.store.steps.get('step_inflight'))!.value.status).toBe('failed'); // orphan marked so it can be retried
    expect(
      (await s2.p.store.steps.listByRun(runId)).filter((x) => x.status === 'completed'),
    ).toHaveLength(1);
    s1.p.gateway.sent.length = 0;
    expect(s2.errors).toEqual([]);
  });

  it('recoverAll resumes every interrupted run', async () => {
    const s = await make();
    const a = await newRun(s, 'a');
    const b = await newRun(s, 'b');
    await s.engine.runs.plan(a);
    await s.engine.runs.plan(b);
    await s.engine.runs.markInterrupted();
    s.p.gateway.queue(
      'orchestrator',
      playOrchestrator(s, async () => undefined, { state: 'input_required', text: 'x' }),
      playOrchestrator(s, async () => undefined, { state: 'input_required', text: 'y' }),
    );
    expect((await s.runner.recoverAll()).sort()).toEqual([a, b].sort());
    await until(() => orchestratorSends(s).length >= 2);
  });
});

describe('the orchestrator prompt', () => {
  const run = (over = {}) =>
    ({
      id: 'run_1',
      title: 'Release notes',
      input: { text: 'Write notes for 1.2', params: { audience: 'customers' } },
      mode: 'review',
      ...over,
    }) as never;
  const roster = [
    {
      role: 'author',
      definition: { description: 'Writes the draft' },
      backend: 'a2a-codex',
      count: 2,
      alternatives: [],
    },
  ] as never;

  it('is neutral: the core names no domain, the pack supplies the methodology', () => {
    const p = renderOrchestratorPrompt({ run: run(), pack: pack(), roster });
    for (const word of ['jira', 'sdlc', 'agile', 'sprint', 'bitbucket', 'github', 'story'])
      expect(p.toLowerCase(), word).not.toContain(word);
    expect(p).toContain('get_run');
    expect(p).toContain('record_phase_outcome');
    expect(p).toContain('Write notes for 1.2');
    expect(p).toContain('"audience": "customers"');
    expect(p).toContain('**draft** (Draft) — roles: author');
    expect(p).toContain('After **review**: Publish approval (approval, human required)');
    expect(p).toContain(
      '**reviewer** checks the work of **author**; at most 2 automated revisions',
    );
    expect(p).toContain('**author** — Writes the draft (backend a2a-codex, up to 2 at once)');
  });

  it('adds the pack guidance and terminology, and describes the mode', () => {
    const p = pack();
    p.methodology.guidance = 'Write for customers. Keep it short.';
    p.ui = { terminology: { run: 'Delivery' } };
    const text = renderOrchestratorPrompt({ run: run({ mode: 'autopilot' }), pack: p, roster });
    expect(text).toContain('## Methodology guidance\n\nWrite for customers. Keep it short.');
    expect(text).toContain('## This delivery: Release notes');
    expect(text).toContain('review gates are auto-approved; approval gates still need a person');
  });
});
