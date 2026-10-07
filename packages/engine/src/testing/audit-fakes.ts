import type { AuditBlobRef, AuditDraft, AuditRecord } from '@kramahq/contract';
import { ChainVerifier, sealRecord, sha256Hex } from '../domain/audit-chain.js';
import type {
  AuditBlobs,
  AuditHead,
  AuditLedger,
  AuditReadOptions,
  AuditVerifyOptions,
} from '../ports/index.js';

/** How a test reaches under a ledger to change it the way an attacker with write access to the table would. */
export interface AuditTamper {
  edit(chain: string, seq: number, change: Partial<AuditRecord>): Promise<void>;
  remove(chain: string, seq: number): Promise<void>;
  /** Overwrites the head the store itself keeps (an attacker who also fixes that up). */
  setHead(chain: string, head: AuditHead): Promise<void>;
}

export class InMemoryAuditBlobs implements AuditBlobs {
  private readonly blobs = new Map<string, { bytes: Uint8Array; mediaType: string }>();
  async put(bytes: Uint8Array, mediaType: string): Promise<AuditBlobRef> {
    const sha256 = sha256Hex(bytes);
    this.blobs.set(sha256, { bytes: new Uint8Array(bytes), mediaType });
    return { sha256, bytes: bytes.byteLength, mediaType };
  }
  async get(sha256: string) {
    const b = this.blobs.get(sha256);
    return b ? new Uint8Array(b.bytes) : undefined;
  }
  async has(sha256: string) {
    return this.blobs.has(sha256);
  }
  /** Test helpers. */
  corrupt(sha256: string): void {
    this.blobs.set(sha256, { bytes: new Uint8Array([0]), mediaType: 'application/octet-stream' });
  }
  remove(sha256: string): void {
    this.blobs.delete(sha256);
  }
}

export class InMemoryAuditLedger implements AuditLedger {
  private readonly chainsMap = new Map<string, AuditRecord[]>();
  private readonly heads = new Map<string, AuditHead>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly listeners = new Set<{ fn: (r: AuditRecord) => void; chains?: string[] }>();
  private n = 0;

  constructor(private readonly now: () => Date = () => new Date()) {}

  readonly tamper: AuditTamper = {
    edit: async (chain, seq, change) => {
      const list = this.chainsMap.get(chain)!;
      const i = list.findIndex((r) => r.seq === seq);
      list[i] = { ...list[i]!, ...change };
    },
    remove: async (chain, seq) => {
      const list = this.chainsMap.get(chain)!;
      list.splice(
        list.findIndex((r) => r.seq === seq),
        1,
      );
    },
    setHead: async (chain, head) => void this.heads.set(chain, head),
  };

  async append(draft: AuditDraft) {
    // One writer at a time per chain, like the database's row lock on the chain's head.
    const prior = this.locks.get(draft.chain) ?? Promise.resolve();
    const run = prior.then(() => this.appendNow(draft));
    this.locks.set(
      draft.chain,
      run.catch(() => undefined),
    );
    return run;
  }

  private appendNow(draft: AuditDraft): { record: AuditRecord; duplicate: boolean } {
    const list = this.chainsMap.get(draft.chain) ?? [];
    if (draft.sourceEventId !== undefined) {
      const dup = list.find((r) => r.sourceEventId === draft.sourceEventId);
      if (dup) return { record: structuredClone(dup), duplicate: true };
    }
    const record = sealRecord(
      draft,
      draft.at ?? this.now().toISOString(),
      `aud_${String(++this.n).padStart(8, '0')}`,
      this.heads.get(draft.chain),
    );
    list.push(record);
    this.chainsMap.set(draft.chain, list);
    this.heads.set(draft.chain, { seq: record.seq, hash: record.hash });
    for (const l of this.listeners)
      if (!l.chains || l.chains.includes(record.chain)) l.fn(structuredClone(record));
    return { record: structuredClone(record), duplicate: false };
  }

  async read(chain: string, o: AuditReadOptions = {}) {
    return (this.chainsMap.get(chain) ?? [])
      .filter(
        (r) =>
          r.seq > (o.afterSeq ?? 0) &&
          (o.from === undefined || r.at >= o.from) &&
          (o.to === undefined || r.at <= o.to),
      )
      .slice(0, o.limit ?? 1000)
      .map((r) => structuredClone(r));
  }

  async head(chain: string) {
    const h = this.heads.get(chain);
    return h ? { ...h } : undefined;
  }

  async chains(prefix?: string) {
    return [...this.chainsMap.keys()].filter((c) => !prefix || c.startsWith(prefix)).sort();
  }

  async verify(chain: string, o: AuditVerifyOptions = {}) {
    const v = new ChainVerifier(chain);
    for (const r of this.chainsMap.get(chain) ?? []) {
      v.push(r);
      if (o.blobs && r.blob) {
        const bytes = await o.blobs.get(r.blob.sha256);
        if (!bytes) v.note(r.seq, 'blob_missing', r.blob.sha256);
        else if (sha256Hex(bytes) !== r.blob.sha256) v.note(r.seq, 'blob_mismatch', r.blob.sha256);
      }
    }
    return v.finish({
      ...(o.expectedHead ? { expectedHead: o.expectedHead } : {}),
      storedHead: this.heads.get(chain),
    });
  }

  subscribe(fn: (r: AuditRecord) => void, chains?: string[]) {
    const l = { fn, ...(chains ? { chains } : {}) };
    this.listeners.add(l);
    return () => void this.listeners.delete(l);
  }
}
