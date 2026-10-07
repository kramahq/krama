import type { AuditDraft, AuditRecord } from '@kramahq/contract';
import { AUDIT_GENESIS } from '@kramahq/contract';
import {
  ChainVerifier,
  UlidIdGenerator,
  canonicalJson,
  sealRecord,
  sha256Hex,
  type AuditHead,
  type AuditLedger,
  type AuditReadOptions,
  type AuditVerifyOptions,
  type IdGenerator,
} from '@kramahq/engine';
import { and, asc, eq, gt, gte, like, lte } from 'drizzle-orm';
import type { Db } from './db.js';
import { auditHeads, auditRecords } from './schema.js';

export interface PgAuditLedgerOptions {
  ids?: IdGenerator;
  now?: () => Date;
}

const PAGE = 500;

/**
 * `AuditLedger` on the database. A write is one transaction: lock the chain's head row, check for a record with the same
 * sender id, number and hash the new record, insert it and move the head. Two writers to one chain take turns on the
 * lock; writers to different chains do not meet. Subscribers hear about a record only after its transaction commits.
 * Triggers (migration 0002) refuse UPDATE, DELETE and TRUNCATE on the records and keep heads moving forward.
 */
export class PgAuditLedger implements AuditLedger {
  private readonly ids: IdGenerator;
  private readonly now: () => Date;
  private readonly listeners = new Set<{ fn: (r: AuditRecord) => void; chains?: string[] }>();

  constructor(
    private readonly db: Db,
    o: PgAuditLedgerOptions = {},
  ) {
    this.ids = o.ids ?? new UlidIdGenerator();
    this.now = o.now ?? (() => new Date());
  }

  async append(draft: AuditDraft): Promise<{ record: AuditRecord; duplicate: boolean }> {
    const out = await this.db.transaction(async (tx) => {
      // Make sure the head row exists, then take its lock: this is what puts writers to one chain in a line.
      await tx
        .insert(auditHeads)
        .values({ chain: draft.chain, seq: 0, hash: AUDIT_GENESIS })
        .onConflictDoNothing();
      const [head] = await tx
        .select()
        .from(auditHeads)
        .where(eq(auditHeads.chain, draft.chain))
        .for('update');

      if (draft.sourceEventId !== undefined) {
        const [dup] = await tx
          .select({ record: auditRecords.record })
          .from(auditRecords)
          .where(
            and(
              eq(auditRecords.chain, draft.chain),
              eq(auditRecords.sourceEventId, draft.sourceEventId),
            ),
          );
        if (dup) return { record: JSON.parse(dup.record) as AuditRecord, duplicate: true };
      }

      const current = head && head.seq > 0 ? { seq: head.seq, hash: head.hash } : undefined;
      const record = sealRecord(
        draft,
        draft.at ?? this.now().toISOString(),
        this.ids.next('aud'),
        current,
      );
      await tx.insert(auditRecords).values({
        chain: record.chain,
        seq: record.seq,
        id: record.id,
        at: record.at,
        kind: record.kind,
        actorId: record.actor.id,
        runId: record.runId ?? null,
        sourceEventId: record.sourceEventId ?? null,
        record: canonicalJson(record),
      });
      await tx
        .update(auditHeads)
        .set({ seq: record.seq, hash: record.hash })
        .where(eq(auditHeads.chain, record.chain));
      return { record, duplicate: false };
    });
    if (!out.duplicate)
      for (const l of this.listeners)
        if (!l.chains || l.chains.includes(out.record.chain)) l.fn(structuredClone(out.record));
    return out;
  }

  async read(chain: string, o: AuditReadOptions = {}): Promise<AuditRecord[]> {
    const rows = await this.db
      .select({ record: auditRecords.record })
      .from(auditRecords)
      .where(
        and(
          eq(auditRecords.chain, chain),
          o.afterSeq !== undefined ? gt(auditRecords.seq, o.afterSeq) : undefined,
          o.from !== undefined ? gte(auditRecords.at, o.from) : undefined,
          o.to !== undefined ? lte(auditRecords.at, o.to) : undefined,
        ),
      )
      .orderBy(asc(auditRecords.seq))
      .limit(o.limit ?? 1000);
    return rows.map((r) => JSON.parse(r.record) as AuditRecord);
  }

  async head(chain: string): Promise<AuditHead | undefined> {
    const [h] = await this.db.select().from(auditHeads).where(eq(auditHeads.chain, chain));
    return h && h.seq > 0 ? { seq: h.seq, hash: h.hash } : undefined;
  }

  async chains(prefix?: string): Promise<string[]> {
    const rows = await this.db
      .select({ chain: auditHeads.chain })
      .from(auditHeads)
      .where(
        and(
          gt(auditHeads.seq, 0),
          prefix ? like(auditHeads.chain, `${prefix.replace(/[\\%_]/g, '\\$&')}%`) : undefined,
        ),
      )
      .orderBy(asc(auditHeads.chain));
    return rows.map((r) => r.chain);
  }

  async verify(chain: string, o: AuditVerifyOptions = {}) {
    const v = new ChainVerifier(chain);
    let after = 0;
    for (;;) {
      // Read by position without trusting it: a gap shows up as `seq_gap`, not as a short page.
      const rows = await this.db
        .select({ record: auditRecords.record })
        .from(auditRecords)
        .where(and(eq(auditRecords.chain, chain), gt(auditRecords.seq, after)))
        .orderBy(asc(auditRecords.seq))
        .limit(PAGE);
      for (const row of rows) {
        const r = JSON.parse(row.record) as AuditRecord;
        v.push(r);
        after = r.seq;
        if (o.blobs && r.blob) {
          const bytes = await o.blobs.get(r.blob.sha256);
          if (!bytes) v.note(r.seq, 'blob_missing', r.blob.sha256);
          else if (sha256Hex(bytes) !== r.blob.sha256)
            v.note(r.seq, 'blob_mismatch', r.blob.sha256);
        }
      }
      if (rows.length < PAGE) break;
    }
    const [stored] = await this.db.select().from(auditHeads).where(eq(auditHeads.chain, chain));
    return v.finish({
      ...(o.expectedHead ? { expectedHead: o.expectedHead } : {}),
      storedHead: stored && stored.seq > 0 ? { seq: stored.seq, hash: stored.hash } : undefined,
    });
  }

  subscribe(fn: (r: AuditRecord) => void, chains?: string[]): () => void {
    const l = { fn, ...(chains ? { chains } : {}) };
    this.listeners.add(l);
    return () => void this.listeners.delete(l);
  }
}
