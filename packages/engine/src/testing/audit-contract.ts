import type { AuditBlobRef, AuditDraft, AuditRecord } from '@kramahq/contract';
import { canonicalJson, hashRecord } from '../domain/audit-chain.js';
import type { AuditBlobs, AuditLedger } from '../ports/index.js';
import type { Harness } from './contracts.js';
import type { AuditTamper } from './audit-fakes.js';

export interface AuditLedgerUnderTest {
  ledger: AuditLedger;
  tamper: AuditTamper;
  blobs?: AuditBlobs & { corrupt(sha256: string): void; remove(sha256: string): void };
}

const draft = (
  chain: string,
  kind = 'message.agent',
  extra: Partial<AuditDraft> = {},
): AuditDraft => ({
  chain,
  actor: { type: 'agent', id: 'agent_1' },
  kind,
  source: 'a2a-stream',
  ...extra,
});

/**
 * What every `AuditLedger` must do: number records without gaps, chain their hashes, refuse nothing it should keep,
 * de-duplicate by the sender's event id, serialise concurrent writers, and `verify` finds a record that was edited, a
 * record that was removed, a tail that was cut off, and a blob that is missing or wrong.
 */
export function auditLedgerContract(h: Harness, make: () => Promise<AuditLedgerUnderTest>): void {
  const { describe, it, expect } = h;
  const fill = async (l: AuditLedger, chain: string, n: number) => {
    for (let i = 0; i < n; i++)
      await l.append(draft(chain, 'tool.call', { payload: { i }, sourceEventId: `e${i}` }));
  };

  describe('AuditLedger contract', () => {
    it('numbers records from 1 and chains each to the one before', async () => {
      const { ledger } = await make();
      const a = (await ledger.append(draft('run:r1'))).record;
      const b = (await ledger.append(draft('run:r1'))).record;
      expect([a.seq, b.seq]).toEqual([1, 2]);
      expect(a.prev).toBe('0'.repeat(64));
      expect(b.prev).toBe(a.hash);
      expect(b.hash).not.toBe(a.hash);
      expect(await ledger.head('run:r1')).toEqual({ seq: 2, hash: b.hash });
      expect(await ledger.head('run:none')).toBeUndefined();
    });

    it('keeps chains independent', async () => {
      const { ledger } = await make();
      await ledger.append(draft('run:r1'));
      await ledger.append(
        draft('control', 'run.created', { actor: { type: 'user', id: 'u1' }, source: 'api' }),
      );
      expect((await ledger.append(draft('run:r2'))).record.seq).toBe(1);
      expect(await ledger.chains()).toEqual(['control', 'run:r1', 'run:r2']);
      expect(await ledger.chains('run:')).toEqual(['run:r1', 'run:r2']);
    });

    it('stores the record as given and hashes the canonical form, whatever the key order', async () => {
      const { ledger } = await make();
      const { record } = await ledger.append(
        draft('run:r1', 'tool.result', {
          payload: { b: 1, a: { d: [1, 2], c: null } },
          correlation: { z: '1', y: '2' },
        }),
      );
      const { hash, ...rest } = record;
      expect(hashRecord(rest)).toBe(hash);
      expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
      const [read] = await ledger.read('run:r1');
      expect(read).toEqual(record);
    });

    it('writes a record with the same source event id once and returns the first', async () => {
      const { ledger } = await make();
      const first = await ledger.append(
        draft('run:r1', 'tool.call', { sourceEventId: 'evt-1', payload: { n: 1 } }),
      );
      const again = await ledger.append(
        draft('run:r1', 'tool.call', { sourceEventId: 'evt-1', payload: { n: 2 } }),
      );
      expect(first.duplicate).toBe(false);
      expect(again.duplicate).toBe(true);
      expect(again.record).toEqual(first.record);
      expect((await ledger.read('run:r1')).length).toBe(1);
      // The same id on another chain is a different event.
      expect(
        (await ledger.append(draft('run:r2', 'tool.call', { sourceEventId: 'evt-1' }))).duplicate,
      ).toBe(false);
    });

    it('gives concurrent writers to one chain distinct, gapless positions', async () => {
      const { ledger } = await make();
      await Promise.all(
        Array.from({ length: 40 }, (_, i) =>
          ledger.append(draft('run:r1', 'tool.call', { payload: { i } })),
        ),
      );
      const all = await ledger.read('run:r1', { limit: 100 });
      expect(all.map((r) => r.seq)).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
      expect((await ledger.verify('run:r1')).ok).toBe(true);
    });

    it('reads in order, after a position, with a limit, and by time range', async () => {
      const { ledger } = await make();
      for (let i = 1; i <= 5; i++)
        await ledger.append(draft('run:r1', 'tool.call', { at: `2026-01-0${i}T00:00:00.000Z` }));
      expect((await ledger.read('run:r1', { afterSeq: 2, limit: 2 })).map((r) => r.seq)).toEqual([
        3, 4,
      ]);
      expect(
        (
          await ledger.read('run:r1', {
            from: '2026-01-02T00:00:00.000Z',
            to: '2026-01-04T00:00:00.000Z',
          })
        ).map((r) => r.seq),
      ).toEqual([2, 3, 4]);
      expect(await ledger.read('run:none')).toEqual([]);
    });

    it('tells a subscriber about a record only after it is stored', async () => {
      const { ledger } = await make();
      const seen: number[] = [];
      let readableWhenTold = false;
      const off = ledger.subscribe(
        (r) => {
          seen.push(r.seq);
          void ledger
            .read(r.chain, { afterSeq: r.seq - 1 })
            .then((x) => (readableWhenTold = x.length === 1));
        },
        ['run:r1'],
      );
      await ledger.append(draft('run:r2'));
      await ledger.append(draft('run:r1'));
      await new Promise((r) => setTimeout(r, 20));
      off();
      await ledger.append(draft('run:r1'));
      expect(seen).toEqual([1]);
      expect(readableWhenTold).toBe(true);
    });

    describe('verify', () => {
      it('passes an untouched chain, and an empty one', async () => {
        const { ledger } = await make();
        await fill(ledger, 'run:r1', 12);
        const r = await ledger.verify('run:r1');
        expect(r).toMatchObject({ ok: true, count: 12, head: { seq: 12 } });
        expect(await ledger.verify('run:none')).toEqual({ ok: true, chain: 'run:none', count: 0 });
      });

      it('finds a record whose content was changed, at that record', async () => {
        const { ledger, tamper } = await make();
        await fill(ledger, 'run:r1', 6);
        await tamper.edit('run:r1', 4, { payload: { i: 999 } });
        const r = await ledger.verify('run:r1');
        expect(r.ok).toBe(false);
        expect(r.firstBreak).toMatchObject({ seq: 4, reason: 'hash_mismatch' });
      });

      it('finds a record whose content and hash were both rewritten, at the next record', async () => {
        const { ledger, tamper } = await make();
        await fill(ledger, 'run:r1', 6);
        const [forged] = await ledger.read('run:r1', { afterSeq: 3, limit: 1 });
        const changed: Omit<AuditRecord, 'hash'> & { hash?: string } = {
          ...forged!,
          payload: { i: 'forged' },
        };
        delete changed.hash;
        await tamper.edit('run:r1', 4, { payload: { i: 'forged' }, hash: hashRecord(changed) });
        const r = await ledger.verify('run:r1');
        expect(r.ok).toBe(false);
        expect(r.firstBreak).toMatchObject({ seq: 5, reason: 'prev_mismatch' });
      });

      it('finds a record that was removed from the middle', async () => {
        const { ledger, tamper } = await make();
        await fill(ledger, 'run:r1', 6);
        await tamper.remove('run:r1', 3);
        const r = await ledger.verify('run:r1');
        expect(r.ok).toBe(false);
        expect(r.firstBreak?.seq).toBe(4);
        expect(['seq_gap', 'prev_mismatch']).toContain(r.firstBreak?.reason);
      });

      it('finds a tail that was cut off, from the head the store kept', async () => {
        const { ledger, tamper } = await make();
        await fill(ledger, 'run:r1', 6);
        await tamper.remove('run:r1', 6);
        const r = await ledger.verify('run:r1');
        expect(r.ok).toBe(false);
        expect(r.firstBreak?.reason).toBe('head_mismatch');
      });

      it('finds a cut tail even when the stored head was fixed up too, given an anchor kept elsewhere', async () => {
        const { ledger, tamper } = await make();
        await fill(ledger, 'run:r1', 6);
        const anchor = (await ledger.head('run:r1'))!;
        await tamper.remove('run:r1', 6);
        const [last] = await ledger.read('run:r1', { afterSeq: 4 });
        await tamper.setHead('run:r1', { seq: last!.seq, hash: last!.hash });
        expect((await ledger.verify('run:r1')).ok).toBe(true); // the table alone cannot tell
        const r = await ledger.verify('run:r1', { expectedHead: anchor });
        expect(r.ok).toBe(false);
        expect(r.firstBreak?.reason).toBe('head_mismatch');
      });

      it('finds a record that moved to another chain', async () => {
        const { ledger, tamper } = await make();
        await fill(ledger, 'run:r1', 3);
        await tamper.edit('run:r1', 2, { chain: 'run:other' });
        const r = await ledger.verify('run:r1');
        // Depending on how the store keeps records, the moved record is still there (chain_mismatch at 2) or is gone
        // from this chain (a gap, seen at 3).
        expect(r.ok).toBe(false);
        expect([2, 3]).toContain(r.firstBreak?.seq);
        expect(['chain_mismatch', 'seq_gap', 'prev_mismatch']).toContain(r.firstBreak?.reason);
      });

      it('checks blobs when asked: a missing one and a changed one', async () => {
        const t = await make();
        if (!t.blobs) return;
        const small: AuditBlobRef = await t.blobs.put(
          new TextEncoder().encode('one'),
          'text/plain',
        );
        const other: AuditBlobRef = await t.blobs.put(
          new TextEncoder().encode('two'),
          'text/plain',
        );
        await t.ledger.append(draft('run:r1', 'tool.result', { blob: small }));
        await t.ledger.append(draft('run:r1', 'tool.result', { blob: other }));
        expect((await t.ledger.verify('run:r1', { blobs: t.blobs })).ok).toBe(true);
        t.blobs.corrupt(small.sha256);
        expect((await t.ledger.verify('run:r1', { blobs: t.blobs })).firstBreak).toMatchObject({
          seq: 1,
          reason: 'blob_mismatch',
        });
        t.blobs.remove(other.sha256);
        t.blobs.corrupt(small.sha256);
        expect((await t.ledger.verify('run:r1', { blobs: t.blobs })).firstBreak?.seq).toBe(1);
        expect((await t.ledger.verify('run:r1')).ok).toBe(true); // without blobs the chain itself is intact
      });
    });
  });
}
