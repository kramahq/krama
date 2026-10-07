import type { AuditBlobRef, AuditDraft, AuditRecord } from '@kramahq/contract';
import type { AuditBlobs, AuditLedger } from '../ports/index.js';

/** A payload whose JSON is larger than this (16 KiB, from the M2.5 spike: inline and blob cost the same up to about there, inline gets slower and bulkier beyond it) goes to the blob store and the record keeps its hash. */
export const INLINE_PAYLOAD_MAX_BYTES = 16 * 1024;

export type AuditWrite = Omit<AuditDraft, 'payload' | 'blob'> & {
  /** Anything JSON-serialisable. Kept inline when small, otherwise stored as a blob. */
  payload?: unknown;
  /** A body that is already bytes (a file, a raw frame). Always stored as a blob. */
  bytes?: Uint8Array;
  mediaType?: string;
};

/**
 * Writes records to the ledger, moving large bodies into the blob store first (so a record never points at a blob
 * that was not written). The ledger stays small and fast to verify; the bytes stay lossless.
 */
export class AuditWriter {
  constructor(
    private readonly ledger: AuditLedger,
    private readonly blobs: AuditBlobs,
    private readonly inlineMax: number = INLINE_PAYLOAD_MAX_BYTES,
  ) {}

  async write(w: AuditWrite): Promise<{ record: AuditRecord; duplicate: boolean }> {
    const { payload, bytes, mediaType, ...draft } = w;
    let blob: AuditBlobRef | undefined;
    let inline: unknown;
    if (bytes) {
      blob = await this.blobs.put(bytes, mediaType ?? 'application/octet-stream');
    } else if (payload !== undefined) {
      const json = JSON.stringify(payload);
      const raw = new TextEncoder().encode(json);
      if (raw.byteLength > this.inlineMax) blob = await this.blobs.put(raw, 'application/json');
      else inline = payload;
    }
    return this.ledger.append({
      ...draft,
      ...(inline !== undefined ? { payload: inline } : {}),
      ...(blob ? { blob } : {}),
    });
  }
}
