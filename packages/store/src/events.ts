import {
  CursorGoneError,
  type Clock,
  type EventDraft,
  type EventLog,
  type EventReadOptions,
} from '@kramahq/engine';
import type { EventEnvelope } from '@kramahq/contract';
import { and, asc, count, desc, eq, gt, like, lt, max, min, or, sql, type SQL } from 'drizzle-orm';
import type { Db } from './db.js';
import { events } from './schema.js';

export interface PgEventLogOptions {
  clock?: Clock;
  /** Keep at least this many of the newest events. Default 100 000. */
  retainCount?: number;
  /** Never prune events newer than this (contract: at least 24 h). Default 24 h; 0 = count only. */
  retainMs?: number;
  /** Prune every N appends. Default 500. */
  pruneEvery?: number;
}

export const cursorOf = (seq: number): string => String(seq).padStart(9, '0');

/** One SQL condition per topic (same vocabulary as the in-memory log); no topics means everything. */
function topicCondition(topics: string[] | undefined): SQL | undefined {
  if (!topics || topics.length === 0) return undefined;
  const conds = topics.map((t): SQL => {
    const [kind, id] = t.split(':') as [string, string | undefined];
    switch (kind) {
      case 'run':
        return id ? eq(events.runId, id) : sql`false`;
      case 'runs':
        return like(events.type, 'run.%');
      case 'inbox':
        return like(events.type, 'decision.%');
      case 'agent':
        return id ? and(eq(events.subjectType, 'agent'), eq(events.subjectId, id))! : sql`false`;
      case 'agents':
        return like(events.type, 'agent.%');
      case 'memory':
        return like(events.type, 'memory.%');
      case 'schedules':
        return like(events.type, 'schedule.%');
      case 'packs':
        return like(events.type, 'pack.%');
      case 'operations':
        return (
          id
            ? and(like(events.type, 'operation.%'), eq(events.subjectId, id))
            : like(events.type, 'operation.%')
        )!;
      case 'audit':
        return eq(events.type, 'audit.recorded');
      default:
        return sql`false`;
    }
  });
  return or(...conds);
}

/** Matches an envelope against topics in process (for live subscribers). */
function matches(e: EventEnvelope, topics: string[] | undefined): boolean {
  if (!topics || topics.length === 0) return true;
  return topics.some((t) => {
    const [kind, id] = t.split(':') as [string, string | undefined];
    switch (kind) {
      case 'run':
        return e.runId === id;
      case 'runs':
        return e.type.startsWith('run.');
      case 'inbox':
        return e.type.startsWith('decision.');
      case 'agent':
        return e.subject.type === 'agent' && e.subject.id === id;
      case 'agents':
        return e.type.startsWith('agent.');
      case 'memory':
        return e.type.startsWith('memory.');
      case 'schedules':
        return e.type.startsWith('schedule.');
      case 'packs':
        return e.type.startsWith('pack.');
      case 'operations':
        return e.type.startsWith('operation.') && (!id || e.subject.id === id);
      case 'audit':
        return e.type === 'audit.recorded';
      default:
        return false;
    }
  });
}

/**
 * `EventLog` on the database: persisted, cursor-ordered, replayable. Clients that drop resume with the last cursor and
 * receive exactly what they missed; a cursor older than retention gets `CursorGoneError` (HTTP 410).
 */
export class PgEventLog implements EventLog {
  private listeners = new Set<{ fn: (e: EventEnvelope) => void; topics?: string[] }>();
  private appends = 0;
  private readonly retainCount: number;
  private readonly retainMs: number;
  private readonly pruneEvery: number;
  private readonly now: () => Date;

  constructor(
    private readonly db: Db,
    o: PgEventLogOptions = {},
  ) {
    this.retainCount = o.retainCount ?? 100_000;
    this.retainMs = o.retainMs ?? 24 * 3_600_000;
    this.pruneEvery = o.pruneEvery ?? 500;
    this.now = o.clock ? () => o.clock!.now() : () => new Date();
  }

  async append(d: EventDraft): Promise<EventEnvelope> {
    const at = this.now().toISOString();
    const [row] = await this.db
      .insert(events)
      .values({
        type: d.type,
        at,
        runId: d.runId ?? null,
        subjectType: d.subject.type,
        subjectId: d.subject.id,
        data: { data: d.data ?? null, ...(d.actor ? { actor: d.actor } : {}) },
      })
      .returning({ seq: events.seq });
    const env: EventEnvelope = { ...structuredClone(d), id: cursorOf(row!.seq), at, schema: 1 };
    for (const l of this.listeners) if (matches(env, l.topics)) l.fn(structuredClone(env));
    if (++this.appends % this.pruneEvery === 0 || this.retainCount < 1000)
      await this.prune().catch(() => undefined);
    return env;
  }

  async read(o: EventReadOptions = {}): Promise<EventEnvelope[]> {
    const after = o.after ? Number(o.after) : 0;
    if (o.after !== undefined && Number.isFinite(after) && after > 0) {
      const [m] = await this.db
        .select({ floor: min(events.seq), top: max(events.seq) })
        .from(events);
      // Gone only when events existed beyond the cursor that were pruned: the cursor is below the oldest kept event.
      if (m?.floor != null && after + 1 < m.floor) throw new CursorGoneError(o.after);
    }
    const rows = await this.db
      .select()
      .from(events)
      .where(and(gt(events.seq, after), topicCondition(o.topics)))
      .orderBy(asc(events.seq))
      .limit(o.limit ?? 200);
    return rows.map((r) => {
      const body = r.data as { data: unknown; actor?: EventEnvelope['actor'] };
      return {
        id: cursorOf(r.seq),
        type: r.type,
        at: r.at,
        schema: 1,
        ...(r.runId ? { runId: r.runId as EventEnvelope['runId'] } : {}),
        subject: { type: r.subjectType, id: r.subjectId },
        ...(body.actor ? { actor: body.actor } : {}),
        data: body.data,
      };
    });
  }

  subscribe(fn: (e: EventEnvelope) => void, topics?: string[]): () => void {
    const l = { fn, ...(topics ? { topics } : {}) };
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  async latestCursor(): Promise<string | undefined> {
    const [m] = await this.db.select({ top: max(events.seq) }).from(events);
    return m?.top != null ? cursorOf(m.top) : undefined;
  }

  /** Drops events beyond the count that are also older than the age floor. Returns how many were removed. */
  async prune(): Promise<number> {
    const [m] = await this.db.select({ top: max(events.seq), n: count() }).from(events);
    if (!m?.top || m.n <= this.retainCount) return 0;
    const cutoffSeq = m.top - this.retainCount;
    const cutoffAt = new Date(this.now().getTime() - this.retainMs).toISOString();
    const where =
      this.retainMs > 0
        ? and(lt(events.seq, cutoffSeq + 1), lt(events.at, cutoffAt))
        : lt(events.seq, cutoffSeq + 1);
    const gone = await this.db.delete(events).where(where).returning({ seq: events.seq });
    return gone.length;
  }

  /** Oldest cursor still available (for the 410 snapshot hint). */
  async oldestCursor(): Promise<string | undefined> {
    const [m] = await this.db.select({ floor: min(events.seq) }).from(events);
    return m?.floor != null ? cursorOf(m.floor) : undefined;
  }

  /** Newest `n` events, newest first (diagnostics). */
  async recent(n = 20): Promise<EventEnvelope[]> {
    const rows = await this.db.select().from(events).orderBy(desc(events.seq)).limit(n);
    return rows.map((r) => ({
      id: cursorOf(r.seq),
      type: r.type,
      at: r.at,
      schema: 1 as const,
      subject: { type: r.subjectType, id: r.subjectId },
      data: (r.data as { data: unknown }).data,
    }));
  }
}
