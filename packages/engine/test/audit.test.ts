import { describe, expect, it } from 'vitest';
import {
  AuditWriter,
  ChainVerifier,
  INLINE_PAYLOAD_MAX_BYTES,
  hashRecord,
  sealRecord,
  type AuditRecord,
} from '../src/index.js';
import {
  InMemoryAuditBlobs,
  InMemoryAuditLedger,
  auditLedgerContract,
} from '../src/testing/index.js';

describe('in-memory audit ledger', () => {
  auditLedgerContract({ describe, it, expect } as never, async () => {
    const ledger = new InMemoryAuditLedger();
    return { ledger, tamper: ledger.tamper, blobs: new InMemoryAuditBlobs() };
  });
});

describe('ChainVerifier', () => {
  const rec = (n: number, prevHead?: { seq: number; hash: string }): AuditRecord =>
    sealRecord(
      {
        chain: 'control',
        actor: { type: 'system', id: 's' },
        kind: 'k',
        source: 'system',
        payload: { n },
      },
      '2026-01-01T00:00:00.000Z',
      `aud_${n}`,
      prevHead,
    );

  it('checks one record at a time and reports the first break only', () => {
    const a = rec(1);
    const b = rec(2, { seq: 1, hash: a.hash });
    const c = rec(3, { seq: 2, hash: b.hash });
    const v = new ChainVerifier('control');
    v.push(a);
    v.push({ ...b, payload: { n: 'changed' } });
    v.push({ ...c, payload: { n: 'also changed' } });
    const r = v.finish();
    expect(r.ok).toBe(false);
    expect(r.count).toBe(3);
    expect(r.firstBreak).toMatchObject({ seq: 2, reason: 'hash_mismatch' });
  });

  it('accepts a record whose hash covers every field including prev', () => {
    const a = rec(1);
    const { hash, ...rest } = a;
    expect(hashRecord(rest)).toBe(hash);
    expect(hashRecord({ ...rest, prev: '1'.repeat(64) })).not.toBe(hash);
    expect(hashRecord({ ...rest, kind: 'other' })).not.toBe(hash);
  });
});

describe('AuditWriter', () => {
  const setup = () => {
    const ledger = new InMemoryAuditLedger();
    const blobs = new InMemoryAuditBlobs();
    return { ledger, blobs, writer: new AuditWriter(ledger, blobs) };
  };
  const base = {
    chain: 'run:r1',
    actor: { type: 'agent' as const, id: 'a' },
    kind: 'tool.result',
    source: 'a2a-stream' as const,
  };

  it('keeps a small payload inline and a large one as a blob with its hash', async () => {
    const { writer, blobs, ledger } = setup();
    const small = (await writer.write({ ...base, payload: { ok: true } })).record;
    expect(small.payload).toEqual({ ok: true });
    expect(small.blob).toBeUndefined();

    const big = { text: 'x'.repeat(INLINE_PAYLOAD_MAX_BYTES + 1) };
    const large = (await writer.write({ ...base, payload: big })).record;
    expect(large.payload).toBeUndefined();
    expect(large.blob).toMatchObject({ mediaType: 'application/json' });
    const bytes = await blobs.get(large.blob!.sha256);
    expect(JSON.parse(new TextDecoder().decode(bytes))).toEqual(big);
    expect((await ledger.verify('run:r1', { blobs })).ok).toBe(true);
  });

  it('stores raw bytes losslessly, with their media type', async () => {
    const { writer, blobs } = setup();
    const raw = new Uint8Array([0, 1, 2, 255, 254]);
    const { record } = await writer.write({
      ...base,
      bytes: raw,
      mediaType: 'application/octet-stream',
    });
    expect(record.blob).toMatchObject({ bytes: 5, mediaType: 'application/octet-stream' });
    expect(Array.from((await blobs.get(record.blob!.sha256))!)).toEqual([0, 1, 2, 255, 254]);
  });

  it('writes the blob before the record, so a record never points at nothing', async () => {
    const { ledger, blobs } = setup();
    let blobWritten = false;
    const order: string[] = [];
    const wrapped = {
      put: async (b: Uint8Array, m: string) => {
        const r = await blobs.put(b, m);
        blobWritten = true;
        order.push('blob');
        return r;
      },
      get: blobs.get.bind(blobs),
      has: blobs.has.bind(blobs),
    };
    const append = ledger.append.bind(ledger);
    ledger.append = async (d) => {
      order.push(blobWritten ? 'record-after-blob' : 'record-before-blob');
      return append(d);
    };
    await new AuditWriter(ledger, wrapped).write({
      ...base,
      payload: { text: 'y'.repeat(INLINE_PAYLOAD_MAX_BYTES + 5) },
    });
    expect(order).toEqual(['blob', 'record-after-blob']);
  });

  it('does not store a body when there is none, and passes the sender id through for de-duplication', async () => {
    const { writer } = setup();
    const a = await writer.write({ ...base, kind: 'status', sourceEventId: 'e1' });
    expect(a.record.payload).toBeUndefined();
    expect(a.record.blob).toBeUndefined();
    expect((await writer.write({ ...base, kind: 'status', sourceEventId: 'e1' })).duplicate).toBe(
      true,
    );
  });
});
