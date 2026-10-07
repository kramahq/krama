import { describe, expect, it } from 'vitest';
import {
  AuditWriter,
  INLINE_PAYLOAD_MAX_BYTES,
  Redactor,
  TranscriptRecorder,
  type AuditRecord,
} from '../src/index.js';
import { InMemoryAuditBlobs, InMemoryAuditLedger } from '../src/testing/index.js';

const agent = { type: 'agent' as const, id: 'agt_1', role: 'worker' };
const setup = (o: { strict?: boolean; redactor?: Redactor } = {}) => {
  const ledger = new InMemoryAuditLedger();
  const blobs = new InMemoryAuditBlobs();
  const errors: unknown[] = [];
  const rec = new TranscriptRecorder({
    writer: new AuditWriter(ledger, blobs),
    onError: (e) => errors.push(e),
    ...o,
  });
  const chain = (runId: string) => ledger.read(`run:${runId}`, { limit: 1000 });
  return { ledger, blobs, rec, errors, chain };
};
const w = (extra: object = {}) => ({
  runId: 'run_1',
  actor: agent,
  kind: 'tool.call',
  source: 'http-sink' as const,
  ...extra,
});

describe('TranscriptRecorder', () => {
  it('has written the record by the time record() returns (write-ahead)', async () => {
    const { rec, chain } = setup();
    await rec.record(w({ payload: { n: 1 } }));
    expect((await chain('run_1')).map((r: AuditRecord) => r.kind)).toEqual(['tool.call']);
  });

  it('keeps the order of writes to a run when nobody waits, and closeRun waits for them all', async () => {
    const { rec, ledger, chain } = setup();
    const real = ledger.append.bind(ledger);
    // Slow the first write down: the second must still land after it.
    let first = true;
    ledger.append = async (d) => {
      if (first) {
        first = false;
        await new Promise((r) => setTimeout(r, 30));
      }
      return real(d);
    };
    void rec.record(w({ kind: 'a2a.frame', payload: { n: 1 } }));
    void rec.record(w({ kind: 'a2a.frame', payload: { n: 2 } }));
    void rec.record(w({ kind: 'a2a.frame', payload: { n: 3 } }));
    await rec.closeRun('run_1');
    const all = await chain('run_1');
    expect(
      all
        .filter((r: AuditRecord) => r.kind === 'a2a.frame')
        .map((r) => (r.payload as { n: number }).n),
    ).toEqual([1, 2, 3]);
    expect(all.at(-1)!.kind).toBe('capture.summary');
  });

  it('masks secrets before they are written, and marks the record', async () => {
    const redactor = new Redactor();
    redactor.addValue('krm_evt_registered-token-value', 'event-token');
    const { rec, chain, blobs } = setup({ redactor });
    await rec.record(
      w({
        payload: {
          header: 'Bearer abcdefghijklmnop0123456789',
          t: 'krm_evt_registered-token-value',
        },
      }),
    );
    const [r] = await chain('run_1');
    expect(JSON.stringify(r)).not.toContain('abcdefghijklmnop0123456789');
    expect(JSON.stringify(r)).not.toContain('registered-token-value');
    expect(r!.redaction).toEqual({ applied: true, rules: ['bearer-token', 'event-token'] });
    // A large body is masked too, before it is stored as a blob.
    await rec.record(
      w({
        kind: 'tool.result',
        payload: { out: `key sk-abcdefghijklmnopqrstuvwx ${'y'.repeat(INLINE_PAYLOAD_MAX_BYTES)}` },
      }),
    );
    const big = (await chain('run_1'))[1]!;
    expect(big.blob).toBeDefined();
    const text = new TextDecoder().decode(await blobs.get(big.blob!.sha256));
    expect(text).not.toContain('sk-abcdefghijklmnopqrstuvwx');
    expect(text).toContain('[REDACTED:api-key]');
  });

  it('keeps a body longer than any feed would show, byte for byte', async () => {
    const { rec, chain, blobs } = setup();
    const body = { text: 'z'.repeat(250_000), raw: { deep: ['a'.repeat(9_000)] } };
    await rec.record(w({ kind: 'tool.result', payload: body }));
    const [r] = await chain('run_1');
    expect(r!.blob).toBeDefined();
    expect(JSON.parse(new TextDecoder().decode(await blobs.get(r!.blob!.sha256)))).toEqual(body);
  });

  it('records an event with the same source id once, however often it is sent', async () => {
    const { rec, chain } = setup();
    for (let i = 0; i < 3; i++) await rec.record(w({ sourceEventId: 'evt-1', payload: { n: 1 } }));
    expect((await chain('run_1')).length).toBe(1);
    expect(rec.stats).toMatchObject({ written: 1, duplicates: 2 });
  });

  it('counts a failed write and carries on; strict mode throws instead', async () => {
    const lax = setup();
    lax.ledger.append = async () => {
      throw new Error('disk full');
    };
    await expect(lax.rec.record(w())).resolves.toBeUndefined();
    expect(lax.rec.stats.failed).toBe(1);
    expect(lax.errors.length).toBe(1);

    const strict = setup({ strict: true });
    strict.ledger.append = async () => {
      throw new Error('disk full');
    };
    await expect(strict.rec.record(w())).rejects.toThrow(/disk full/);
  });

  it('writes what belongs to no run on the control chain', async () => {
    const { rec, ledger } = setup();
    await rec.recordControl({
      actor: { type: 'system', id: 'collector' },
      kind: 'capture.gap',
      source: 'http-sink',
      payload: { reason: 'unattributed' },
    });
    expect((await ledger.read('control')).map((r) => r.kind)).toEqual(['capture.gap']);
  });

  describe('when a run closes', () => {
    it('reports an agent that was meant to use the sink, was seen working, and never reported', async () => {
      const { rec, chain } = setup();
      rec.expectSink('run_1', { id: 'agt_1', role: 'worker' });
      rec.noteActivity('run_1', 'agt_1');
      await rec.record(
        w({ source: 'a2a-stream', observe: { agentId: 'agt_1', channel: 'stream' } }),
      );
      await rec.closeRun('run_1');
      const gaps = (await chain('run_1')).filter((r: AuditRecord) => r.kind === 'capture.gap');
      expect(gaps.map((g) => (g.payload as { reason: string }).reason)).toEqual(['sink_silent']);
      expect((gaps[0]!.payload as { agent: string }).agent).toBe('agt_1');
    });

    it('reports no gap for an agent that did report, or one that was never seen working', async () => {
      const { rec, chain } = setup();
      rec.expectSink('run_1', { id: 'reported' });
      rec.noteActivity('run_1', 'reported');
      await rec.record(w({ observe: { agentId: 'reported', channel: 'sink' } }));
      rec.expectSink('run_1', { id: 'idle' }); // started, never given work: silence is expected
      await rec.closeRun('run_1');
      expect((await chain('run_1')).filter((r: AuditRecord) => r.kind === 'capture.gap')).toEqual(
        [],
      );
    });

    it('reports a start with no end, and not one that finished or failed', async () => {
      const { rec, chain } = setup();
      await rec.record(
        w({ observe: { agentId: 'a', channel: 'sink', traceId: 't1', lifecycle: 'started' } }),
      );
      await rec.record(
        w({ observe: { agentId: 'a', channel: 'sink', traceId: 't2', lifecycle: 'started' } }),
      );
      await rec.record(
        w({ observe: { agentId: 'a', channel: 'sink', traceId: 't2', lifecycle: 'finished' } }),
      );
      await rec.record(
        w({ observe: { agentId: 'b', channel: 'sink', traceId: 't3', lifecycle: 'started' } }),
      );
      await rec.record(
        w({ observe: { agentId: 'b', channel: 'sink', traceId: 't3', lifecycle: 'error' } }),
      );
      await rec.closeRun('run_1');
      const gaps = (await chain('run_1')).filter((r: AuditRecord) => r.kind === 'capture.gap');
      expect(gaps.length).toBe(1);
      expect(gaps[0]!.payload).toMatchObject({
        reason: 'lifecycle_unbalanced',
        agent: 'a',
        detail: { startedWithoutEnd: 1, traces: ['t1'] },
      });
    });

    it('reports records that could not be written, then a summary of what was', async () => {
      const { rec, ledger, chain } = setup();
      await rec.record(w({ sourceEventId: 'ok' }));
      const real = ledger.append.bind(ledger);
      ledger.append = async () => {
        throw new Error('boom');
      };
      await rec.record(w({ sourceEventId: 'lost' }));
      ledger.append = real;
      await rec.closeRun('run_1');
      const all = await chain('run_1');
      expect(all.map((r: AuditRecord) => r.kind)).toEqual([
        'tool.call',
        'capture.gap',
        'capture.summary',
      ]);
      expect(all[1]!.payload).toMatchObject({ reason: 'capture_failed', detail: { records: 1 } });
      expect(all[2]!.payload).toMatchObject({ written: 1, failed: 1, gaps: ['capture_failed'] });
    });

    it('closes once, and a run closed with nothing recorded writes nothing', async () => {
      const { rec, chain } = setup();
      await rec.record(w());
      await rec.closeRun('run_1');
      await rec.closeRun('run_1');
      expect(
        (await chain('run_1')).filter((r: AuditRecord) => r.kind === 'capture.summary').length,
      ).toBe(1);
      await rec.closeRun('run_unknown');
      expect(await chain('run_unknown')).toEqual([]);
    });

    it('leaves a chain that verifies', async () => {
      const { rec, ledger } = setup();
      rec.expectSink('run_1', { id: 'a' });
      rec.noteActivity('run_1', 'a');
      for (let i = 0; i < 5; i++) await rec.record(w({ payload: { i }, sourceEventId: `e${i}` }));
      await rec.closeRun('run_1');
      expect((await ledger.verify('run:run_1')).ok).toBe(true);
    });
  });
});
