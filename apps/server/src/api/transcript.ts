import type { AuditRecord } from '@kramahq/contract';
import type { Ports } from '@kramahq/engine';
import type { Handlers } from './context.js';
import { ApiProblem, notFound } from './problems.js';
import { RawBody } from './raw.js';

/** The chain that holds everything said and done in one run (ADR-0013). */
export const transcriptChain = (runId: string): string => `run:${runId}`;

const DEFAULT_LIMIT = 200;
/** Records read from the ledger per round trip when a filter has to skip some. */
const SCAN = 500;
/** The most records one filtered request looks at, so a filter that matches nothing cannot read a whole long run. */
const MAX_SCAN = 10_000;

interface Query {
  after?: string;
  limit?: number;
  kind?: string;
  agent?: string;
  phase?: string;
}

/** The ledger and blob store, or a 501 that says why there is no transcript to read. */
export function ledgerOf(ports: Ports): {
  ledger: NonNullable<Ports['ledger']>;
  blobs: Ports['auditBlobs'];
} {
  if (!ports.ledger)
    throw new ApiProblem(
      'not_implemented',
      'This server keeps no audit ledger, so there is no transcript',
    );
  return { ledger: ports.ledger, blobs: ports.auditBlobs };
}

/** A position in the chain, as the cursor a client passes back. */
export function parseSeq(v: string | undefined, field: string): number | undefined {
  if (v === undefined || v === '') return undefined;
  if (!/^\d{1,15}$/.test(v))
    throw new ApiProblem('validation_failed', 'The cursor is not a position in the transcript', {
      errors: [{ field, message: 'Use the nextCursor of a previous page, or a record seq' }],
    });
  return Number(v);
}

const matches = (r: AuditRecord, q: Query): boolean =>
  (!q.kind || r.kind === q.kind || r.kind.startsWith(`${q.kind}.`)) &&
  (!q.agent || r.actor.id === q.agent || r.actor.instanceId === q.agent) &&
  (!q.phase || r.phaseId === q.phase);

/**
 * `GET /runs/{id}/transcript`, its blobs and its verification. The transcript is the run's own hash chain, read as it was
 * written: nothing is clipped, and a body too large to keep inline is fetched by its hash.
 */
export function transcriptHandlers(): Handlers {
  return {
    listTranscript: async (req) => {
      const { ports } = req.ctx.krama;
      const runId = req.params['id']!;
      const q = req.query as Query;
      if (!(await ports.store.runs.get(runId))) throw notFound('Run', runId);
      const { ledger } = ledgerOf(ports);
      const chain = transcriptChain(runId);
      const limit = Math.min(Math.max(Math.trunc(q.limit ?? DEFAULT_LIMIT), 1), 1000);
      let lastScanned = parseSeq(q.after, 'after') ?? 0;

      const items: AuditRecord[] = [];
      let scanned = 0;
      let nextCursor: string | undefined;
      scan: for (;;) {
        const batch = await ledger.read(chain, { afterSeq: lastScanned, limit: SCAN });
        for (const r of batch) {
          if (matches(r, q)) {
            // One more match exists beyond this page: say where to continue.
            if (items.length === limit) {
              nextCursor = String(items.at(-1)!.seq);
              break scan;
            }
            items.push(r);
          }
          lastScanned = r.seq;
          scanned++;
        }
        if (batch.length < SCAN) break; // the end of the chain
        // A filter this sparse resumes from where the scan stopped rather than reading a whole long run.
        if (scanned >= MAX_SCAN) {
          nextCursor = String(lastScanned);
          break;
        }
      }
      const head = await ledger.head(chain);
      return {
        items,
        ...(nextCursor ? { nextCursor } : {}),
        ...(head ? { head: { seq: head.seq, hash: head.hash } } : {}),
      };
    },

    getTranscriptBlob: async (req) => {
      const { ports } = req.ctx.krama;
      const runId = req.params['id']!;
      const sha = req.params['sha256']!;
      if (!/^[0-9a-f]{64}$/.test(sha))
        throw new ApiProblem('validation_failed', 'Not a content hash', {
          errors: [{ field: 'sha256', message: 'A blob is addressed by its 64-character sha256' }],
        });
      if (!(await ports.store.runs.get(runId))) throw notFound('Run', runId);
      const { ledger, blobs } = ledgerOf(ports);
      if (!blobs) throw new ApiProblem('not_implemented', 'This server keeps no blob store');
      // Only bodies this run's own records point to: a hash is not a capability to read any run's content.
      let ref: AuditRecord['blob'];
      for (let after = 0; !ref;) {
        const batch = await ledger.read(transcriptChain(runId), { afterSeq: after, limit: SCAN });
        if (batch.length === 0) break;
        ref = batch.find((r) => r.blob?.sha256 === sha)?.blob;
        after = batch.at(-1)!.seq;
      }
      if (!ref) throw notFound('Transcript blob', sha);
      const bytes = await blobs.get(sha);
      if (!bytes) throw notFound('Transcript blob content', sha);
      return new RawBody(Buffer.from(bytes), {
        mediaType: ref.mediaType,
        headers: {
          etag: `"${sha}"`,
          'cache-control': 'private, max-age=31536000, immutable',
          'x-content-type-options': 'nosniff',
          'content-disposition': 'attachment',
        },
      });
    },

    verifyTranscript: async (req) => {
      const { ports } = req.ctx.krama;
      const runId = req.params['id']!;
      if (!(await ports.store.runs.get(runId))) throw notFound('Run', runId);
      const { ledger, blobs } = ledgerOf(ports);
      return ledger.verify(transcriptChain(runId), blobs ? { blobs } : {});
    },
  };
}
