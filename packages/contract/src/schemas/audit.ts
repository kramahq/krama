import { z } from 'zod';
import { iso } from './common.js';

/** What `prev` holds for the first record of a chain. */
export const AUDIT_GENESIS = '0'.repeat(64);

/** `control` (who did what, platform-wide) or `run:<runId>` (everything said and emitted in one run). */
export const auditChainName = z.string().regex(/^(control|run:[A-Za-z0-9_-]+)$/);
export type AuditChain = z.infer<typeof auditChainName>;

export const AUDIT_SOURCES = [
  'a2a-stream',
  'http-sink',
  'gateway-tap',
  'mcp',
  'api',
  'system',
] as const;

export const auditActor = z.object({
  type: z.enum(['user', 'orchestrator', 'agent', 'system']),
  id: z.string(),
  instanceId: z.string().optional(),
  role: z.string().optional(),
});
export type AuditActor = z.infer<typeof auditActor>;

/** A body too large to keep inline, stored by its content hash. */
export const auditBlobRef = z.object({
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  bytes: z.number().int().nonnegative(),
  mediaType: z.string(),
});
export type AuditBlobRef = z.infer<typeof auditBlobRef>;

/**
 * One append-only, hash-chained record. `hash` covers every other field including `prev`, so changing, removing or
 * reordering a record breaks the chain at that point. `seq` has no gaps within a chain; a gap is a finding.
 */
export const auditRecord = z.object({
  id: z.string(),
  chain: auditChainName,
  seq: z.number().int().min(1),
  at: iso,
  actor: auditActor,
  /** `message.user`, `message.agent`, `tool.call`, `tool.result`, `thinking`, `decision.resolved`, `install.pack`, ... */
  kind: z.string().min(1),
  runId: z.string().optional(),
  phaseId: z.string().optional(),
  stepId: z.string().optional(),
  decisionId: z.string().optional(),
  correlation: z.record(z.string(), z.string()).optional(),
  source: z.enum(AUDIT_SOURCES),
  /** The sender's own event id; a second record with the same value in a chain is not written (de-duplication). */
  sourceEventId: z.string().optional(),
  /** The body, when small enough to keep inline. */
  payload: z.unknown().optional(),
  /** The body, when it is not. Exactly one of `payload` and `blob` is meaningful; both absent means no body. */
  blob: auditBlobRef.optional(),
  redaction: z.object({ applied: z.boolean(), rules: z.array(z.string()) }).optional(),
  prev: z.string().regex(/^[0-9a-f]{64}$/),
  hash: z.string().regex(/^[0-9a-f]{64}$/),
});
export type AuditRecord = z.infer<typeof auditRecord>;

/** What a writer supplies; the ledger adds `id`, `seq`, `prev` and `hash` (and `at` when omitted). */
export type AuditDraft = Omit<AuditRecord, 'id' | 'seq' | 'prev' | 'hash' | 'at'> & { at?: string };

export type AuditBreakReason =
  | 'hash_mismatch'
  | 'prev_mismatch'
  | 'seq_gap'
  | 'chain_mismatch'
  | 'head_mismatch'
  | 'blob_missing'
  | 'blob_mismatch';

export const auditVerifyResult = z.object({
  ok: z.boolean(),
  chain: z.string(),
  /** Records checked. */
  count: z.number().int(),
  /** The last record's position and hash, when the chain is not empty. */
  head: z.object({ seq: z.number().int(), hash: z.string() }).optional(),
  /** The first problem found, if any. */
  firstBreak: z
    .object({
      seq: z.number().int(),
      reason: z.enum([
        'hash_mismatch',
        'prev_mismatch',
        'seq_gap',
        'chain_mismatch',
        'head_mismatch',
        'blob_missing',
        'blob_mismatch',
      ]),
      detail: z.string().optional(),
    })
    .optional(),
});
export type AuditVerifyResult = z.infer<typeof auditVerifyResult>;
