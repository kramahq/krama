import type { EventEnvelope } from '@kramahq/contract';

/** `connecting` is the first attempt, `reconnecting` every later one, `disconnected` after `close()` or a fatal answer. */
export type StreamStatus = 'connecting' | 'live' | 'reconnecting' | 'disconnected';

export interface EventStreamOptions {
  url: string;
  headers?: Record<string, string>;
  topics?: readonly string[];
  /** Resume after this event id. */
  cursor?: string | undefined;
  onEvent(e: EventEnvelope): void;
  onStatus?(status: StreamStatus, info?: { reason?: string }): void;
  /** The server no longer has events back to our cursor (410). Fetch a fresh snapshot, then connect again without a cursor. */
  onGone?(): void;
  fetch?: typeof fetch;
  /** Reconnect delays in ms; the last value repeats. */
  backoffMs?: readonly number[];
  /** Give up on a connection that sends nothing (not even a heartbeat) for this long. Default 45 s. */
  idleMs?: number;
}

export interface EventStream {
  close(): void;
  /** The id of the last event delivered. */
  cursor(): string | undefined;
}

/** One parsed server-sent event. */
interface Frame {
  id?: string;
  event?: string;
  data: string;
}

/** Splits an SSE byte stream into frames. Comments (heartbeats) are skipped but still count as activity. */
export async function* frames(
  body: ReadableStream<Uint8Array>,
  onActivity: () => void,
): AsyncGenerator<Frame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let cur: Frame = { data: '' };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      onActivity();
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.search(/\r?\n/)) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(buf.charAt(nl) === '\r' && buf.charAt(nl + 1) === '\n' ? nl + 2 : nl + 1);
        if (line === '') {
          if (cur.data !== '' || cur.event !== undefined) yield cur;
          cur = { data: '' };
        } else if (line.startsWith(':')) {
          continue;
        } else {
          const i = line.indexOf(':');
          const field = i < 0 ? line : line.slice(0, i);
          const val = i < 0 ? '' : line.slice(i + 1).replace(/^ /, '');
          if (field === 'id') cur.id = val;
          else if (field === 'event') cur.event = val;
          else if (field === 'data') cur.data += (cur.data ? '\n' : '') + val;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Opens the event stream and keeps it open: it reconnects with backoff and resumes from the last event id it delivered,
 * so a client that drops and comes back receives exactly the events it missed. Status changes are reported so a screen can
 * show "reconnecting". A `410` is not retried: the caller must take a fresh snapshot (`onGone`).
 */
export function connectEvents(o: EventStreamOptions): EventStream {
  const doFetch = o.fetch ?? fetch;
  const delays = o.backoffMs ?? [1000, 2000, 4000, 8000, 15000];
  const ctl = new AbortController();
  let cursor = o.cursor;
  let closed = false;
  let attempt = 0;

  const status = (s: StreamStatus, reason?: string) => {
    if (!closed || s === 'disconnected') o.onStatus?.(s, reason ? { reason } : undefined);
  };

  const run = async () => {
    while (!closed) {
      status(attempt === 0 ? 'connecting' : 'reconnecting');
      const conn = new AbortController();
      const abort = () => conn.abort();
      ctl.signal.addEventListener('abort', abort, { once: true });
      let idle: ReturnType<typeof setTimeout> | undefined;
      const bump = () => {
        clearTimeout(idle);
        idle = setTimeout(() => conn.abort(), o.idleMs ?? 45_000);
      };
      try {
        const here = (globalThis as { location?: { href: string } }).location?.href;
        const url = new URL(o.url, here);
        if (o.topics?.length) url.searchParams.set('topics', o.topics.join(','));
        bump();
        const res = await doFetch(url, {
          headers: {
            accept: 'text/event-stream',
            ...(cursor ? { 'last-event-id': cursor } : {}),
            ...(o.headers ?? {}),
          },
          signal: conn.signal,
        });
        if (res.status === 410) {
          o.onGone?.();
          status('disconnected', 'The server no longer has events back to our position');
          return;
        }
        if (res.status === 401 || res.status === 403) {
          status('disconnected', `Not allowed (${res.status})`);
          return;
        }
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        attempt = 0;
        status('live');
        for await (const f of frames(res.body, bump)) {
          if (f.id) cursor = f.id;
          if (f.data === '') continue;
          try {
            o.onEvent(JSON.parse(f.data) as EventEnvelope);
          } catch {
            /* a frame that is not an event is skipped */
          }
        }
      } catch {
        /* dropped, refused or idle: reconnect below */
      } finally {
        clearTimeout(idle);
        ctl.signal.removeEventListener('abort', abort);
      }
      if (closed) return;
      const wait = delays[Math.min(attempt, delays.length - 1)] ?? 1000;
      attempt += 1;
      status('reconnecting');
      await new Promise((r) => setTimeout(r, wait));
    }
  };
  void run();

  return {
    close() {
      if (closed) return;
      closed = true;
      ctl.abort();
      o.onStatus?.('disconnected');
    },
    cursor: () => cursor,
  };
}
