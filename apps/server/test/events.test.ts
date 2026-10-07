import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { API_BASE_PATH, eventEnvelope, operation, type EventEnvelope } from '@kramahq/contract';
import { CursorGoneError } from '@kramahq/engine';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildApi,
  createKrama,
  loadConfig,
  OperationRegistry,
  TicketStore,
  type Krama,
} from '../src/index.js';

const TOKEN = 'test-token-0123456789abcdef';
const auth = { authorization: `Bearer ${TOKEN}` };
const V1 = API_BASE_PATH;

let home: string;
let krama: Krama;
let app: FastifyInstance;
let base: string;

async function startApi(
  o: Parameters<typeof buildApi>[0] extends infer T ? Partial<T> : never = {},
) {
  const config = loadConfig({ argv: ['--home', home, '--token', TOKEN, '--port', '0'], env: {} });
  const a = await buildApi({ krama, config, validateResponses: true, ...o });
  await a.listen({ port: 0, host: '127.0.0.1' });
  const port = (a.server.address() as { port: number }).port;
  return { app: a, base: `http://127.0.0.1:${port}${V1}` };
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'krama-events-'));
  krama = await createKrama({ home, packs: [], definitions: [] });
  ({ app, base } = await startApi({ heartbeatMs: 40 }));
}, 60_000);

afterAll(async () => {
  await app?.close();
  await krama?.close();
  rmSync(home, { recursive: true, force: true });
});

const append = (type: string, runId?: string, n = 1): Promise<EventEnvelope> =>
  krama.ports.events.append({
    type,
    ...(runId ? { runId: runId as `run_${string}` } : {}),
    subject: { type: runId ? 'run' : 'agent', id: runId ?? 'agt_1' },
    data: { n },
  });

interface Frame {
  id?: string;
  event?: string;
  data?: string;
  comment?: string;
}

/** Reads server-sent events from a fetch response, one frame at a time. */
function reader(res: Response) {
  const dec = new TextDecoder();
  const body = res.body!.getReader();
  let buf = '';
  const next = async (timeoutMs = 3000): Promise<Frame | undefined> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const at = buf.indexOf('\n\n');
      if (at >= 0) {
        const raw = buf.slice(0, at);
        buf = buf.slice(at + 2);
        const f: Frame = {};
        for (const line of raw.split('\n')) {
          if (line.startsWith(':')) f.comment = line.slice(1).trim();
          else if (line.startsWith('id: ')) f.id = line.slice(4);
          else if (line.startsWith('event: ')) f.event = line.slice(7);
          else if (line.startsWith('data: ')) f.data = line.slice(6);
        }
        return f;
      }
      const left = deadline - Date.now();
      if (left <= 0) throw new Error('timed out waiting for a frame');
      const r = await Promise.race([
        body.read(),
        new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), left)),
      ]);
      if (r === 'timeout') throw new Error('timed out waiting for a frame');
      if (r.done) return undefined;
      buf += dec.decode(r.value, { stream: true });
    }
  };
  /** The next frame that carries an event, skipping comments. */
  const nextEvent = async (): Promise<EventEnvelope> => {
    for (;;) {
      const f = await next();
      if (!f) throw new Error('the stream ended');
      if (f.data) return eventEnvelope.parse(JSON.parse(f.data));
    }
  };
  return { next, nextEvent, cancel: () => body.cancel() };
}

const open = (path: string, headers: Record<string, string> = auth) =>
  fetch(`${base}${path}`, { headers: { accept: 'text/event-stream', ...headers } });

describe('tickets', () => {
  it('issues a ticket that opens a stream once', async () => {
    const t = await fetch(`${base}/events/tickets`, { method: 'POST', headers: auth });
    expect(t.status).toBe(201);
    const { ticket, expiresAt } = (await t.json()) as { ticket: string; expiresAt: string };
    expect(ticket).toMatch(/^tk_/);
    expect(Date.parse(expiresAt) - Date.now()).toBeGreaterThan(50_000);

    const first = await open(`/events?ticket=${ticket}`, {});
    expect(first.status).toBe(200);
    expect(first.headers.get('content-type')).toContain('text/event-stream');
    await first.body!.cancel();

    const second = await open(`/events?ticket=${ticket}`, {});
    expect(second.status).toBe(401);
    expect((await second.json()).code).toBe('unauthenticated');
  });

  it('refuses an unknown ticket and a missing token, and never accepts a ticket off a stream route', async () => {
    expect((await open('/events?ticket=tk_nope', {})).status).toBe(401);
    expect((await open('/events', {})).status).toBe(401);
    const { ticket } = (await (
      await fetch(`${base}/events/tickets`, { method: 'POST', headers: auth })
    ).json()) as { ticket: string };
    const res = await fetch(`${base}/me?ticket=${ticket}`);
    expect(res.status).toBe(401);
  });

  it('expires after its lifetime and is spent by a failed use', () => {
    let t = 1_000;
    const store = new TicketStore(() => t, 60_000);
    const p = { id: 'u', name: 'U', roles: ['viewer'], permissions: [] };
    const a = store.issue(p).ticket;
    t += 59_999;
    expect(store.consume(a)).toEqual(p);
    expect(store.consume(a)).toBeUndefined();
    const b = store.issue(p).ticket;
    t += 60_001;
    expect(store.consume(b)).toBeUndefined();
    expect(store.size).toBe(0);
  });
});

describe('replay as JSON', () => {
  it('returns events after a cursor, filtered by topic, with a cursor to continue from', async () => {
    const mark = await append('agent.idle');
    await append('run.started', 'run_a');
    await append('run.paused', 'run_b');
    await append('run.resumed', 'run_a');
    const get = (q: string) =>
      fetch(`${base}/events?${q}`, { headers: { ...auth, accept: 'application/json' } });

    const all = (await (await get(`after=${mark.id}`)).json()) as {
      items: EventEnvelope[];
      nextCursor?: string;
    };
    expect(all.items.map((e) => e.type)).toEqual(['run.started', 'run.paused', 'run.resumed']);
    expect(all.nextCursor).toBe(all.items.at(-1)!.id);

    const onlyA = (await (await get(`after=${mark.id}&topics=run:run_a`)).json()) as {
      items: EventEnvelope[];
    };
    expect(onlyA.items.map((e) => e.type)).toEqual(['run.started', 'run.resumed']);

    const limited = (await (await get(`after=${mark.id}&limit=2`)).json()) as {
      items: EventEnvelope[];
    };
    expect(limited.items).toHaveLength(2);
    const rest = (await (await get(`after=${limited.items[1]!.id}`)).json()) as {
      items: EventEnvelope[];
    };
    expect(rest.items.map((e) => e.type)).toEqual(['run.resumed']);
    const none = (await (await get(`after=${rest.items[0]!.id}`)).json()) as {
      items: unknown[];
      nextCursor?: string;
    };
    expect(none.items).toEqual([]);
    expect(none.nextCursor).toBeUndefined();
  });

  it('rejects an unknown topic and a malformed cursor as validation problems', async () => {
    const get = (q: string) =>
      fetch(`${base}/events?${q}`, { headers: { ...auth, accept: 'application/json' } });
    const t = await get('topics=nonsense');
    expect(t.status).toBe(422);
    expect((await t.json()).errors[0].field).toBe('topics');
    const c = await get('after=abc');
    expect(c.status).toBe(422);
    expect((await c.json()).errors[0].field).toBe('after');
  });

  it('answers 410 when the log no longer has the cursor, on a page and on a stream', async () => {
    const real = krama.ports.events.read.bind(krama.ports.events);
    krama.ports.events.read = async () => {
      throw new CursorGoneError('000000001');
    };
    try {
      const page = await fetch(`${base}/events?after=000000001`, {
        headers: { ...auth, accept: 'application/json' },
      });
      expect(page.status).toBe(410);
      expect((await page.json()).code).toBe('gone');
      const stream = await open('/events', { ...auth, 'last-event-id': '000000001' });
      expect(stream.status).toBe(410);
      expect(app.server.listening).toBe(true);
    } finally {
      krama.ports.events.read = real;
    }
  });
});

describe('live streams', () => {
  it('delivers events as they happen, with their cursor as the id, and filters by topic', async () => {
    const res = await open('/events?topics=run:run_live');
    expect(res.status).toBe(200);
    const r = reader(res);
    expect((await r.next()).comment).toBe('connected');
    await append('run.started', 'run_other');
    const sent = await append('run.started', 'run_live');
    const got = await r.nextEvent();
    expect(got.id).toBe(sent.id);
    expect(got.runId).toBe('run_live');
    await r.cancel();
  });

  it('resumes from Last-Event-ID with no gap and no repeat, even when events arrive during the replay', async () => {
    const before = await append('run.started', 'run_resume', 0);
    const missed = [
      await append('run.step', 'run_resume', 1),
      await append('run.step', 'run_resume', 2),
    ];

    // Slow the backlog read, and append while it is pending: those events must be held and delivered once, in order.
    const real = krama.ports.events.read.bind(krama.ports.events);
    let concurrent: EventEnvelope[] = [];
    krama.ports.events.read = async (o) => {
      // One event lands after the stream subscribed but before the backlog is read (it is in both the backlog and
      // the held events and must be sent once); another lands after the read (held only).
      const early = await append('run.step', 'run_resume', 3);
      const out = await real(o);
      concurrent = [early, await append('run.step', 'run_resume', 4)];
      return out;
    };
    let res: Response;
    try {
      res = await open('/events?topics=run:run_resume', { ...auth, 'last-event-id': before.id });
    } finally {
      krama.ports.events.read = real;
    }
    const r = reader(res);
    const seen: string[] = [];
    for (let i = 0; i < 4; i++) seen.push((await r.nextEvent()).id);
    expect(seen).toEqual([...missed, ...concurrent].map((e) => e.id));

    const later = await append('run.step', 'run_resume', 5);
    expect((await r.nextEvent()).id).toBe(later.id);
    await r.cancel();
  });

  it('resumes through the cursor query parameter for clients that cannot send the header', async () => {
    const before = await append('run.started', 'run_q');
    const next = await append('run.step', 'run_q');
    const r = reader(await open(`/events?topics=run:run_q&cursor=${before.id}`));
    expect((await r.nextEvent()).id).toBe(next.id);
    await r.cancel();
  });

  it('replays more than one page of backlog', async () => {
    const before = await append('run.started', 'run_big');
    const ids: string[] = [];
    for (let i = 0; i < 520; i++) ids.push((await append('run.step', 'run_big', i)).id);
    const r = reader(
      await open('/events?topics=run:run_big', { ...auth, 'last-event-id': before.id }),
    );
    const got: string[] = [];
    for (let i = 0; i < ids.length; i++) got.push((await r.nextEvent()).id);
    expect(got).toEqual(ids);
    await r.cancel();
  }, 30_000);

  it('sends heartbeats while idle', async () => {
    const r = reader(await open('/events?topics=run:run_idle'));
    const seen: Frame[] = [];
    for (let i = 0; i < 3; i++) seen.push((await r.next()) as Frame);
    expect(seen.some((f) => f.comment === 'heartbeat')).toBe(true);
    await r.cancel();
  });

  it('stops following when the client goes away', async () => {
    const before = krama.ports.events.subscribe.length; // reference only
    void before;
    const res = await open('/events?topics=run:run_gone');
    await res.body!.cancel();
    // A later event must not throw or leak: the log keeps working.
    await expect(append('run.step', 'run_gone')).resolves.toBeDefined();
  });
});

describe('run-scoped alias', () => {
  it('404s for a run that does not exist and streams only that run for one that does', async () => {
    const real = krama.ports.store.runs.get.bind(krama.ports.store.runs);
    krama.ports.store.runs.get = async (id: string) =>
      id === 'run_alias' ? ({ id } as never) : undefined;
    try {
      const missing = await open('/runs/run_nope/events');
      expect(missing.status).toBe(404);
      const res = await open('/runs/run_alias/events');
      expect(res.status).toBe(200);
      const r = reader(res);
      await append('run.step', 'run_elsewhere');
      const mine = await append('run.step', 'run_alias');
      expect((await r.nextEvent()).id).toBe(mine.id);
      await r.cancel();
      const page = await fetch(`${base}/runs/run_alias/events?after=000000000`, {
        headers: { ...auth, accept: 'application/json' },
      });
      expect(
        ((await page.json()) as { items: EventEnvelope[] }).items.every(
          (e) => e.runId === 'run_alias',
        ),
      ).toBe(true);
    } finally {
      krama.ports.store.runs.get = real;
    }
  });
});

describe('limits and shutdown', () => {
  it('refuses a stream past the cap with 429 and a retry hint', async () => {
    const small = await startApi({ maxStreams: 1 });
    try {
      const url = (p: string) =>
        fetch(`${small.base}${p}`, { headers: { accept: 'text/event-stream', ...auth } });
      const a = await url('/events');
      expect(a.status).toBe(200);
      const b = await url('/events');
      expect(b.status).toBe(429);
      expect(b.headers.get('retry-after')).toBe('5');
      await a.body!.cancel();
    } finally {
      await small.app.close();
    }
  });

  it('ends open streams when the server closes', async () => {
    const s = await startApi();
    const res = await fetch(`${s.base}/events`, {
      headers: { accept: 'text/event-stream', ...auth },
    });
    const r = reader(res);
    await r.next();
    await s.app.close();
    // After close the stream ends instead of hanging.
    let ended = false;
    for (let i = 0; i < 5 && !ended; i++)
      ended = (await r.next(1000).catch(() => undefined)) === undefined;
    expect(ended).toBe(true);
  });
});

describe('operations', () => {
  const principal = { id: 'u_1', name: 'U', roles: ['operator'], permissions: [] };
  const other = { id: 'u_2', name: 'V', roles: ['operator'], permissions: [] };
  const admin = { id: 'u_3', name: 'A', roles: ['admin'], permissions: [] };
  const mk = () => new OperationRegistry(krama.ports.events, krama.ports.ids);
  const until = async (fn: () => boolean) => {
    for (let i = 0; i < 100 && !fn(); i++) await new Promise((r) => setTimeout(r, 10));
  };

  it('runs work to success, reports progress, and publishes operation events on its own topic', async () => {
    const reg = mk();
    const started = reg.start({ type: 'test', owner: principal.id }, async (c) => {
      c.progress(0.5, 'half');
      return { done: true };
    });
    expect(started.status).toBe('queued');
    await until(() => reg.get(started.id, principal).status === 'succeeded');
    const op = operation.parse(reg.get(started.id, principal));
    expect(op).toMatchObject({ status: 'succeeded', progress: 1, result: { done: true } });
    const events = await krama.ports.events.read({ topics: [`operations:${started.id}`] });
    expect(events.map((e) => e.type)).toEqual([
      'operation.progress',
      'operation.progress',
      'operation.succeeded',
    ]);
    expect(events.every((e) => e.subject.id === started.id)).toBe(true);
  });

  it('records a failure as a problem without leaking the error message', async () => {
    const reg = mk();
    const o = reg.start({ type: 'test', owner: principal.id }, async () => {
      throw new Error('secret path /etc/shadow');
    });
    await until(() => reg.get(o.id, principal).status === 'failed');
    const op = reg.get(o.id, principal);
    expect(op.error?.code).toBe('internal');
    expect(JSON.stringify(op)).not.toContain('shadow');
  });

  it('cancels running work by aborting its signal; a late result does not undo the cancel', async () => {
    const reg = mk();
    let aborted = false;
    const o = reg.start(
      { type: 'test', owner: principal.id },
      (c) =>
        new Promise((resolve) => {
          const stop = () => {
            aborted = true;
            resolve({ late: true });
          };
          if (c.signal.aborted) stop();
          else c.signal.addEventListener('abort', stop);
        }),
    );
    await until(() => reg.get(o.id, principal).status === 'running');
    const canceled = await reg.cancel(o.id, principal);
    expect(canceled.status).toBe('canceled');
    await until(() => aborted);
    expect(aborted).toBe(true);
    expect(reg.get(o.id, principal).status).toBe('canceled');
    expect(reg.get(o.id, principal).result).toBeUndefined();
    expect((await reg.cancel(o.id, principal)).status).toBe('canceled'); // twice is harmless
  });

  it('refuses to cancel finished work, and hides an operation from someone else', async () => {
    const reg = mk();
    const o = reg.start({ type: 'test', owner: principal.id }, async () => undefined);
    await until(() => reg.get(o.id, principal).status === 'succeeded');
    await expect(reg.cancel(o.id, principal)).rejects.toMatchObject({
      problem: { code: 'conflict' },
    });
    expect(() => reg.get(o.id, other)).toThrow(/does not exist/i);
    expect(reg.get(o.id, admin).id).toBe(o.id);
  });

  it('serves GET and cancel over HTTP for the owner only', async () => {
    const reg = new OperationRegistry(krama.ports.events, krama.ports.ids);
    const s = await startApi({
      validateResponses: false,
      handlers: {
        createRun: (req) =>
          req.ctx.operations.start(
            { type: 'demo', owner: req.principal.id },
            (c) => new Promise((resolve) => c.signal.addEventListener('abort', () => resolve())),
          ),
      },
    });
    void reg;
    try {
      const post = await fetch(`${s.base}/runs`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ input: { text: 'x' }, packId: 'pack_x' }),
      });
      const created = (await post.json()) as { id: string };
      const got = await fetch(`${s.base}/operations/${created.id}`, { headers: auth });
      expect(got.status).toBe(200);
      expect(operation.parse(await got.json()).type).toBe('demo');
      const c = await fetch(`${s.base}/operations/${created.id}/cancel`, {
        method: 'POST',
        headers: auth,
      });
      expect(operation.parse(await c.json()).status).toBe('canceled');
      expect((await fetch(`${s.base}/operations/op_missing`, { headers: auth })).status).toBe(404);
      expect((await fetch(`${s.base}/operations/${created.id}`)).status).toBe(401);
    } finally {
      await s.app.close();
    }
  });
});
