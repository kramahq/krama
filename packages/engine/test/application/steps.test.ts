import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Project } from '@kramahq/contract';
import { describe, expect, it } from 'vitest';
import type { AgentRef, GatewayEvent } from '../../src/index.js';
import { ok, priya, setup } from './helpers.js';

const replay = (file: string): GatewayEvent[] =>
  readFileSync(fileURLToPath(new URL(`../fixtures/${file}`, import.meta.url)), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const e = JSON.parse(l) as GatewayEvent & { text?: string };
      return e.kind === 'artifact' && typeof (e as { text?: string }).text === 'string'
        ? { ...e, bytes: new TextEncoder().encode((e as { text: string }).text) }
        : e;
    });

const agent: AgentRef = {
  id: 'agt_1',
  url: 'http://127.0.0.1:1',
  role: 'author',
  backend: 'a2a-copilot',
};

const started = async (policy = {}) => {
  const h = setup(undefined, policy);
  const run = await h.engine.runs.create(
    { packId: 'pack_demo', input: { text: 'x' }, budget: { max: 10 } },
    priya,
  );
  await h.engine.runs.plan(run.id);
  return { h, run };
};
const activityOf = async (h: Awaited<ReturnType<typeof started>>['h'], runId: string) =>
  (await h.p.events.read({ topics: [`run:${runId}`] })).filter((e) =>
    e.type.startsWith('activity.'),
  );

describe('delegating a step: a recorded session becomes an activity feed, artifacts and usage', () => {
  it('replays a Copilot-style session into the expected feed and totals', async () => {
    const { h, run } = await started();
    h.p.gateway.queue('author', replay('copilot-session.ndjson'));
    const r = await h.engine.steps.delegate({
      runId: run.id,
      phaseId: 'draft',
      agent,
      text: 'Fix the failing auth test',
    });

    expect(r.status).toBe('completed');
    expect(r.answer).toBe('Fixed: scopes are now required.');
    expect(r.step).toMatchObject({
      status: 'completed',
      agent: { role: 'author', backend: 'a2a-copilot' },
      a2a: { taskId: 'task_9', contextId: 'ctx_9', resumed: false },
    });

    // The feed, in order, with the wrapper's own fields preserved.
    const feed = await activityOf(h, run.id);
    expect(feed.map((e) => `${e.type}:${(e.data as { kind: string }).kind}`)).toEqual([
      'activity.status:thinking',
      'activity.tool_call:tool_call',
      'activity.tool_result:tool_result',
      'activity.tool_call:tool_call',
      'activity.tool_result:tool_result',
      'activity.status:status',
      'activity.status:status',
    ]);
    expect(feed[3]!.data).toMatchObject({
      toolName: 'shell.run',
      stepId: r.step.id,
      phaseId: 'draft',
      agent: { role: 'author' },
    });
    expect(feed[4]!.data).toMatchObject({ toolName: 'shell.run', isError: true, durationMs: 2870 });
    // Unknown sideband types are preserved (raw), not dropped.
    expect(JSON.parse((feed[6]!.data as { raw: string }).raw)).toEqual({
      name: 'trace.brand-new',
      extra: 1,
    });

    // Artifacts are stored and announced, and linked to the phase.
    expect(r.artifacts.map((a) => `${a.name}:${a.mediaType}`)).toEqual([
      'response:text/plain',
      'report:application/json',
    ]);
    expect(new TextDecoder().decode((await h.p.artifacts.read(r.artifacts[0]!.id))!.bytes)).toBe(
      'Fixed: scopes are now required.',
    );
    expect(
      (await h.p.events.read({ topics: [`run:${run.id}`] })).filter(
        (e) => e.type === 'artifact.created',
      ),
    ).toHaveLength(2);
    const phase = (await h.p.store.runs.get(run.id))!.value.run.phases!.find(
      (p) => p.id === 'draft',
    )!;
    expect(phase.stepIds).toEqual([r.step.id]);
    expect(phase.artifactIds).toHaveLength(2);

    // Usage is unit-aware per step and in the ledger; cost is null because the provider reported none in USD.
    expect(r.usage).toEqual([
      { unit: 'tokens', quantity: 1300 },
      { unit: 'calls', quantity: 3 },
      { unit: 'credits', quantity: 1.5 },
    ]);
    const step = (await h.p.store.steps.get(r.step.id))!.value;
    expect(step.usage).toEqual(r.usage);
    expect(step.cost ?? null).toBeNull();
    const run2 = (await h.p.store.runs.get(run.id))!.value.run;
    expect(run2.budget.spent).toBeNull();
    expect(await h.p.store.usage.forRun(run.id)).toHaveLength(1);
    expect(
      (await h.p.events.read({ topics: [`run:${run.id}`] })).filter(
        (e) => e.type === 'cost.updated',
      ),
    ).toHaveLength(1);
    const types = (await h.p.events.read({ topics: [`run:${run.id}`] })).map((e) => e.type);
    expect(types.indexOf('step.started')).toBeLessThan(types.indexOf('activity.tool_call'));
    expect(types.at(-1)).toBe('step.completed');
  });

  it('accumulates dollar cost per step, phase, run and project when the provider reports it', async () => {
    const { h, run } = await started();
    const project = {
      id: 'proj_1',
      name: 'p',
      budget: { max: { amount: 100, currency: 'USD' }, spent: null },
      createdAt: 't',
      links: {},
    } as unknown as Project;
    await h.p.store.projects.put(project);
    const rec = (await h.p.store.runs.get(run.id))!;
    rec.value.run.projectId = 'proj_1';
    await h.p.store.runs.put(rec.value, rec.version);
    for (const amount of [1.25, 0.75]) {
      h.p.gateway.queue('author', [
        { kind: 'state', state: 'working', taskId: 't' },
        {
          kind: 'usage',
          usage: [{ unit: 'usd', quantity: amount }],
          cost: { amount, currency: 'USD' },
        },
        { kind: 'state', state: 'completed', taskId: 't' },
      ]);
      await h.engine.steps.delegate({ runId: run.id, phaseId: 'draft', agent, text: 'go' });
    }
    const after = (await h.p.store.runs.get(run.id))!.value.run;
    expect(after.budget.spent?.amount).toBe(2);
    expect(after.phases!.find((p) => p.id === 'draft')!.cost?.amount).toBe(2);
    expect((await h.p.store.projects.get('proj_1'))!.value.budget?.spent?.amount).toBe(2);
    const steps = await h.p.store.steps.listByRun(run.id);
    expect(steps.map((s) => s.cost?.amount).sort()).toEqual([0.75, 1.25]);
  });
});

describe('step outcomes', () => {
  it('surfaces input-required with the question and leaves the step open for the orchestrator', async () => {
    const { h, run } = await started();
    h.p.gateway.queue('author', [
      { kind: 'state', state: 'working', taskId: 't1', contextId: 'c1' },
      {
        kind: 'state',
        state: 'input_required',
        taskId: 't1',
        contextId: 'c1',
        text: 'API keys or OAuth?',
      },
    ]);
    const r = await h.engine.steps.delegate({
      runId: run.id,
      phaseId: 'draft',
      agent,
      text: 'build auth',
    });
    expect(r).toMatchObject({
      status: 'input_required',
      question: 'API keys or OAuth?',
      step: { a2a: { contextId: 'c1' } },
    });
    expect((await h.p.events.read({ topics: [`run:${run.id}`] })).at(-1)).toMatchObject({
      type: 'step.completed',
      data: { status: 'input_required', question: 'API keys or OAuth?' },
    });
  });

  it('resumes a conversation and records it on the step', async () => {
    const { h, run } = await started();
    h.p.gateway.queue('author', [
      { kind: 'state', state: 'completed', taskId: 't2', contextId: 'c1' },
    ]);
    const r = await h.engine.steps.delegate({
      runId: run.id,
      phaseId: 'draft',
      agent,
      text: 'use OAuth',
      contextId: 'c1',
    });
    expect(r.step.a2a).toMatchObject({ resumed: true, contextId: 'c1' });
    expect(h.p.gateway.sent[0]!.text).toBe('use OAuth');
  });

  it('records failed, timed-out and canceled steps with the reason', async () => {
    for (const state of ['failed', 'timed_out', 'canceled'] as const) {
      const { h, run } = await started();
      h.p.gateway.queue('author', [
        { kind: 'state', state: 'working', taskId: 't' },
        { kind: 'state', state, taskId: 't', text: `why ${state}` },
      ]);
      const r = await h.engine.steps.delegate({
        runId: run.id,
        phaseId: 'draft',
        agent,
        text: 'x',
      });
      expect(r).toMatchObject({ status: state, error: `why ${state}` });
      expect((await h.p.events.read({ topics: [`run:${run.id}`] })).at(-1)?.type, state).toBe(
        'step.failed',
      );
    }
  });

  it('turns an unreachable agent into a failed step instead of throwing', async () => {
    const { h, run } = await started();
    h.p.gateway.send = () => {
      throw new Error('Cannot reach author');
    };
    const r = await h.engine.steps.delegate({ runId: run.id, phaseId: 'draft', agent, text: 'x' });
    expect(r).toMatchObject({ status: 'failed', error: 'Cannot reach author' });
    expect((await h.p.store.steps.get(r.step.id))!.value.status).toBe('failed');
  });

  it('a stream that ends with no final state is a failure, never a silent success', async () => {
    const { h, run } = await started();
    h.p.gateway.queue('author', [{ kind: 'state', state: 'working', taskId: 't' }]);
    expect(
      await h.engine.steps.delegate({ runId: run.id, phaseId: 'draft', agent, text: 'x' }),
    ).toMatchObject({ status: 'failed', error: expect.stringContaining('final state') });
  });

  it('keeps big payloads out of the feed (the full content lives in artifacts)', async () => {
    const { h, run } = await started();
    h.p.gateway.queue('author', [
      { kind: 'state', state: 'working', taskId: 't' },
      {
        kind: 'sideband',
        type: 'message',
        text: 'x'.repeat(10_000),
        raw: { big: 'y'.repeat(10_000) },
      },
      { kind: 'state', state: 'completed', taskId: 't' },
    ]);
    await h.engine.steps.delegate({ runId: run.id, phaseId: 'draft', agent, text: 'x' });
    const ev = (await activityOf(h, run.id))[0]!;
    expect(ev.type).toBe('activity.message');
    expect(JSON.stringify(ev.data).length).toBeLessThan(7000);
    expect((ev.data as { text: string }).text).toContain('more)');
  });
});

describe('engine-enforced preconditions on delegation', () => {
  it('refuses a backend outside the allow-list', async () => {
    const { h, run } = await started({ allowedBackends: ['a2a-claude'] });
    await expect(
      h.engine.steps.delegate({ runId: run.id, phaseId: 'draft', agent, text: 'x' }),
    ).rejects.toMatchObject({ code: 'backend_not_allowed' });
  });

  it('refuses when the run is not running or the phase is not active', async () => {
    const { h, run } = await started();
    await expect(
      h.engine.steps.delegate({ runId: run.id, phaseId: 'review', agent, text: 'x' }),
    ).rejects.toMatchObject({ code: 'invalid_transition' });
    await h.engine.runs.pause(run.id, priya);
    await expect(
      h.engine.steps.delegate({ runId: run.id, phaseId: 'draft', agent, text: 'x' }),
    ).rejects.toMatchObject({ code: 'invalid_transition' });
  });

  it('refuses once the budget cap is reached, and allows it after the cap is waived', async () => {
    const { h, run } = await started();
    await h.engine.budget.record({ runId: run.id, cost: { amount: 10, currency: 'USD' } });
    // The run is now waiting on a budget decision, so it is not running.
    await expect(
      h.engine.steps.delegate({ runId: run.id, phaseId: 'draft', agent, text: 'x' }),
    ).rejects.toMatchObject({ code: 'invalid_transition' });
    const dec = (await h.p.store.decisions.list({ runId: run.id, status: ['pending'] })).items[0]!
      .value.decision;
    await h.engine.decisions.resolve(dec.id, { optionId: 'cap' }, priya);
    h.p.gateway.queue('author', [{ kind: 'state', state: 'completed', taskId: 't' }]);
    expect(
      (await h.engine.steps.delegate({ runId: run.id, phaseId: 'draft', agent, text: 'x' })).status,
    ).toBe('completed');
  });

  it('a step can feed the phase outcome: delegate, then record the verdict', async () => {
    const { h, run } = await started();
    h.p.gateway.queue('author', [{ kind: 'state', state: 'completed', taskId: 't' }]);
    await h.engine.steps.delegate({ runId: run.id, phaseId: 'draft', agent, text: 'write it' });
    await h.engine.runs.recordPhaseOutcome(run.id, 'draft', ok);
    expect(
      (await h.p.store.runs.get(run.id))!.value.run.phases!.find((p) => p.id === 'review')!.status,
    ).toBe('active');
  });
});
