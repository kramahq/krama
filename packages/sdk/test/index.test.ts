import { describe, expect, it } from 'vitest';
import { ApiError, connectEvents, createClient, frames, type StreamStatus } from '../src/index.js';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('client', () => {
  it('builds the request: base url, query as csv, bearer token, JSON body', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const c = createClient({
      baseUrl: 'http://x/api/v1/',
      token: 'tkn',
      fetch: (async (url: string, init: RequestInit) => {
        seen.push({ url, init });
        return json(200, { items: [] });
      }) as unknown as typeof fetch,
    });
    await c.runs.list({ status: ['running', 'paused'], project: 'proj_a', limit: 5, q: undefined });
    await c.decisions.resolve('dec_1', { optionId: 'approve', input: 'ok' });
    expect(seen[0]!.url).toBe(
      'http://x/api/v1/runs?status=running%2Cpaused&project=proj_a&limit=5',
    );
    expect((seen[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer tkn');
    expect(seen[1]!.url).toBe('http://x/api/v1/decisions/dec_1/resolve');
    expect(seen[1]!.init.method).toBe('POST');
    expect(JSON.parse(String(seen[1]!.init.body))).toEqual({ optionId: 'approve', input: 'ok' });
  });

  it('turns a problem response into an ApiError that keeps the code and the trace id', async () => {
    const c = createClient({
      baseUrl: '/api/v1',
      fetch: (async () =>
        json(409, {
          type: 'x',
          title: 'Conflict',
          status: 409,
          code: 'decision_resolved',
          detail: 'Already resolved',
          traceId: 'tr_1',
        })) as unknown as typeof fetch,
    });
    const err = await c.decisions.get('dec_1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 409, code: 'decision_resolved', traceId: 'tr_1' });
    expect((err as ApiError).message).toBe('Already resolved');
  });

  it('reports an unreachable server as status 0, not as a crash', async () => {
    const c = createClient({
      baseUrl: 'http://nowhere/api/v1',
      fetch: (async () => {
        throw new TypeError('fetch failed');
      }) as unknown as typeof fetch,
    });
    const err = (await c.capabilities().catch((e: unknown) => e)) as ApiError;
    expect(err.status).toBe(0);
    expect(err.code).toBe('unreachable');
  });
});

const enc = new TextEncoder();
const stream = (chunks: string[], keepOpen = false) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      if (!keepOpen) c.close();
    },
  });
const sse = (body: ReadableStream<Uint8Array>, status = 200) =>
  new Response(body, { status, headers: { 'content-type': 'text/event-stream' } });
const evt = (id: string, type = 'run.updated') =>
  `id: ${id}\nevent: ${type}\ndata: ${JSON.stringify({ id, type, at: 'x', schema: 1, subject: { type: 'run', id: 'r' }, data: {} })}\n\n`;

describe('frames', () => {
  it('parses named events, ignores heartbeats, and handles chunks split anywhere', async () => {
    const out: unknown[] = [];
    const body = stream([
      ': connected\n\nid: 1\nev',
      'ent: a\ndata: {"n":',
      '1}\n\n: heartbeat\n\n',
      'id: 2\r\ndata: x\r\n\r\n',
    ]);
    for await (const f of frames(body, () => undefined)) out.push(f);
    expect(out).toEqual([
      { id: '1', event: 'a', data: '{"n":1}' },
      { id: '2', data: 'x' },
    ]);
  });
});

describe('the event stream', () => {
  const wait = async (cond: () => boolean, ms = 3000) => {
    const end = Date.now() + ms;
    while (!cond()) {
      if (Date.now() > end) throw new Error('timed out');
      await new Promise((r) => setTimeout(r, 5));
    }
  };

  it('resumes after a drop from the last event it delivered, and reports the status changes', async () => {
    const got: string[] = [];
    const statuses: StreamStatus[] = [];
    const resumedWith: (string | null)[] = [];
    let calls = 0;
    const s = connectEvents({
      url: 'http://x/api/v1/events',
      topics: ['run:r1', 'inbox'],
      backoffMs: [5],
      onEvent: (e) => got.push(e.id),
      onStatus: (st) => statuses.push(st),
      fetch: (async (url: URL, init: RequestInit) => {
        calls++;
        resumedWith.push(new Headers(init.headers).get('last-event-id'));
        expect(url.searchParams.get('topics')).toBe('run:r1,inbox');
        // First connection delivers 1 and 2 and then drops; the second delivers 3 and stays open.
        return calls === 1 ? sse(stream([evt('1'), evt('2')])) : sse(stream([evt('3')], true));
      }) as unknown as typeof fetch,
    });
    await wait(() => got.length === 3);
    expect(got).toEqual(['1', '2', '3']);
    expect(resumedWith).toEqual([null, '2']); // exactly the missed events, nothing twice
    expect(statuses).toContain('reconnecting');
    expect(statuses.at(-1)).toBe('live');
    expect(s.cursor()).toBe('3');
    s.close();
    expect(statuses.at(-1)).toBe('disconnected');
  });

  it('asks for a fresh snapshot on 410 and does not retry', async () => {
    let gone = 0;
    let calls = 0;
    const statuses: StreamStatus[] = [];
    connectEvents({
      url: 'http://x/events',
      cursor: '5',
      backoffMs: [5],
      onEvent: () => undefined,
      onGone: () => gone++,
      onStatus: (st) => statuses.push(st),
      fetch: (async () => {
        calls++;
        return new Response('{}', { status: 410 });
      }) as unknown as typeof fetch,
    });
    await wait(() => statuses.includes('disconnected'));
    await new Promise((r) => setTimeout(r, 40));
    expect(gone).toBe(1);
    expect(calls).toBe(1);
  });

  it('stops for good when the server says we are not allowed', async () => {
    const statuses: StreamStatus[] = [];
    let calls = 0;
    connectEvents({
      url: 'http://x/events',
      backoffMs: [5],
      onEvent: () => undefined,
      onStatus: (st, info) =>
        statuses.push(st, ...(info?.reason ? ([info.reason] as never[]) : [])),
      fetch: (async () => {
        calls++;
        return new Response('', { status: 401 });
      }) as unknown as typeof fetch,
    });
    await wait(() => statuses.includes('disconnected'));
    await new Promise((r) => setTimeout(r, 30));
    expect(calls).toBe(1);
  });

  it('gives up on a connection that goes silent and reconnects', async () => {
    let calls = 0;
    const statuses: StreamStatus[] = [];
    const s = connectEvents({
      url: 'http://x/events',
      backoffMs: [5],
      idleMs: 30,
      onEvent: () => undefined,
      onStatus: (st) => statuses.push(st),
      fetch: (async (_u: URL, init: RequestInit) => {
        calls++;
        const body = new ReadableStream<Uint8Array>({
          start(c) {
            init.signal?.addEventListener('abort', () => c.error(new Error('aborted')));
          },
        });
        return sse(body);
      }) as unknown as typeof fetch,
    });
    await wait(() => calls >= 2);
    s.close();
    expect(statuses).toContain('reconnecting');
  });
});
