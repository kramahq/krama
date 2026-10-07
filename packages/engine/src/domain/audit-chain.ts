import { createHash } from 'node:crypto';
import {
  AUDIT_GENESIS,
  type AuditBreakReason,
  type AuditDraft,
  type AuditRecord,
  type AuditVerifyResult,
} from '@kramahq/contract';

/** JSON with sorted keys and no whitespace, so the same record always hashes the same. `undefined` fields are dropped. */
export function canonicalJson(value: unknown): string {
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map((x) => (x === undefined ? null : norm(x)));
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as object).sort()) {
        const x = (v as Record<string, unknown>)[k];
        if (x !== undefined) out[k] = norm(x);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(norm(value));
}

export const sha256Hex = (data: string | Uint8Array): string =>
  createHash('sha256').update(data).digest('hex');

/** The hash a record must carry: sha256 over its canonical form without `hash`. `prev` is part of it. */
export function hashRecord(record: Omit<AuditRecord, 'hash'>): string {
  return sha256Hex(canonicalJson(record));
}

/** Builds the next record of a chain from a draft, given the chain's current head. */
export function sealRecord(
  draft: AuditDraft,
  at: string,
  id: string,
  head: { seq: number; hash: string } | undefined,
): AuditRecord {
  const rest: Omit<AuditDraft, 'at'> & { at?: string } = { ...draft };
  delete rest.at;
  const unsigned: Omit<AuditRecord, 'hash'> = {
    ...rest,
    id,
    at,
    seq: (head?.seq ?? 0) + 1,
    prev: head?.hash ?? AUDIT_GENESIS,
  };
  return { ...unsigned, hash: hashRecord(unsigned) };
}

export interface VerifyExpectations {
  /** A head recorded somewhere an attacker of the table could not reach (an export manifest, the control chain). */
  expectedHead?: { seq: number; hash: string };
  /** The head the store itself kept; catches a tail that was removed without touching it. */
  storedHead?: { seq: number; hash: string } | undefined;
}

/**
 * Checks a chain one record at a time, so a long chain does not have to fit in memory. Finds, in order of position,
 * the first record whose hash does not match its content, whose `prev` does not match the record before it, or that
 * skips a sequence number; then, at the end, a head that disagrees with the expected or the stored one.
 */
export class ChainVerifier {
  private count = 0;
  private last: { seq: number; hash: string } | undefined;
  private broken: AuditVerifyResult['firstBreak'];

  constructor(private readonly chain: string) {}

  private fail(seq: number, reason: AuditBreakReason, detail?: string): void {
    this.broken ??= { seq, reason, ...(detail ? { detail } : {}) };
  }

  push(r: AuditRecord): void {
    this.count++;
    const expectSeq = (this.last?.seq ?? 0) + 1;
    if (r.chain !== this.chain)
      this.fail(r.seq, 'chain_mismatch', `belongs to ${r.chain}, read as ${this.chain}`);
    if (r.seq !== expectSeq) this.fail(r.seq, 'seq_gap', `expected ${expectSeq}, found ${r.seq}`);
    if (r.prev !== (this.last?.hash ?? AUDIT_GENESIS))
      this.fail(r.seq, 'prev_mismatch', 'does not follow the previous record');
    const { hash, ...rest } = r;
    if (hashRecord(rest) !== hash)
      this.fail(r.seq, 'hash_mismatch', 'content does not match its hash');
    this.last = { seq: r.seq, hash: r.hash };
  }

  /** Records a break found outside the chain itself (a missing blob). */
  note(seq: number, reason: AuditBreakReason, detail?: string): void {
    this.fail(seq, reason, detail);
  }

  finish(x: VerifyExpectations = {}): AuditVerifyResult {
    const head = this.last;
    const want = x.expectedHead ?? x.storedHead;
    if (want && (head?.seq !== want.seq || head?.hash !== want.hash))
      this.fail(
        head?.seq ?? 0,
        'head_mismatch',
        `chain ends at ${head?.seq ?? 0}, expected ${want.seq}; records were removed or replaced at the end`,
      );
    return {
      ok: this.broken === undefined,
      chain: this.chain,
      count: this.count,
      ...(head ? { head } : {}),
      ...(this.broken ? { firstBreak: this.broken } : {}),
    };
  }
}
