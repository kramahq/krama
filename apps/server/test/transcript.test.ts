import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BackendRegistry } from '@kramahq/agents';
import { API_BASE_PATH, auditRecord, type AuditRecord, type Run } from '@kramahq/contract';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApi, createKrama, loadConfig, type Krama } from '../src/index.js';
import { DEMO_BACKEND, DEMO_DEFINITIONS, DEMO_PACK } from '../src/demo/pack.js';

const TOKEN = 'test-token-0123456789abcdef';
const auth = { authorization: `Bearer ${TOKEN}` };
const V1 = API_BASE_PATH;

let home: string;
let krama: Krama;
let admin: FastifyInstance;
let viewer: FastifyInstance;
let adminBase: string;
let viewerBase: string;

const serve = async (principal?: {
  id: string;
  name: string;
  roles: string[];
  permissions: string[];
}) => {
  const config = loadConfig({ argv: ['--home', home, '--token', TOKEN, '--port', '0'], env: {} });
  const app = await buildApi({
    krama,
    config,
    validateResponses: true,
    autoStartRuns: false,
    heartbeatMs: 40,
    ...(principal ? { principal } : {}),
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  return { app, base: `http://127.0.0.1:${(app.server.address() as { port: number }).port}${V1}` };
};

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'krama-transcript-'));
  const backends = BackendRegistry.withBuiltins();
  backends.register(DEMO_BACKEND, 'user');
  krama = await createKrama({ home, packs: [DEMO_PACK], definitions: DEMO_DEFINITIONS, backends });
  ({ app: admin, base: adminBase } = await serve());
  ({ app: viewer, base: viewerBase } = await serve({
    id: 'u_view',
    name: 'Vera Viewer',
    roles: ['viewer'],
    permissions: [],
  }));
}, 60_000);

afterAll(async () => {
  await admin?.close();
  await viewer?.close();
  await krama?.close();
  rmSync(home, { recursive: true, force: true });
});

const get = (base: string, path: string, headers: Record<string, string> = auth) =>
  fetch(`${base}${path}`, { headers });

const newRun = async (): Promise<Run> => {
  const res = await fetch(`${adminBase}/runs`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ packId: DEMO_PACK.id, input: { text: 'write the notes' } }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as Run;
};

const say = (runId: string, kind: string, payload: unknown, extra: object = {}) =>
  krama.ports.transcript!.record({
    runId,
    actor: { type: 'agent', id: 'agt_author', role: 'author' },
    kind,
    source: 'mcp',
    payload,
    ...extra,
  });

interface Page {
  items: AuditRecord[];
  nextCursor?: string;
  head?: { seq: number; hash: string };
}

describe('GET /runs/{id}/transcript', () => {
  it('returns the run chain oldest first, whole, with its head', async () => {
    const run = await newRun();
    await say(run.id, 'tool.call', { tool: 'fs.read', path: 'notes.md' });
    await say(run.id, 'tool.result', { ok: true });
    const res = await get(adminBase, `/runs/${run.id}/transcript`);
    expect(res.status).toBe(200);
    const page = (await res.json()) as Page;
    const items = page.items.map((r) => auditRecord.parse(r));
    expect(items.map((r) => r.kind)).toEqual(['message.user', 'tool.call', 'tool.result']);
    expect(items.map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(items[0]!.payload).toMatchObject({ input: { text: 'write the notes' } });
    expect(page.head).toEqual({ seq: 3, hash: items[2]!.hash });
    expect(page.nextCursor).toBeUndefined();
  });

  it('pages with a cursor and filters by kind and agent', async () => {
    const run = await newRun();
    for (let i = 0; i < 5; i++) await say(run.id, 'tool.call', { i });
    await say(run.id, 'thinking', { text: 'hm' }, { actor: { type: 'agent', id: 'agt_other' } });
    const first = (await (
      await get(adminBase, `/runs/${run.id}/transcript?limit=3`)
    ).json()) as Page;
    expect(first.items.map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(first.nextCursor).toBe('3');
    const rest = (await (
      await get(adminBase, `/runs/${run.id}/transcript?limit=10&after=${first.nextCursor}`)
    ).json()) as Page;
    expect(rest.items.map((r) => r.seq)).toEqual([4, 5, 6, 7]);
    expect(rest.nextCursor).toBeUndefined();

    const calls = (await (
      await get(adminBase, `/runs/${run.id}/transcript?kind=tool.call`)
    ).json()) as Page;
    expect(calls.items).toHaveLength(5);
    const other = (await (
      await get(adminBase, `/runs/${run.id}/transcript?agent=agt_other`)
    ).json()) as Page;
    expect(other.items.map((r) => r.kind)).toEqual(['thinking']);
    const bad = await get(adminBase, `/runs/${run.id}/transcript?after=abc`);
    expect(bad.status).toBe(422);
  });

  it('answers 404 for a run that does not exist', async () => {
    expect((await get(adminBase, '/runs/run_nope/transcript')).status).toBe(404);
  });
});

describe('transcript blobs and verification', () => {
  it('keeps a large body by its hash and serves exactly those bytes, only through the run that holds it', async () => {
    const run = await newRun();
    const other = await newRun();
    const body = 'x'.repeat(40_000);
    await say(run.id, 'tool.result', { body });
    const page = (await (await get(adminBase, `/runs/${run.id}/transcript`)).json()) as Page;
    const rec = page.items.find((r) => r.kind === 'tool.result')!;
    expect(rec.blob).toBeDefined();
    expect(rec.payload).toBeUndefined();

    const res = await get(adminBase, `/runs/${run.id}/transcript/blobs/${rec.blob!.sha256}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(JSON.parse(await res.text())).toEqual({ body });
    // Another run cannot read it by guessing its hash.
    expect(
      (await get(adminBase, `/runs/${other.id}/transcript/blobs/${rec.blob!.sha256}`)).status,
    ).toBe(404);
    expect((await get(adminBase, `/runs/${run.id}/transcript/blobs/not-a-hash`)).status).toBe(422);
  });

  it('verifies the chain and its blobs', async () => {
    const run = await newRun();
    await say(run.id, 'tool.result', { body: 'y'.repeat(30_000) });
    const res = await get(adminBase, `/runs/${run.id}/transcript/verify`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, chain: `run:${run.id}`, count: 2 });
  });
});

describe('who may read a transcript', () => {
  it('refuses a viewer on every transcript route and on the stream, and lets an operator in', async () => {
    const run = await newRun();
    const sha = 'a'.repeat(64);
    for (const path of [
      `/runs/${run.id}/transcript`,
      `/runs/${run.id}/transcript/blobs/${sha}`,
      `/runs/${run.id}/transcript/verify`,
    ])
      expect((await get(viewerBase, path)).status, path).toBe(403);
    const stream = await get(viewerBase, `/events?topics=run:${run.id}:transcript`, {
      ...auth,
      accept: 'text/event-stream',
    });
    expect(stream.status).toBe(403);
    // A viewer still reads what is not unclipped.
    expect((await get(viewerBase, `/runs/${run.id}`)).status).toBe(200);
  });
});

/** One frame at a time from a server-sent-events response. */
function frames(res: Response) {
  const dec = new TextDecoder();
  const body = res.body!.getReader();
  let buf = '';
  return {
    async record(): Promise<{
      id: string;
      event: string;
      data: AuditRecord['kind'] extends never ? never : { data: AuditRecord };
    }> {
      const deadline = Date.now() + 4000;
      for (;;) {
        const at = buf.indexOf('\n\n');
        if (at >= 0) {
          const raw = buf.slice(0, at);
          buf = buf.slice(at + 2);
          const id = /^id: (.*)$/m.exec(raw)?.[1];
          const event = /^event: (.*)$/m.exec(raw)?.[1];
          const data = /^data: (.*)$/m.exec(raw)?.[1];
          if (id && event && data) return { id, event, data: JSON.parse(data) };
          continue;
        }
        if (Date.now() > deadline) throw new Error('timed out waiting for a record');
        const r = await body.read();
        if (r.done) throw new Error('the stream ended');
        buf += dec.decode(r.value, { stream: true });
      }
    },
    cancel: () => body.cancel(),
  };
}

describe('the transcript topic of the event stream', () => {
  const open = (runId: string, headers: Record<string, string> = {}) =>
    fetch(`${adminBase}/events?topics=run:${runId}:transcript`, {
      headers: { ...auth, accept: 'text/event-stream', ...headers },
    });

  it('resumes: a snapshot, a live stream, a gap while away, then Last-Event-ID fills it with no gap and no repeat', async () => {
    const run = await newRun();
    await say(run.id, 'tool.call', { n: 1 });
    await say(run.id, 'tool.call', { n: 2 });

    // Snapshot first (a stream starts live), then follow from its head.
    const snap = (await (await get(adminBase, `/runs/${run.id}/transcript`)).json()) as Page;
    expect(snap.head!.seq).toBe(3);
    const first = await open(run.id);
    expect(first.status).toBe(200);
    expect(first.headers.get('content-type')).toContain('text/event-stream');
    const a = frames(first);
    await say(run.id, 'tool.call', { n: 3 });
    const live = await a.record();
    expect([live.event, Number(live.id)]).toEqual(['transcript.record', 4]);
    expect(live.data.data).toMatchObject({ kind: 'tool.call', seq: 4 });
    await a.cancel();

    // The client was away while two more were written; it resumes from the last id it saw.
    await say(run.id, 'tool.call', { n: 4 });
    await say(run.id, 'tool.call', { n: 5 });
    const again = frames(await open(run.id, { 'last-event-id': '4' }));
    expect(Number((await again.record()).id)).toBe(5);
    expect(Number((await again.record()).id)).toBe(6);
    // And one written now arrives live, in order, once.
    await say(run.id, 'tool.call', { n: 6 });
    expect(Number((await again.record()).id)).toBe(7);
    await again.cancel();
  });

  it('answers 410 for a position the chain never reached, and 404 for an unknown run', async () => {
    const run = await newRun();
    const gone = await open(run.id, { 'last-event-id': '999' });
    expect(gone.status).toBe(410);
    expect((await open('run_nope')).status).toBe(404);
  });

  it('is served on its own, not mixed with the event log', async () => {
    const run = await newRun();
    const mixed = await fetch(`${adminBase}/events?topics=runs,run:${run.id}:transcript`, {
      headers: { ...auth, accept: 'text/event-stream' },
    });
    expect(mixed.status).toBe(422);
  });
});
