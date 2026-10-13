import type { ActorRef, AuditEntry, AuditRecord } from '@kramahq/contract';
import type { Handlers } from './context.js';
import { ApiProblem } from './problems.js';
import { ledgerOf } from './transcript.js';

const DEFAULT_LIMIT = 50;

interface Query {
  limit?: number;
  cursor?: string;
  actor?: string;
  action?: string;
  from?: string;
  to?: string;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * A control record as the audit log shows it. The control chain holds two shapes: a command (`payload` has the subject,
 * the actor's display name and what changed) and a finding the platform wrote itself (`payload` is the finding).
 */
export function presentControlRecord(r: AuditRecord): AuditEntry {
  const p = isObject(r.payload) ? r.payload : {};
  const subject = isObject(p['subject']) ? p['subject'] : undefined;
  const isCommand = typeof subject?.['type'] === 'string' && typeof subject['id'] === 'string';
  const detail = isCommand ? p['detail'] : r.payload;
  const actor: ActorRef = {
    type: r.actor.type,
    id: r.actor.id,
    ...(typeof p['actorName'] === 'string' ? { name: p['actorName'] } : {}),
    ...(r.actor.role ? { role: r.actor.role } : {}),
  };
  return {
    id: r.id,
    at: r.at,
    actor,
    action: r.kind,
    subject: isCommand
      ? { type: String(subject['type']), id: String(subject['id']) }
      : { type: 'control', id: r.id },
    ...(isObject(detail) ? { detail } : {}),
    seq: r.seq,
    hash: r.hash,
  };
}

const encodeCursor = (beforeSeq: number): string =>
  Buffer.from(JSON.stringify({ b: beforeSeq })).toString('base64url');

function decodeCursor(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  try {
    const v = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as { b?: unknown };
    if (typeof v.b === 'number' && Number.isInteger(v.b) && v.b > 0) return v.b;
  } catch {
    /* falls through to the problem below */
  }
  throw new ApiProblem('validation_failed', 'The cursor is not valid', {
    errors: [{ field: 'cursor', message: 'Use the nextCursor of a previous page' }],
  });
}

/** An instant as the ledger stores it (UTC, milliseconds), so a range compares correctly as text. */
function instant(raw: string | undefined, field: string): string | undefined {
  if (raw === undefined || raw === '') return undefined;
  const t = Date.parse(raw);
  if (Number.isNaN(t))
    throw new ApiProblem('validation_failed', 'Not a date and time', {
      errors: [
        { field, message: 'Use an ISO 8601 date or date and time, e.g. 2026-10-01T00:00:00Z' },
      ],
    });
  return new Date(t).toISOString();
}

/** `GET /audit`: the control chain (who did what), newest first, by actor, action and time range. */
export function auditHandlers(): Handlers {
  return {
    listAudit: async (req) => {
      const q = req.query as Query;
      const { ledger } = ledgerOf(req.ctx.krama.ports);
      const limit = Math.min(Math.max(Math.trunc(q.limit ?? DEFAULT_LIMIT), 1), 200);
      const from = instant(q.from, 'from');
      const to = instant(q.to, 'to');
      if (from && to && from > to)
        throw new ApiProblem('validation_failed', 'The range ends before it starts', {
          errors: [{ field: 'to', message: '`to` must not be before `from`' }],
        });
      const before = decodeCursor(q.cursor);
      const rows = await ledger.read('control', {
        order: 'desc',
        limit: limit + 1,
        ...(before ? { beforeSeq: before } : {}),
        ...(q.actor ? { actor: q.actor } : {}),
        ...(q.action ? { kind: q.action } : {}),
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
      });
      const items = rows.slice(0, limit).map(presentControlRecord);
      return {
        items,
        ...(rows.length > limit ? { nextCursor: encodeCursor(items.at(-1)!.seq!) } : {}),
      };
    },
  };
}
