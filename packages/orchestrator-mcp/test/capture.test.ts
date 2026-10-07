import { afterEach, describe, expect, it } from 'vitest';
import { AuditWriter, Redactor, TranscriptRecorder } from '@kramahq/engine';
import { AgentEventCollector, EventTokens, type EventClaims } from '../src/index.js';
import { call, rig, type Rig } from './rig.js';
import { newRun, system, type System } from './runner-rig.js';

const live: { s: System; c: AgentEventCollector }[] = [];
const rigs: Rig[] = [];
afterEach(async () => {
  await Promise.allSettled([
    ...live.splice(0).flatMap(({ s, c }) => [c.close(), s.stop()]),
    ...rigs.splice(0).map((r) => r.close()),
  ]);
});

/** A system whose ports record a transcript on the in-memory ledger, with a collector in front. */
async function make(restartOf?: { s: System; redactor: Redactor }) {
  const s = restartOf?.s ?? (await system());
  const redactor = restartOf?.redactor ?? new Redactor();
  const recorder = new TranscriptRecorder({
    writer: new AuditWriter(s.p.ledger, s.p.auditBlobs),
    redactor,
  });
  s.p.transcript = recorder;
  const c = new AgentEventCollector({
    engine: s.engine,
    ports: s.p,
    tokens: new EventTokens(undefined, (t) => redactor.addValue(t, 'krama-token')),
  });
  const base = await c.listen();
  live.push({ s, c });
  const runId = await newRun(s);
  const claims: EventClaims = {
    runId,
    instanceId: 'agt_w1',
    agent: 'researcher',
    role: 'researcher',
    backend: 'a2a-codex',
  };
  const token = c.tokens.issue(claims);
  const post = (body: unknown, auth = `Bearer ${token}`) =>
    fetch(`${base}/agent-events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: auth },
      body: JSON.stringify(body),
    });
  const chain = () => s.p.ledger.read(`run:${runId}`, { limit: 1000 });
  return { s, c, recorder, redactor, runId, claims, token, post, chain, base };
}

const ev = (eventType: string, data: unknown = {}, extra: Record<string, unknown> = {}) => ({
  eventId: `ev_${Math.random().toString(36).slice(2)}`,
  eventType,
  agentId: 'researcher',
  traceId: 'trace_1',
  timestamp: '2026-01-01T00:00:00.000Z',
  data,
  ...extra,
});

describe('what the event sink puts on the record', () => {
  it('records an event in full, with the envelope it arrived in', async () => {
    const t = await make();
    const big = 'x'.repeat(100_000);
    await t.post(
      ev(
        'tool_call_end',
        { toolName: 'web_search', output: big, isError: false },
        { eventId: 'ev_big' },
      ),
    );
    const [r] = (await t.chain()).filter((x) => x.kind === 'tool.result');
    expect(r).toMatchObject({
      source: 'http-sink',
      sourceEventId: 'evt:ev_big',
      at: '2026-01-01T00:00:00.000Z',
      actor: { type: 'agent', id: 'agt_w1', role: 'researcher' },
    });
    expect(r!.blob).toBeDefined();
    const body = JSON.parse(new TextDecoder().decode(await t.s.p.auditBlobs.get(r!.blob!.sha256)));
    expect(body.raw.output).toBe(big); // every character, though the activity feed keeps 2,000
    expect(body.wire).toMatchObject({
      eventId: 'ev_big',
      traceId: 'trace_1',
      eventType: 'tool_call_end',
    });
    expect(
      (await t.s.p.events.read({ topics: [`run:${t.runId}`] })).find(
        (e) => e.type === 'activity.tool_result',
      ),
    ).toBeDefined();
  });

  it('records a retried POST once, and once more across a restart of the collector', async () => {
    const t = await make();
    const e = ev('tool_call_start', { toolName: 'a' }, { eventId: 'ev_retry' });
    expect((await t.post(e)).status).toBe(202);
    expect((await t.post(e)).status).toBe(202); // the sender did not hear the first answer
    expect((await t.chain()).filter((x) => x.sourceEventId === 'evt:ev_retry').length).toBe(1);

    // A restart forgets the collector's own list of seen ids; the ledger does not.
    await t.c.close();
    const again = await make({ s: t.s, redactor: t.redactor });
    // Same run, same event id, a fresh collector.
    const claims = { ...again.claims, runId: t.runId };
    const token2 = again.c.tokens.issue(claims);
    const res = await fetch(`${again.base}/agent-events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token2}` },
      body: JSON.stringify(e),
    });
    expect(res.status).toBe(202);
    expect(
      (await t.s.p.ledger.read(`run:${t.runId}`)).filter((x) => x.sourceEventId === 'evt:ev_retry')
        .length,
    ).toBe(1);
    expect(again.recorder.stats.duplicates).toBe(1);
  });

  it('never lets a token, or a credential an agent printed, reach the record', async () => {
    const t = await make();
    await t.post(
      ev('tool_call_end', {
        toolName: 'env',
        output: `my token is ${t.token} and key sk-abcdefghijklmnopqrstuvwx`,
      }),
    );
    const all = JSON.stringify(await t.chain());
    expect(all).not.toContain(t.token);
    expect(all).not.toContain('sk-abcdefghijklmnopqrstuvwx');
    const [r] = (await t.chain()).filter((x) => x.kind === 'tool.result');
    expect(r!.redaction).toEqual({ applied: true, rules: ['api-key', 'krama-token'] });
  });

  it('puts an event that cannot be attributed to a run on the control chain, with what it said', async () => {
    const t = await make();
    const res = await t.post(
      ev(
        'thinking',
        { text: 'whose is this?' },
        { eventId: 'ev_lost', propagated_metadata: { run_id: 'run_someone_else' } },
      ),
    );
    expect((await res.json()).status).toBe('parked');
    await new Promise((r) => setTimeout(r, 30));
    const control = await t.s.p.ledger.read('control');
    expect(control).toHaveLength(1);
    expect(control[0]).toMatchObject({
      kind: 'capture.gap',
      source: 'http-sink',
      actor: { id: 'agt_w1' },
      payload: {
        reason: 'unattributed',
        claimedRun: t.runId,
        wire: { eventId: 'ev_lost', data: { text: 'whose is this?' } },
      },
    });
    expect((await t.chain()).some((x) => x.sourceEventId === 'evt:ev_lost')).toBe(false);
  });
});

describe('what the record says is missing when a run closes', () => {
  it('reports an agent that was meant to report to the sink, was seen working, and said nothing', async () => {
    const t = await make();
    t.recorder.expectSink(t.runId, { id: 'agt_w1', role: 'researcher' });
    t.recorder.noteActivity(t.runId, 'agt_w1'); // Krama sent it a task
    await t.recorder.closeRun(t.runId);
    const gap = (await t.chain()).find((x) => x.kind === 'capture.gap');
    expect(gap?.payload).toMatchObject({ reason: 'sink_silent', agent: 'agt_w1' });
  });

  it('does not report the agent once it has reported, and reports a turn that started and never ended', async () => {
    const ok = await make();
    ok.recorder.expectSink(ok.runId, { id: 'agt_w1' });
    ok.recorder.noteActivity(ok.runId, 'agt_w1');
    await ok.post(ev('agent_started'));
    await ok.post(ev('agent_finished', {}, { eventId: 'ev_end' }));
    await ok.recorder.closeRun(ok.runId);
    expect((await ok.chain()).filter((x) => x.kind === 'capture.gap')).toEqual([]);

    const open = await make();
    await open.post(ev('agent_started', {}, { traceId: 'trace_open' }));
    await open.recorder.closeRun(open.runId);
    expect((await open.chain()).find((x) => x.kind === 'capture.gap')?.payload).toMatchObject({
      reason: 'lifecycle_unbalanced',
      agent: 'agt_w1',
      detail: { traces: ['trace_open'] },
    });
  });
});

describe('what the orchestrator does through its tools', () => {
  it('is on record before it runs and its outcome before the orchestrator hears of it', async () => {
    const r = await rig();
    rigs.push(r);
    const recorder = new TranscriptRecorder({
      writer: new AuditWriter(r.p.ledger, r.p.auditBlobs),
    });
    r.p.transcript = recorder;
    await call(r.client, 'get_budget', {});
    // A call the engine refuses (no such phase) is on record too, with why.
    await call(r.client, 'record_phase_outcome', {
      phaseId: 'no_such_phase',
      status: 'success',
      reason: 'because',
      gating: 'continue',
    }).catch(() => undefined);
    const records = await r.p.ledger.read(`run:${r.runId}`);
    const kinds = records.map((x) => `${x.kind}:${(x.payload as { tool?: string })?.tool}`);
    expect(kinds.slice(0, 2)).toEqual(['tool.call:get_budget', 'tool.result:get_budget']);
    expect(records[0]).toMatchObject({
      actor: { type: 'orchestrator' },
      source: 'mcp',
      payload: { tool: 'get_budget', args: {} },
    });
    expect(records[1]!.payload).toMatchObject({ ok: true });
    expect(
      records.some((x) => x.kind === 'tool.result' && (x.payload as { ok?: boolean }).ok === false),
    ).toBe(true);
  });
});
