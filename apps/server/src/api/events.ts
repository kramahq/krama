import type { ServerResponse } from 'node:http';
import type { EventEnvelope } from '@kramahq/contract';
import { CursorGoneError } from '@kramahq/engine';
import type { AuditRecord } from '@kramahq/contract';
import { satisfies } from './auth.js';
import type { ApiRequest, Handlers, StreamContext, StreamHandlers } from './context.js';
import { STREAMED } from './context.js';
import { ApiProblem, notFound } from './problems.js';
import type { TicketStore } from './tickets.js';
import { ledgerOf, transcriptChain } from './transcript.js';

/** Events held back for one reader while it catches up, and the page size of a replay. */
const PAGE = 500;
const DEFAULT_JSON_LIMIT = 200;
const MAX_JSON_LIMIT = 1000;
/** A reader that lets more than this pile up unwritten is cut off; it reconnects and replays from its last id. */
const MAX_UNWRITTEN_BYTES = 1024 * 1024;
const MAX_TOPICS = 32;
const MAX_STREAMS = 100;

/** The topics the event log understands (`EventReadOptions.topics`). */
const TOPIC =
  /^(runs|inbox|agents|memory|schedules|packs|audit|operations|(run|agent|operations):[A-Za-z0-9_-]+|run:[A-Za-z0-9_-]+:transcript)$/;
const TRANSCRIPT_TOPIC = /^run:([A-Za-z0-9_-]+):transcript$/;
const CURSOR = /^\d+$/;

export function parseTopics(raw: string | undefined): string[] {
  const topics = (raw ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  if (topics.length > MAX_TOPICS)
    throw new ApiProblem('validation_failed', 'Too many topics', {
      errors: [{ field: 'topics', message: `At most ${MAX_TOPICS} topics` }],
    });
  const bad = topics.filter((t) => !TOPIC.test(t));
  if (bad.length)
    throw new ApiProblem('validation_failed', 'Unknown topic', {
      errors: bad.map((t) => ({ field: 'topics', message: `Unknown topic "${t}"` })),
    });
  const unique = [...new Set(topics)];
  // A transcript is read from the audit ledger and its cursor is a chain position, not an event id: it is served alone.
  if (unique.some((t) => TRANSCRIPT_TOPIC.test(t)) && unique.length > 1)
    throw new ApiProblem('validation_failed', 'A transcript topic is served on its own', {
      errors: [
        { field: 'topics', message: 'Do not combine run:<id>:transcript with other topics' },
      ],
    });
  return unique;
}

function parseCursor(raw: string | undefined, field: string): string | undefined {
  if (raw === undefined || raw === '') return undefined;
  if (!CURSOR.test(raw))
    throw new ApiProblem('validation_failed', 'The cursor is not valid', {
      errors: [{ field, message: 'A cursor is the id of an event' }],
    });
  return raw;
}

const goneProblem = () =>
  new ApiProblem(
    'gone',
    'The cursor is older than the events the server still keeps. Fetch a fresh snapshot, then resume from the latest cursor.',
  );

/** Where a stream reads its backlog and follows live records from: the event log, or one run's transcript. */
interface Feed {
  read(after: string | undefined, limit: number): Promise<EventEnvelope[]>;
  subscribe(listener: (e: EventEnvelope) => void): () => void;
}

/** A transcript record as a stream event: its id is its position in the chain, so `Last-Event-ID` resumes exactly. */
const transcriptEvent = (runId: string, r: AuditRecord): EventEnvelope => ({
  id: String(r.seq),
  type: 'transcript.record',
  at: r.at,
  schema: 1,
  runId: runId as EventEnvelope['runId'],
  subject: { type: 'run', id: runId },
  data: r,
});

export interface EventStreamOptions {
  tickets: TicketStore;
  /** How often an idle stream sends a comment so proxies and the client's idle timer see activity. */
  heartbeatMs?: number;
  maxStreams?: number;
}

export interface EventStreams {
  handlers: Handlers;
  streams: StreamHandlers;
  /** Ends every open stream (server shutdown). */
  closeAll(): void;
  readonly open: number;
}

/**
 * `GET /events`, `GET /runs/{id}/events` and `POST /events/tickets`. A stream is the event log: it replays what a
 * reconnecting client missed (`Last-Event-ID`) and then follows live, with no gap and no repeat between the two. With
 * `Accept: application/json` (or `?after=`) the same route returns one page of events instead.
 */
export function eventStreams(o: EventStreamOptions): EventStreams {
  const heartbeatMs = o.heartbeatMs ?? 15_000;
  const maxStreams = o.maxStreams ?? MAX_STREAMS;
  const open = new Set<() => void>();

  /** The feed for these topics, after checking who may read it: a transcript is unclipped, so it needs `operator`. */
  async function feedFor(req: ApiRequest, topics: string[]): Promise<Feed> {
    const { ports } = req.ctx.krama;
    const m = topics.length === 1 ? TRANSCRIPT_TOPIC.exec(topics[0]!) : null;
    if (!m) {
      return {
        read: (after, limit) => ports.events.read({ ...(after ? { after } : {}), topics, limit }),
        subscribe: (l) => ports.events.subscribe(l, topics),
      };
    }
    const runId = m[1]!;
    if (!satisfies(req.principal, 'operator'))
      throw new ApiProblem('forbidden', 'Reading a transcript needs the operator role');
    if (!(await ports.store.runs.get(runId))) throw notFound('Run', runId);
    const { ledger } = ledgerOf(ports);
    const chain = transcriptChain(runId);
    return {
      read: async (after, limit) => {
        const from = after ? Number(after) : 0;
        // A position past the end of the chain is not one this server ever issued: start from a fresh snapshot.
        if (from > 0 && from > ((await ledger.head(chain))?.seq ?? 0))
          throw new CursorGoneError(after!);
        return (await ledger.read(chain, { afterSeq: from, limit })).map((r) =>
          transcriptEvent(runId, r),
        );
      },
      subscribe: (l) => ledger.subscribe((r) => l(transcriptEvent(runId, r)), [chain]),
    };
  }

  async function serve(req: ApiRequest, s: StreamContext, topics: string[]): Promise<unknown> {
    const q = req.query as { cursor?: string; after?: string; limit?: number };
    const feed = await feedFor(req, topics);
    const accept = String(req.headers['accept'] ?? '');

    // A page of events.
    if (
      q.after !== undefined ||
      (accept.includes('application/json') && !accept.includes('text/event-stream'))
    ) {
      const after = parseCursor(q.after, 'after');
      const limit = Math.min(
        Math.max(Math.trunc(q.limit ?? DEFAULT_JSON_LIMIT), 1),
        MAX_JSON_LIMIT,
      );
      let items: EventEnvelope[];
      try {
        items = await feed.read(after, limit);
      } catch (e) {
        if (e instanceof CursorGoneError) throw goneProblem();
        throw e;
      }
      return { items, ...(items.length ? { nextCursor: items.at(-1)!.id } : {}) };
    }

    // A live stream.
    const header = req.headers['last-event-id'];
    const lastId = parseCursor((Array.isArray(header) ? header[0] : header) || q.cursor, 'cursor');
    if (open.size >= maxStreams)
      throw new ApiProblem('rate_limited', 'Too many open event streams', {
        headers: { 'retry-after': '5' },
      });

    // Follow first and replay second, so an event that arrives while the backlog is read is held, not lost.
    const held: EventEnvelope[] = [];
    let live = false;
    // The socket is taken only after the backlog's first page is read (so a 410 is still a normal problem answer).
    const conn: { res?: ServerResponse } = {};
    let lastSeq = lastId ? Number(lastId) : 0;
    const write = (e: EventEnvelope): void => {
      const seq = Number(e.id);
      if (seq <= lastSeq) return;
      lastSeq = seq;
      const ok = conn.res!.write(`id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
      if (!ok && conn.res!.writableLength > MAX_UNWRITTEN_BYTES) close();
    };
    const unsubscribe = feed.subscribe((e) => (live ? write(e) : held.push(e)));
    let beat: NodeJS.Timeout | undefined;
    let closed = false;
    function close(): void {
      if (closed) return;
      closed = true;
      clearInterval(beat);
      unsubscribe();
      open.delete(close);
      const res = conn.res;
      if (res && !res.writableEnded) {
        res.end();
        // A kept-alive connection would hold the server open on shutdown; flush what is written, then drop it.
        res.socket?.destroySoon?.();
      }
    }

    let first: EventEnvelope[] = [];
    try {
      if (lastId) first = await feed.read(lastId, PAGE);
    } catch (e) {
      unsubscribe();
      if (e instanceof CursorGoneError) throw goneProblem();
      throw e;
    }

    const res = (conn.res = s.hijack());
    res.writeHead(200, {
      ...s.headers,
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    open.add(close);
    res.on('close', close);
    res.on('error', close);
    res.write('retry: 2000\n: connected\n\n');

    try {
      let page = first;
      for (;;) {
        for (const e of page) write(e);
        if (page.length < PAGE || closed) break;
        page = await feed.read(String(lastSeq), PAGE);
      }
    } catch {
      // The log failed under us: end the stream; the client reconnects and tries again from its last id.
      close();
      return STREAMED;
    }
    live = true;
    for (const e of held.splice(0)) write(e);
    if (!closed) beat = setInterval(() => conn.res!.write(': heartbeat\n\n'), heartbeatMs).unref();
    return STREAMED;
  }

  const streams: StreamHandlers = {
    streamEvents: (req, s) => serve(req, s, parseTopics((req.query as { topics?: string }).topics)),
    streamRunEvents: async (req, s) => {
      const runId = req.params['id']!;
      if (!(await req.ctx.krama.ports.store.runs.get(runId))) throw notFound('Run', runId);
      return serve(req, s, [`run:${runId}`]);
    },
  };

  const handlers: Handlers = {
    createEventTicket: (req) => o.tickets.issue(req.principal),
  };

  return {
    handlers,
    streams,
    closeAll: () => {
      for (const c of [...open]) c();
    },
    get open() {
      return open.size;
    },
  };
}
