import { describe, expect, it } from 'vitest';
import {
  AuditWriter,
  TranscriptRecorder,
  createEngine,
  type AgentSignal,
  type TranscriptWrite,
} from '../../src/index.js';
import { authorReviewerPack, createFakePorts } from '../../src/testing/index.js';

const user = { type: 'user' as const, id: 'u1', name: 'U' };
const subject = (runId: string) => ({
  runId,
  agent: { id: 'agt_1', role: 'author', backend: 'a2a-claude' },
  channel: 'http' as const,
});
const call: AgentSignal = {
  kind: 'sideband',
  type: 'tool_call',
  toolName: 'git.diff',
  text: 'x'.repeat(9000),
  raw: { a: 'y'.repeat(9000) },
};

async function setup(slowMs = 0) {
  const p = createFakePorts([authorReviewerPack()]);
  const recorder = new TranscriptRecorder({ writer: new AuditWriter(p.ledger, p.auditBlobs) });
  const log: string[] = [];
  const real = recorder.record.bind(recorder);
  p.transcript = Object.assign(Object.create(recorder), {
    record: async (w: TranscriptWrite) => {
      if (slowMs) await new Promise((r) => setTimeout(r, slowMs));
      await real(w);
      log.push(`recorded:${w.kind}`);
    },
  });
  const append = p.events.append.bind(p.events);
  p.events.append = async (d) => {
    log.push(`published:${d.type}`);
    return append(d);
  };
  const engine = createEngine(p, {});
  const run = await engine.runs.create(
    { packId: 'pack_demo', input: { text: 'Write the notes' }, budget: { max: 10 } },
    user,
  );
  log.length = 0;
  return { p, engine, run, log, recorder };
}

describe('write-ahead', () => {
  it('records a signal, in full, before the activity event that shows it', async () => {
    const t = await setup(20);
    await t.engine.ingest.ingest(subject(t.run.id), [call], { eventId: 'e1' });
    expect(t.log).toEqual(['recorded:tool.call', 'published:activity.tool_call']);
    const [rec] = (await t.p.ledger.read(`run:${t.run.id}`)).filter((r) => r.kind === 'tool.call');
    // The feed shortens what it shows; the record does not.
    const stored = JSON.parse(
      new TextDecoder().decode(await t.p.auditBlobs.get(rec!.blob!.sha256)),
    );
    expect(stored.text.length).toBe(9000);
    expect(stored.raw.a.length).toBe(9000);
    const feed = (await t.p.events.read({ topics: [`run:${t.run.id}`] })).find(
      (e) => e.type === 'activity.tool_call',
    );
    expect(JSON.stringify(feed!.data).length).toBeLessThan(9000);
  });

  it('records the user prompt before the run is announced', async () => {
    const p = createFakePorts([authorReviewerPack()]);
    const order: string[] = [];
    const writer = new AuditWriter(p.ledger, p.auditBlobs);
    p.transcript = new TranscriptRecorder({ writer });
    const real = p.transcript.record.bind(p.transcript);
    p.transcript.record = async (w) => {
      order.push(`recorded:${w.kind}`);
      return real(w);
    };
    const append = p.events.append.bind(p.events);
    p.events.append = async (d) => {
      order.push(`published:${d.type}`);
      return append(d);
    };
    const engine = createEngine(p, {});
    const run = await engine.runs.create(
      { packId: 'pack_demo', input: { text: 'Write the notes' }, budget: { max: 10 } },
      user,
    );
    expect(order.indexOf('recorded:message.user')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('recorded:message.user')).toBeLessThan(
      order.indexOf('published:run.created'),
    );
    const [first] = await p.ledger.read(`run:${run.id}`);
    expect(first).toMatchObject({
      kind: 'message.user',
      actor: { type: 'user', id: 'u1' },
      payload: { input: { text: 'Write the notes' } },
    });
    // The same create, replayed with its idempotency key, does not write the prompt again.
    await engine.runs.create(
      { packId: 'pack_demo', input: { text: 'Write the notes' }, budget: { max: 10 } },
      user,
      { idempotencyKey: 'k1' },
    );
    await engine.runs.create(
      { packId: 'pack_demo', input: { text: 'Write the notes' }, budget: { max: 10 } },
      user,
      { idempotencyKey: 'k1' },
    );
    expect((await p.ledger.chains('run:')).length).toBe(2);
  });

  it('carries on when the record cannot be written, and counts it', async () => {
    const t = await setup();
    t.p.ledger.append = async () => {
      throw new Error('disk full');
    };
    await t.engine.ingest.ingest(subject(t.run.id), [call]);
    expect(t.log).toContain('published:activity.tool_call');
    expect(t.recorder.stats.failed).toBeGreaterThan(0);
  });

  it('records a decision before it can be seen and again when it is answered', async () => {
    const t = await setup();
    const d = await t.engine.decisions.request({
      decision: {
        id: t.p.ids.next('dec'),
        kind: 'access',
        runId: t.run.id,
        title: 'Publish?',
        question: 'Ship it?',
        access: { path: '~/Downloads/spec.pdf', agent: 'developer-2' },
        options: [{ id: 'allow_once', label: 'Once', style: 'primary' }],
        createdAt: new Date().toISOString(),
        links: {},
      },
    } as never);
    expect(t.log.indexOf('recorded:decision.requested')).toBeLessThan(
      t.log.indexOf('published:decision.requested'),
    );
    await t.engine.decisions.resolve(d.id, { optionId: 'allow_once' }, user);
    const kinds = (await t.p.ledger.read(`run:${t.run.id}`)).map((r) => r.kind);
    expect(kinds.filter((k) => k === 'decision.requested').length).toBe(1); // not twice, though two paths record it
    expect(kinds).toContain('decision.resolved');
  });
});
