import { request } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentEventCollector, type EventClaims } from '../src/index.js';
import { newRun, system, type System } from './runner-rig.js';

const live: { s: System; c: AgentEventCollector }[] = [];
afterEach(async () => {
  await Promise.allSettled(live.splice(0).flatMap(({ s, c }) => [c.close(), s.stop()]));
});

const make = async (maxBodyBytes?: number) => {
  const s = await system();
  const c = new AgentEventCollector({
    engine: s.engine,
    ports: s.p,
    ...(maxBodyBytes ? { maxBodyBytes } : {}),
  });
  const base = await c.listen();
  live.push({ s, c });
  const runId = await newRun(s);
  const claims: EventClaims = {
    runId,
    instanceId: 'agt_w1',
    agent: 'researcher',
    role: 'researcher',
    backend: 'a2a-codex',
  };
  const token = c.tokens.issue(claims);
  const post = (body: unknown, auth: string | null = `Bearer ${token}`, path = '/agent-events') =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  const activity = async () =>
    (await s.p.events.read({ topics: [`run:${runId}`] })).filter((e) =>
      e.type.startsWith('activity.'),
    );
  return { s, c, base, runId, claims, token, post, activity };
};

const event = (eventType: string, data: unknown = {}, extra: Record<string, unknown> = {}) => ({
  eventId: `ev_${Math.random().toString(36).slice(2)}`,
  eventType,
  agentId: 'researcher',
  data,
  ...extra,
});

describe('the event collector', () => {
  it('accepts an agent event and records it as activity from that agent, on the http channel', async () => {
    const t = await make();
    const res = await t.post(event('tool_call_start', { toolName: 'web_search' }));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: 'accepted' });
    const [seen] = await t.activity();
    expect(seen).toMatchObject({
      type: 'activity.tool_call',
      subject: { type: 'agent', id: 'agt_w1' },
      data: {
        channel: 'http',
        kind: 'tool_call',
        toolName: 'web_search',
        agent: { id: 'agt_w1', role: 'researcher', backend: 'a2a-codex' },
      },
    });
    expect(t.c.stats).toEqual({ accepted: 1, duplicate: 0, parked: 0 });
  });

  it('accounts the usage an agent reports when its turn ends', async () => {
    const t = await make();
    await t.post(event('agent_finished', { usage: { inputTokens: 40, outputTokens: 10 } }));
    const rows = await t.s.p.store.usage.forRun(t.runId);
    expect(rows.flatMap((r) => r.usage)).toEqual([{ unit: 'tokens', quantity: 50 }]);
    expect(rows[0]!.cost).toBeNull();
  });

  it('keeps an event type it does not know', async () => {
    const t = await make();
    await t.post(event('quota_warning', { left: 3 }));
    expect((await t.activity())[0]).toMatchObject({
      type: 'activity.status',
      data: { text: 'quota warning' },
    });
  });

  it('counts a retried event once', async () => {
    const t = await make();
    const e = event('agent_finished', { usage: { inputTokens: 5, outputTokens: 5 } });
    expect(await (await t.post(e)).json()).toEqual({ status: 'accepted' });
    expect(await (await t.post(e)).json()).toEqual({ status: 'duplicate' });
    const rows = await t.s.p.store.usage.forRun(t.runId);
    expect(rows).toHaveLength(1);
    expect(t.c.stats).toMatchObject({ accepted: 1, duplicate: 1 });
  });
});

describe('who an event belongs to', () => {
  it('trusts the event’s own correlation context when it agrees with the token', async () => {
    const t = await make();
    const res = await t.post(
      event('tool_call_start', { toolName: 'x' }, { propagated_metadata: { run_id: t.runId } }),
    );
    expect(await res.json()).toEqual({ status: 'accepted' });
  });

  it('parks an event whose context names another run, and ingests nothing', async () => {
    const t = await make();
    const res = await t.post(
      event('tool_call_start', { toolName: 'x' }, { propagated_metadata: { run_id: 'run_other' } }),
    );
    expect(await res.json()).toEqual({ status: 'parked' });
    expect(await t.activity()).toEqual([]);
    expect(t.c.stats.parked).toBe(1);
    expect(t.c.parked[0]).toMatchObject({ eventType: 'tool_call_start', agent: 'researcher' });
    expect(t.c.parked[0]!.reason).toContain('run_other');
  });

  it('parks an event for a run that does not exist', async () => {
    const t = await make();
    const ghost = t.c.tokens.issue({ ...t.claims, runId: 'run_ghost' });
    const res = await t.post(event('thinking', { text: 'x' }), `Bearer ${ghost}`);
    expect(await res.json()).toEqual({ status: 'parked' });
    expect(t.c.parked[0]!.reason).toContain('does not exist');
  });

  it('attributes two agents of one run to themselves, not to each other', async () => {
    const t = await make();
    const other = t.c.tokens.issue({
      ...t.claims,
      instanceId: 'agt_w2',
      agent: 'reviewer',
      role: 'reviewer',
    });
    await t.post(event('tool_call_start', { toolName: 'a' }));
    await t.post(event('tool_call_start', { toolName: 'b' }), `Bearer ${other}`);
    const seen = await t.activity();
    expect(seen.map((e) => [e.subject.id, (e.data as { toolName: string }).toolName])).toEqual([
      ['agt_w1', 'a'],
      ['agt_w2', 'b'],
    ]);
  });
});

describe('the endpoint', () => {
  it('needs a valid token, and a token stops working when its run is released', async () => {
    const t = await make();
    expect((await t.post(event('thinking'), null)).status).toBe(401);
    expect((await t.post(event('thinking'), 'Bearer nope')).status).toBe(401);
    expect((await t.post(event('thinking'))).status).toBe(202);
    expect(t.c.tokens.revokeRun(t.runId)).toBe(1);
    expect((await t.post(event('thinking'))).status).toBe(401);
  });

  it('rejects other methods, other paths, bad JSON, arrays and oversized bodies', async () => {
    const t = await make(2048);
    expect((await fetch(`${t.base}/agent-events`)).status).toBe(405);
    expect((await t.post(event('thinking'), `Bearer ${t.token}`, '/elsewhere')).status).toBe(404);
    expect((await t.post('{not json')).status).toBe(400);
    expect((await t.post([event('thinking')])).status).toBe(400);
    expect((await t.post(event('thinking', { text: 'x'.repeat(5000) }))).status).toBe(413);
    expect(await t.activity()).toEqual([]);
  });

  it('answers only to loopback hosts', async () => {
    const t = await make();
    const status = await new Promise<number>((resolve, reject) => {
      const u = new URL(t.base);
      const req = request(
        {
          host: u.hostname,
          port: u.port,
          path: '/agent-events',
          method: 'POST',
          headers: { host: 'evil.example.com', authorization: `Bearer ${t.token}` },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end('{}');
    });
    expect(status).toBe(403);
  });
});
