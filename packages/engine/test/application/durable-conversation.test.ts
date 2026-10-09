import type { ActorRef } from '@kramahq/contract';
import { describe, expect, it } from 'vitest';
import type { AgentRef, GatewayEvent, TaskSnapshot, TranscriptWrite } from '../../src/index.js';
import { priya, setup } from './helpers.js';

const agent: AgentRef = { id: 'agt_1', url: 'http://127.0.0.1:1', role: 'author', backend: 'a2a' };
const answer = (text: string): GatewayEvent => ({
  kind: 'artifact',
  name: 'response',
  mediaType: 'text/plain',
  bytes: new TextEncoder().encode(text),
});
const working: GatewayEvent = { kind: 'state', state: 'working', taskId: 't1', contextId: 'c1' };
const done: GatewayEvent = { kind: 'state', state: 'completed', taskId: 't1', contextId: 'c1' };
const lost = (dispatched?: boolean) =>
  Object.assign(new Error('connection lost'), dispatched === undefined ? {} : { dispatched });

/** An event stream that fails as soon as it is read. */
const failing = (err: Error): AsyncIterable<GatewayEvent> => ({
  [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(err) }),
});

async function started() {
  const h = setup();
  const records: TranscriptWrite[] = [];
  h.p.transcript = {
    record: async (w) => void records.push(w),
    recordControl: async () => undefined,
    expectSink: () => undefined,
    noteActivity: () => undefined,
    closeRun: async () => undefined,
  };
  const run = await h.engine.runs.create(
    { packId: 'pack_demo', input: { text: 'x' }, budget: { max: 10 } },
    priya,
  );
  await h.engine.runs.plan(run.id);
  const delegate = (extra: Record<string, unknown> = {}) =>
    h.engine.steps.delegate({ runId: run.id, phaseId: 'draft', agent, text: 'do it', ...extra });
  return { h, run, records, delegate };
}
const kinds = (r: TranscriptWrite[]) => r.map((x) => x.kind);

describe('a send is dispatched once', () => {
  it('fixes the messageId on the step before the agent is told, and marks it sent once it answers', async () => {
    const { h, delegate } = await started();
    h.p.gateway.queue('author', [working, answer('ok'), done]);
    const r = await delegate();
    expect(h.p.gateway.sent).toHaveLength(1);
    expect(h.p.gateway.sent[0]!.messageId).toBe(r.step.a2a.messageId);
    expect(r.step.a2a).toMatchObject({ delivery: 'sent', taskId: 't1' });
  });

  it('retries a failure before anything left, under the same messageId', async () => {
    const { h, delegate } = await started();
    const unreachable = () => {
      throw Object.assign(lost(false), { code: 'unreachable' });
    };
    h.p.gateway.queue('author', unreachable, unreachable, [working, answer('ok'), done]);
    const r = await delegate();
    expect(r.status).toBe('completed');
    expect(h.p.gateway.sent).toHaveLength(3);
    expect(new Set(h.p.gateway.sent.map((s) => s.messageId)).size).toBe(1);
  });

  it('does not retry a failure it cannot fix, and calls it a failure, not an uncertain send', async () => {
    const { h, delegate } = await started();
    h.p.gateway.queue('author', () => {
      throw lost(false);
    });
    const r = await delegate();
    expect(r).toMatchObject({ status: 'failed' });
    expect(r.uncertain).toBeUndefined();
    expect(h.p.gateway.sent).toHaveLength(1);
  });

  it('reports an outcome that is unknown after the request left, and never sends it again', async () => {
    const { h, records, delegate } = await started();
    h.p.gateway.queue('author', () => {
      throw lost(true);
    });
    const r = await delegate({ key: 'k1' });
    expect(r).toMatchObject({ status: 'failed', uncertain: true });
    expect(r.step.a2a.delivery).toBe('uncertain');
    expect(h.p.gateway.sent).toHaveLength(1);
    expect(kinds(records)).toContain('message.uncertain');

    // Asking again with the same key reports it again; it does not reach the agent.
    h.p.gateway.queue('author', [working, done]);
    const again = await delegate({ key: 'k1' });
    expect(again).toMatchObject({ uncertain: true, cached: true });
    expect(h.p.gateway.sent).toHaveLength(1);
  });

  it('treats an error that does not say whether the request left as possibly delivered', async () => {
    const { h, delegate } = await started();
    h.p.gateway.queue('author', () => {
      throw lost();
    });
    expect((await delegate()).uncertain).toBe(true);
    expect(h.p.gateway.sent).toHaveLength(1);
  });
});

describe('a dropped stream is followed, not resent', () => {
  const dropAfterWorking = async function* (): AsyncGenerator<GatewayEvent> {
    yield working;
    yield answer('part one. ');
    throw lost(true);
  };

  it('reattaches with SubscribeToTask and settles with what the agent holds', async () => {
    const { h, records, delegate } = await started();
    h.p.gateway.queue('author', () => dropAfterWorking());
    const finished: TaskSnapshot = {
      taskId: 't1',
      contextId: 'c1',
      state: 'completed',
      artifacts: [answer('part one. ') as TaskSnapshot['artifacts'][number]],
    };
    h.p.gateway.tasks.set('t1', { ...finished, state: 'working', artifacts: [] });
    const real = h.p.gateway.subscribe.bind(h.p.gateway);
    h.p.gateway.subscribe = async function* (a, id) {
      yield* real(a, id);
      h.p.gateway.tasks.set('t1', finished);
      yield* [answer('part one. '), done];
    };
    const r = await delegate();
    expect(r.status).toBe('completed');
    expect(h.p.gateway.sent).toHaveLength(1);
    expect(h.p.gateway.subscribed).toEqual(['t1']);
    expect(kinds(records)).toContain('task.reattach');
    // The text the agent repeated on reattach is stored once.
    expect(r.artifacts).toHaveLength(1);
    expect(r.answer).toBe('part one. ');
  });

  it('settles from GetTask when the subscription is also gone', async () => {
    const { h, delegate } = await started();
    h.p.gateway.queue('author', () => dropAfterWorking());
    h.p.gateway.subscribe = () => failing(lost(true));
    h.p.gateway.tasks.set('t1', { taskId: 't1', state: 'completed', artifacts: [] });
    const r = await delegate();
    expect(r.status).toBe('completed');
    expect(h.p.gateway.sent).toHaveLength(1);
  });

  it('fails the step when the agent no longer knows the task', async () => {
    const { h, delegate } = await started();
    h.p.gateway.queue('author', () => dropAfterWorking());
    h.p.gateway.subscribe = () =>
      failing(Object.assign(new Error('gone'), { code: 'task_not_found' }));
    const r = await delegate();
    expect(r).toMatchObject({ status: 'failed', error: 'The agent no longer knows this task' });
    expect(h.p.gateway.sent).toHaveLength(1);
  });
});

describe('a finished task stays finished', () => {
  it('ignores a later state event and says so on the record', async () => {
    const { h, records, delegate } = await started();
    h.p.gateway.queue('author', [working, done, { kind: 'state', state: 'working', taskId: 't1' }]);
    const r = await delegate();
    expect(r.step.status).toBe('completed');
    expect(kinds(records)).toContain('step.state.ignored');
  });
});

describe('after a restart', () => {
  const actor: ActorRef = { type: 'system', id: 'engine' };
  async function orphan(patch: Record<string, unknown>) {
    const t = await started();
    const id = t.h.p.ids.next('step');
    await t.h.p.store.steps.put({
      id,
      runId: t.run.id,
      phaseId: 'draft',
      agent: { id: 'agt_1', role: 'author', backend: 'a2a' },
      summary: 's',
      status: 'working',
      a2a: { resumed: false, messageId: `msg_${id}_0`, ...patch },
    } as never);
    return { ...t, id, actor };
  }

  it('calls a message that was never confirmed uncertain, and does not send it', async () => {
    const t = await orphan({ delivery: 'pending' });
    await t.h.engine.steps.failOrphaned(t.run.id);
    const s = (await t.h.p.store.steps.get(t.id))!.value;
    expect(s).toMatchObject({ status: 'failed', a2a: { delivery: 'uncertain' } });
    expect(t.h.p.gateway.sent).toHaveLength(0);
    expect(kinds(t.records)).toContain('message.uncertain');
  });

  it('takes over the answer of a task that finished while Krama was away', async () => {
    const t = await orphan({ delivery: 'sent', taskId: 't1' });
    t.h.p.agents.ref = () => agent;
    t.h.p.gateway.tasks.set('t1', {
      taskId: 't1',
      state: 'completed',
      artifacts: [answer('done meanwhile') as TaskSnapshot['artifacts'][number]],
    });
    await t.h.engine.steps.failOrphaned(t.run.id);
    expect((await t.h.p.store.steps.get(t.id))!.value.status).toBe('completed');
    expect(t.h.p.gateway.sent).toHaveLength(0);
    expect((await t.h.p.artifacts.listByRun(t.run.id)).map((a) => a.name)).toContain('response');
  });

  it('cancels a task that is still running and fails the step so it can be retried on purpose', async () => {
    const t = await orphan({ delivery: 'sent', taskId: 't1' });
    t.h.p.agents.ref = () => agent;
    t.h.p.gateway.tasks.set('t1', { taskId: 't1', state: 'working', artifacts: [] });
    await t.h.engine.steps.failOrphaned(t.run.id);
    expect((await t.h.p.store.steps.get(t.id))!.value.status).toBe('failed');
    expect(t.h.p.gateway.canceled).toEqual(['t1']);
  });
});
