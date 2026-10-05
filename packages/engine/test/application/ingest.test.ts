import { describe, expect, it } from 'vitest';
import {
  correlationRunId,
  mapUsageSummary,
  sidebandActivity,
  signalsOfAgentEvent,
  type AgentEventWire,
  type AgentSignal,
} from '../../src/index.js';
import { priya, setup } from './helpers.js';

const wire = (eventType: string, data: unknown = {}, extra: Partial<AgentEventWire> = {}) =>
  ({ eventId: `e_${eventType}`, eventType, agentId: 'a', data, ...extra }) as AgentEventWire;

describe('wrapper events become agent signals', () => {
  it('maps tool calls to the same signals the A2A trace artifacts produce', () => {
    expect(signalsOfAgentEvent(wire('tool_call_start', { toolName: 'read_file' }))).toEqual([
      {
        kind: 'sideband',
        type: 'tool_call',
        toolName: 'read_file',
        text: 'read_file',
        raw: { toolName: 'read_file' },
      },
    ]);
    const [end] = signalsOfAgentEvent(
      wire('tool_call_end', { toolName: 'read_file', isError: false, durationMs: 42 }),
    ) as Extract<AgentSignal, { kind: 'sideband' }>[];
    expect(end).toMatchObject({
      type: 'tool_result',
      toolName: 'read_file',
      isError: false,
      durationMs: 42,
    });
  });

  it('keeps thinking text, errors and the end of a turn', () => {
    expect(signalsOfAgentEvent(wire('thinking', { thought: 'plan' }))[0]).toMatchObject({
      type: 'thinking',
      text: 'plan',
    });
    expect(signalsOfAgentEvent(wire('agent_error', { message: 'boom' }))[0]).toMatchObject({
      type: 'status',
      text: 'boom',
      isError: true,
    });
  });

  it('takes usage from agent_finished as units, never as dollars', () => {
    const signals = signalsOfAgentEvent(
      wire('agent_finished', {
        usage: { inputTokens: 100, outputTokens: 50, llmCalls: 2, cost: 3 },
      }),
    );
    expect(signals.at(-1)).toEqual({
      kind: 'usage',
      cost: null,
      usage: [
        { unit: 'tokens', quantity: 150 },
        { unit: 'calls', quantity: 2 },
        { unit: 'credits', quantity: 3 },
      ],
    });
    // No usage reported, none invented.
    expect(
      signalsOfAgentEvent(wire('agent_finished', {})).filter((s) => s.kind === 'usage'),
    ).toEqual([]);
  });

  it('preserves an event type it does not know instead of dropping it', () => {
    expect(signalsOfAgentEvent(wire('quota_warning', { left: 3 }))).toEqual([
      {
        kind: 'sideband',
        type: 'status',
        text: 'quota warning',
        raw: { eventType: 'quota_warning', left: 3 },
      },
    ]);
    expect(signalsOfAgentEvent({})).toHaveLength(1);
  });

  it('reads the caller’s run from the correlation context, at the envelope or inside data', () => {
    expect(correlationRunId(wire('x', {}, { propagated_metadata: { run_id: 'run_1' } }))).toBe(
      'run_1',
    );
    expect(correlationRunId(wire('x', { propagated_metadata: { run_id: 'run_2' } }))).toBe('run_2');
    expect(correlationRunId(wire('x'))).toBeUndefined();
  });

  it('shares one usage mapping with the A2A channel', () => {
    expect(mapUsageSummary({ inputTokens: 1, outputTokens: 2, llmCalls: 1 })?.usage).toEqual([
      { unit: 'tokens', quantity: 3 },
      { unit: 'calls', quantity: 1 },
    ]);
    expect(mapUsageSummary('nope')).toBeUndefined();
  });
});

describe('ingest', () => {
  const started = async () => {
    const h = setup();
    const run = await h.engine.runs.create({ packId: 'pack_demo', input: {} }, priya);
    await h.engine.runs.plan(run.id);
    return { h, run };
  };
  const agent = { id: 'agt_9', role: 'researcher', backend: 'a2a-codex' };

  it('looks the same whichever channel an agent reported on', async () => {
    const { h, run } = await started();
    const trace: AgentSignal = {
      kind: 'sideband',
      type: 'tool_call',
      toolName: 'search',
      text: 'search',
      raw: { toolName: 'search' },
    };
    await h.engine.ingest.ingest({ runId: run.id, agent, channel: 'a2a' }, [trace]);
    await h.engine.ingest.ingest(
      { runId: run.id, agent, channel: 'http' },
      signalsOfAgentEvent(wire('tool_call_start', { toolName: 'search' })),
    );
    const seen = (await h.p.events.read({ topics: [`run:${run.id}`] })).filter((e) =>
      e.type.startsWith('activity.'),
    );
    expect(seen).toHaveLength(2);
    const [a, b] = seen.map((e) => ({ ...(e.data as object), channel: undefined }));
    expect(a).toEqual(b);
    expect(seen.map((e) => (e.data as { channel: string }).channel)).toEqual(['a2a', 'http']);
    expect(seen[0]).toMatchObject({
      type: 'activity.tool_call',
      subject: { type: 'agent', id: 'agt_9' },
      data: { agent, kind: 'tool_call', toolName: 'search' },
    });
  });

  it('accounts usage against the run and keeps cost "not reported"', async () => {
    const { h, run } = await started();
    await h.engine.ingest.ingest(
      { runId: run.id, agent, channel: 'http' },
      signalsOfAgentEvent(wire('agent_finished', { usage: { inputTokens: 10, outputTokens: 5 } })),
    );
    const after = (await h.p.store.runs.get(run.id))!.value.run;
    expect(after.budget.spent).toBeNull();
    const rows = await h.p.store.usage.forRun(run.id);
    expect(rows.flatMap((r) => r.usage)).toEqual([{ unit: 'tokens', quantity: 15 }]);
    expect(rows.every((r) => r.cost === null)).toBe(true);
  });

  it('gives the step feed and the agent feed the same payload for the same signal', () => {
    const s: Extract<AgentSignal, { kind: 'sideband' }> = {
      kind: 'sideband',
      type: 'thinking',
      text: 'x'.repeat(5000),
    };
    const { type, data } = sidebandActivity(s);
    expect(type).toBe('activity.status');
    expect(String(data.text).length).toBeLessThan(5000); // clipped like every channel
  });
});
