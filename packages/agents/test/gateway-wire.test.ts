import type { AgentRef, GatewayEvent } from '@kramahq/engine';
import { afterEach, describe, expect, it } from 'vitest';
import {
  A2AGateway,
  EgressError,
  GatewayError,
  checkUrl,
  isPublicAddress,
  redact,
} from '../src/index.js';
import { FakeA2A, status, task, text, artifact, type FakeOptions } from './fixtures/fake-a2a.js';

const servers: FakeA2A[] = [];
const fake = async (o: FakeOptions = {}) => {
  const s = await new FakeA2A(o).start();
  servers.push(s);
  return s;
};
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.stop()));
});

const ref = (s: FakeA2A, extra: Partial<AgentRef> = {}): AgentRef => ({
  id: 'agt_1',
  url: s.url,
  role: 'developer',
  backend: 'a2a-fake',
  ...extra,
});
const collect = async (it: AsyncIterable<GatewayEvent>): Promise<GatewayEvent[]> => {
  const out: GatewayEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
};
const done = { frames: [task('submitted'), status('completed', { final: true })] };

describe('protocol version and discovery', () => {
  it('reads the card, then calls the v1 operation with A2A-Version 1.0', async () => {
    const s = (await fake()).queue(done);
    await collect(new A2AGateway().send(ref(s), { text: 'hi' }));
    expect(s.cardRequests).toHaveLength(1);
    expect(s.cardRequests[0]!['a2a-version']).toBe('1.0');
    expect(s.calls[0]).toMatchObject({
      wireMethod: 'SendStreamingMessage',
      method: 'message/stream',
    });
    expect(s.calls[0]!.headers['a2a-version']).toBe('1.0');
  });

  it('cancels with the v1 CancelTask operation', async () => {
    const s = await fake();
    await new A2AGateway().cancel(ref(s), 'task_9');
    expect(s.calls[0]).toMatchObject({ wireMethod: 'CancelTask', params: { id: 'task_9' } });
    expect(s.calls[0]!.headers['a2a-version']).toBe('1.0');
  });

  it('reuses the card between calls and reads it again after the TTL', async () => {
    const s = (await fake()).queue(done, done, done);
    const gw = new A2AGateway({ cardTtlMs: 150 });
    await collect(gw.send(ref(s), { text: 'a' }));
    await collect(gw.send(ref(s), { text: 'b' }));
    expect(s.cardRequests).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 200));
    await collect(gw.send(ref(s), { text: 'c' }));
    expect(s.cardRequests).toHaveLength(2);
  });

  it('speaks HTTP+JSON when that is the interface the card advertises', async () => {
    const s = (await fake({ binding: 'HTTP+JSON' })).queue({
      frames: [
        task('working'),
        artifact('response', [text('over REST')], { lastChunk: true }),
        status('completed', { final: true }),
      ],
    });
    const evs = await collect(new A2AGateway().send(ref(s), { text: 'hi', contextId: 'ctx_r' }));
    expect(s.calls[0]).toMatchObject({
      method: 'message/stream',
      wireMethod: 'POST /a2a/rest/message:stream',
    });
    expect(evs.at(-1)).toMatchObject({ state: 'completed' });
    expect(
      evs.some((e) => e.kind === 'artifact' && new TextDecoder().decode(e.bytes) === 'over REST'),
    ).toBe(true);
    await new A2AGateway().cancel(ref(s), 'task_5');
    expect(s.calls.at(-1)).toMatchObject({ wireMethod: 'POST /a2a/rest/tasks/task_5:cancel' });
  });

  it('reaches a 0.3-only agent through the SDK compatibility layer', async () => {
    const s = (await fake({ version: '0.3' })).queue(done);
    const evs = await collect(new A2AGateway().send(ref(s), { text: 'hi' }));
    expect(s.calls[0]).toMatchObject({ wireMethod: 'message/stream' });
    expect(evs.at(-1)).toMatchObject({ state: 'completed' });
  });

  it('reports a card compliance summary without blocking the call', async () => {
    const v1 = await new A2AGateway().inspect(ref(await fake()));
    expect(v1).toMatchObject({ streaming: true, skills: 1 });
    expect(v1.selected).toMatchObject({ binding: 'JSONRPC', version: '1.0' });
    expect(v1.issues).toEqual([]);

    const old = await new A2AGateway().inspect(
      ref(await fake({ version: '0.3', streaming: false })),
    );
    expect(old.issues.map((i) => i.code)).toEqual(
      expect.arrayContaining(['legacy-only', 'no-streaming']),
    );
  });
});

describe('outbound hardening', () => {
  it('lets Krama reach an agent it started on a loopback address', async () => {
    const s = (await fake()).queue(done);
    const evs = await collect(new A2AGateway().send(ref(s), { text: 'hi' }));
    expect(evs.at(-1)).toMatchObject({ state: 'completed' });
  });

  it('refuses a private or loopback address for an external agent, before any request', async () => {
    const s = await fake();
    const err = await collect(
      new A2AGateway().send(ref(s, { external: true }), { text: 'x' }),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(GatewayError);
    expect(err).toMatchObject({ code: 'blocked', detail: { reason: 'blocked_address' } });
    expect(s.cardRequests).toHaveLength(0);
    expect(s.calls).toHaveLength(0);
  });

  it('refuses a name that resolves to a private address for an external agent', async () => {
    const s = await fake();
    const url = s.url.replace('127.0.0.1', 'localhost');
    const err = await collect(
      new A2AGateway().send(ref(s, { external: true, url }), { text: 'x' }),
    ).catch((e) => e);
    expect(err).toMatchObject({ code: 'blocked' });
    expect(s.cardRequests).toHaveLength(0);
  });

  it('classifies addresses', () => {
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '172.20.0.1',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '::1',
      'fe80::1',
      'fd00::1',
      '::ffff:127.0.0.1',
      '[::1]',
    ])
      expect(isPublicAddress(ip), ip).toBe(false);
    for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700:4700::1111'])
      expect(isPublicAddress(ip), ip).toBe(true);
    expect(isPublicAddress('not-an-ip')).toBe(false);
  });

  it('checks scheme, embedded credentials and the origin allow-list', () => {
    const open = { allowPrivate: false, maxResponseBytes: 10 };
    expect(() => checkUrl('file:///etc/passwd', open)).toThrow(EgressError);
    expect(() => checkUrl('https://user:pw@example.com', open)).toThrow(/Credentials/);
    expect(() =>
      checkUrl('https://example.com/x', { ...open, allowedOrigins: ['https://other.example'] }),
    ).toThrow(/allow-list/);
    expect(
      checkUrl('https://example.com/x', { ...open, allowedOrigins: ['https://example.com'] }).host,
    ).toBe('example.com');
  });

  it('does not follow a redirect when reading the card', async () => {
    const target = await fake();
    const s = await fake({ cardRedirect: `${target.url}/.well-known/agent-card.json` });
    const err = await collect(new A2AGateway().send(ref(s), { text: 'x' })).catch((e) => e);
    expect(err).toMatchObject({ code: 'blocked', detail: { reason: 'redirect' } });
    expect(target.cardRequests).toHaveLength(0);
  });

  it('does not follow a redirect on a call', async () => {
    const target = await fake();
    const s = (await fake()).queue({ redirect: `${target.url}/a2a/jsonrpc` });
    const err = await collect(new A2AGateway().send(ref(s), { text: 'x' })).catch((e) => e);
    expect(err).toMatchObject({ code: 'blocked', detail: { reason: 'redirect' } });
    expect(target.calls).toHaveLength(0);
  });

  it('refuses an oversize card', async () => {
    const s = await fake({ cardPadding: 200_000 });
    const gw = new A2AGateway({ managed: { maxResponseBytes: 50_000 } });
    const err = await collect(gw.send(ref(s), { text: 'x' })).catch((e) => e);
    expect(err).toMatchObject({ code: 'too_large' });
  });

  it('stops a response that grows past the cap while it streams', async () => {
    const s = (await fake()).queue({ bloat: 200_000 });
    const gw = new A2AGateway({ managed: { maxResponseBytes: 50_000 } });
    const err = await collect(gw.send(ref(s), { text: 'x' })).catch((e) => e);
    expect(err).toMatchObject({ code: 'too_large' });
  });

  it('ignores an interface on another host unless that host is allowed', async () => {
    const elsewhere = await fake();
    const s = await fake({ interfaceUrl: `${elsewhere.url}/a2a/jsonrpc` });
    const err = await collect(new A2AGateway().send(ref(s), { text: 'x' })).catch((e) => e);
    expect(err).toMatchObject({ code: 'bad_response' });
    expect(elsewhere.calls).toHaveLength(0);

    elsewhere.queue(done);
    const ok = new A2AGateway({ managed: { allowedOrigins: [s.url, elsewhere.url] } });
    expect((await collect(ok.send(ref(s), { text: 'x' }))).at(-1)).toMatchObject({
      state: 'completed',
    });
    expect(elsewhere.calls).toHaveLength(1);
  });

  it('sends credentials only to the origin they were issued for, and removes them from errors', async () => {
    const mine = (await fake()).queue({ status: 500 });
    const other = await fake();
    const secret = 'sk-live-123456';
    const gw = new A2AGateway({
      credentials: {
        [mine.url]: { authorization: `Bearer ${secret}` },
        'https://unrelated.example': { authorization: 'Bearer nope' },
      },
    });
    await collect(gw.send(ref(mine), { text: 'x' })).catch(() => undefined);
    expect(mine.calls[0]!.headers.authorization).toBe(`Bearer ${secret}`);
    expect(mine.cardRequests[0]!.authorization).toBe(`Bearer ${secret}`);

    other.queue(done);
    await collect(gw.send(ref(other), { text: 'x' }));
    expect(other.calls[0]!.headers.authorization).toBeUndefined();
    expect(other.cardRequests[0]!.authorization).toBeUndefined();

    expect(
      redact(`failed with ${secret} and ${Buffer.from(secret).toString('base64')}`, [secret]),
    ).toBe('failed with [redacted] and [redacted]');
  });

  it('drops cookies and proxy credentials the caller might have set', async () => {
    const s = (await fake()).queue(done);
    await collect(new A2AGateway().send(ref(s), { text: 'x' }));
    expect(s.calls[0]!.headers.cookie).toBeUndefined();
  });
});
