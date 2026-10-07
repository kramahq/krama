import type { AgentRef, GatewayEvent } from '@kramahq/engine';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { A2AGateway, GatewayError } from '../src/index.js';
import {
  FakeA2A,
  artifact,
  data,
  status,
  task,
  text,
  type FakeOptions,
} from './fixtures/fake-a2a.js';

const servers: FakeA2A[] = [];
let version: '1.0' | '0.3' = '1.0';
const fake = async (o: FakeOptions = {}) => {
  const s = await new FakeA2A({ version, ...o }).start();
  servers.push(s);
  return s;
};
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.stop()));
});

const ref = (s: FakeA2A): AgentRef => ({
  id: 'agt_1',
  url: s.url,
  role: 'developer',
  backend: 'a2a-fake',
});
const collect = async (it: AsyncIterable<GatewayEvent>): Promise<GatewayEvent[]> => {
  const out: GatewayEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
};
const states = (evs: GatewayEvent[]) =>
  evs
    .filter((e): e is Extract<GatewayEvent, { kind: 'state' }> => e.kind === 'state')
    .map((e) => e.state);
const decode = (e: GatewayEvent) =>
  e.kind === 'artifact' && e.bytes ? new TextDecoder().decode(e.bytes) : undefined;

describe.each(['1.0', '0.3'] as const)('against an A2A %s agent', (v) => {
  beforeEach(() => {
    version = v;
  });

  describe('a normal delegation', () => {
    it('streams state, sideband, artifacts and usage, in order, and ends completed', async () => {
      const s = (await fake()).queue({
        frames: [
          task('submitted'),
          status('working'),
          artifact('trace.thinking', [data({ text: 'Planning the change' })]),
          artifact('trace.mcp.start', [
            data({ agent_id: 'a', toolCallId: 't1', toolName: 'git.diff', arguments: '{}' }),
          ]),
          artifact('trace.mcp', [
            data({
              agent_id: 'a',
              toolCallId: 't1',
              toolName: 'git.diff',
              result: 'ok',
              isError: false,
              durationMs: 41,
            }),
          ]),
          artifact('response', [text('Done: ')], { id: 'r1', append: false, lastChunk: false }),
          artifact('response', [text('patch applied')], {
            id: 'r1',
            append: true,
            lastChunk: true,
          }),
          status('completed', {
            final: true,
            metadata: {
              'x-usage': {
                inputTokens: 1000,
                outputTokens: 250,
                reasoningTokens: 50,
                llmCalls: 3,
                cost: 1.5,
                model: 'gpt-4.1',
                calls: [],
              },
            },
          }),
        ],
      });
      const evs = await collect(new A2AGateway().send(ref(s), { text: 'Fix the bug' }));

      expect(states(evs)).toEqual(['working', 'working', 'completed']);
      expect(
        evs
          .filter((e) => e.kind === 'sideband')
          .map((e) => e.kind === 'sideband' && `${e.type}:${e.toolName ?? ''}`),
      ).toEqual(['thinking:', 'tool_call:git.diff', 'tool_result:git.diff']);
      const result = evs.find((e) => e.kind === 'sideband' && e.type === 'tool_result');
      expect(result).toMatchObject({ isError: false, durationMs: 41 });
      expect(evs.filter((e) => e.kind === 'artifact').map(decode)).toEqual(['Done: patch applied']); // chunks assembled once
      expect(evs.at(-1)).toMatchObject({
        kind: 'state',
        state: 'completed',
        taskId: 'task_1',
        contextId: 'ctx_1',
      });
      const usage = evs.find((e) => e.kind === 'usage');
      expect(usage).toEqual({
        kind: 'usage',
        usage: [
          { unit: 'tokens', quantity: 1300 },
          { unit: 'calls', quantity: 3 },
          { unit: 'credits', quantity: 1.5 },
        ],
        cost: null,
      });
      // The artifact is delivered before the terminal state.
      expect(evs.findIndex((e) => e.kind === 'artifact')).toBeLessThan(
        evs.findIndex((e) => e.kind === 'state' && e.state === 'completed'),
      );
    });

    it('never treats provider billing weight as dollars', async () => {
      const s = (await fake()).queue({
        frames: [
          status('completed', {
            final: true,
            metadata: { 'x-usage': { inputTokens: 1, outputTokens: 1, cost: 2, llmCalls: 1 } },
          }),
        ],
      });
      const u = (await collect(new A2AGateway().send(ref(s), { text: 'x' }))).find(
        (e) => e.kind === 'usage',
      );
      expect(u && u.kind === 'usage' && u.cost).toBeNull();
      expect(u && u.kind === 'usage' && u.usage.some((x) => x.unit === 'usd')).toBe(false);
    });

    it('reports no usage when the wrapper sends none', async () => {
      const s = (await fake()).queue({
        frames: [task('working'), status('completed', { final: true })],
      });
      expect(
        (await collect(new A2AGateway().send(ref(s), { text: 'x' }))).some(
          (e) => e.kind === 'usage',
        ),
      ).toBe(false);
    });

    it('keeps reading after the final status so late trace events are not lost', async () => {
      const s = (await fake()).queue({
        frames: [
          status('completed', { final: true }),
          artifact('trace.mcp', [data({ toolName: 'late', agent_id: 'a', toolCallId: 'x' })]),
        ],
      });
      const evs = await collect(new A2AGateway().send(ref(s), { text: 'x' }));
      expect(evs.some((e) => e.kind === 'sideband' && e.toolName === 'late')).toBe(true);
    });

    it('preserves unknown sideband artifacts instead of dropping them, and skips malformed frames', async () => {
      const s = (await fake()).queue({
        frames: [
          task('working'),
          'data: {not json}\n\n',
          ': heartbeat\n\n',
          artifact('trace.lifecycle', [data({ phase: 'started' })]),
          artifact('trace.brand-new', [text('hello')]),
          status('completed', { final: true }),
        ],
      });
      const evs = await collect(new A2AGateway().send(ref(s), { text: 'x' }));
      const side = evs.filter((e) => e.kind === 'sideband');
      expect(side).toHaveLength(2);
      expect(side[1]).toMatchObject({
        type: 'status',
        text: 'hello',
        raw: { name: 'trace.brand-new' },
      });
      expect(states(evs).at(-1)).toBe('completed');
    });

    it('delivers structured data and file artifacts', async () => {
      const png = Buffer.from([137, 80, 78, 71]).toString('base64');
      const s = (await fake()).queue({
        frames: [
          task('working'),
          artifact('report', [data({ high: 2 })]),
          artifact('chart', [{ kind: 'file', file: { bytes: png, mimeType: 'image/png' } }]),
          status('completed', { final: true }),
        ],
      });
      const arts = (await collect(new A2AGateway().send(ref(s), { text: 'x' }))).filter(
        (e) => e.kind === 'artifact',
      );
      expect(arts[0]).toMatchObject({
        name: 'report',
        mediaType: 'application/json',
        data: { high: 2 },
      });
      expect(arts[1]).toMatchObject({ name: 'chart', mediaType: 'image/png' });
      expect(Array.from((arts[1] as { bytes: Uint8Array }).bytes)).toEqual([137, 80, 78, 71]);
    });
  });

  describe('conversation and task state', () => {
    it('sends the contextId to resume a conversation and reports the one the agent uses', async () => {
      const s = (await fake()).queue({
        frames: [task('working'), status('completed', { final: true })],
      });
      const evs = await collect(
        new A2AGateway().send(ref(s), { text: 'continue', contextId: 'ctx_resume' }),
      );
      const sent = s.calls[0]!.params as {
        message: { contextId: string; parts: { text: string }[]; role: string };
      };
      expect(s.calls[0]!.method).toBe('message/stream');
      expect(sent.message.contextId).toBe('ctx_resume');
      expect(sent.message.parts[0]!.text).toBe('continue');
      expect(sent.message.role).toBe('user');
      expect(s.calls[0]!.headers.accept).toBe('text/event-stream');
      expect(evs.at(-1)).toMatchObject({ contextId: 'ctx_1' });
    });

    it('surfaces input-required with the agent question and stops waiting', async () => {
      const s = (await fake()).queue({
        frames: [
          task('working'),
          status('input-required', { text: 'API keys or OAuth?', final: true }),
        ],
      });
      const evs = await collect(new A2AGateway().send(ref(s), { text: 'x' }));
      expect(evs.at(-1)).toMatchObject({
        kind: 'state',
        state: 'input_required',
        text: 'API keys or OAuth?',
        taskId: 'task_1',
      });
    });

    it('reads a structured permission request off input-required (provisional wire format, wrapper task W3)', async () => {
      const s = (await fake()).queue({
        frames: [
          task('working'),
          status('input-required', {
            text: 'May I read the spec?',
            final: true,
            metadata: { 'x-access-request': { path: '~/Downloads/spec.pdf', mode: 'read' } },
          }),
        ],
      });
      const last = (await collect(new A2AGateway().send(ref(s), { text: 'x' }))).at(-1);
      expect(last).toMatchObject({
        state: 'input_required',
        text: 'May I read the spec?',
        request: { type: 'access', path: '~/Downloads/spec.pdf', mode: 'read' },
      });
      const plain = (await fake()).queue({
        frames: [status('input-required', { text: 'Which flow?', final: true })],
      });
      expect(
        (await collect(new A2AGateway().send(ref(plain), { text: 'x' }))).at(-1),
      ).not.toHaveProperty('request');
    });

    it('maps failed, rejected, canceled and auth-required states', async () => {
      for (const [wire, want] of [
        ['failed', 'failed'],
        ['rejected', 'failed'],
        ['canceled', 'canceled'],
        ['auth-required', 'input_required'],
        ['TASK_STATE_INPUT_REQUIRED', 'input_required'],
      ] as const) {
        if (v === '0.3' && wire.startsWith('TASK_STATE_')) continue; // a 0.3 agent does not use the 1.0 names
        const s = (await fake()).queue({ frames: [status(wire, { final: true })] });
        expect(
          states(await collect(new A2AGateway().send(ref(s), { text: 'x' }))).at(-1),
          wire,
        ).toBe(want);
      }
    });

    it('treats a stream that ends without a final state as a failure, not a success', async () => {
      const s = (await fake()).queue({
        frames: [task('working'), artifact('response', [text('half')])],
      });
      const evs = await collect(new A2AGateway().send(ref(s), { text: 'x' }));
      expect(evs.at(-1)).toMatchObject({
        kind: 'state',
        state: 'failed',
        text: expect.stringContaining('without a final state'),
      });
    });

    it('turns a direct message reply into an artifact and a completed state', async () => {
      const s = (await fake()).queue({
        frames: [
          {
            kind: 'message',
            messageId: 'm1',
            role: 'agent',
            contextId: 'ctx_9',
            parts: [text('Hello!')],
          },
        ],
      });
      const evs = await collect(new A2AGateway().send(ref(s), { text: 'hi' }));
      expect(evs.filter((e) => e.kind === 'artifact').map(decode)).toEqual(['Hello!']);
      expect(evs.at(-1)).toMatchObject({ state: 'completed', contextId: 'ctx_9' });
    });

    it('falls back to reading a plain JSON task when the agent does not stream', async () => {
      const s = (await fake({ streaming: false })).queue({
        json: {
          jsonrpc: '2.0',
          id: 1,
          result: task('completed', {
            artifacts: [
              { artifactId: 'a', name: 'response', parts: [text('plain')] },
              { artifactId: 'b', name: 'trace.mcp', parts: [data({ toolName: 'x' })] },
            ],
          }),
        },
      });
      const evs = await collect(new A2AGateway().send(ref(s), { text: 'x' }));
      expect(evs.filter((e) => e.kind === 'artifact').map(decode)).toEqual(['plain']);
      expect(evs.at(-1)).toMatchObject({ state: 'completed' });
    });
  });

  describe('failures are explicit', () => {
    it('reports an unreachable agent', async () => {
      const s = await fake();
      const r = ref(s);
      await s.stop();
      servers.length = 0;
      await expect(collect(new A2AGateway().send(r, { text: 'x' }))).rejects.toMatchObject({
        code: 'unreachable',
      });
    });

    it('reports an HTTP error', async () => {
      const s = (await fake()).queue({ status: 502 });
      await expect(collect(new A2AGateway().send(ref(s), { text: 'x' }))).rejects.toMatchObject({
        code: 'http_error',
        message: expect.stringContaining('502'),
      });
    });

    it('reports a JSON-RPC error from inside the stream', async () => {
      const s = (await fake()).queue({
        frames: [
          `data: ${JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'bad params' } })}\n\n`,
        ],
      });
      const err = await collect(new A2AGateway().send(ref(s), { text: 'x' })).catch((e) => e);
      expect(err).toBeInstanceOf(GatewayError);
      expect(err).toMatchObject({
        code: 'rpc_error',
        message: expect.stringContaining('bad params'),
      });
    });

    it('reports an unreadable non-streaming body', async () => {
      const s = (await fake()).queue({ json: { hello: 'world' } });
      await expect(collect(new A2AGateway().send(ref(s), { text: 'x' }))).rejects.toMatchObject({
        code: 'bad_response',
      });
    });
  });

  describe('timeouts and cancellation', () => {
    it('times out a long task, reports timed_out, and cancels the remote task', async () => {
      const s = (await fake()).queue({ frames: [task('working')], hang: true });
      const evs = await collect(new A2AGateway().send(ref(s), { text: 'render', timeoutMs: 250 }));
      expect(evs.at(-1)).toMatchObject({
        kind: 'state',
        state: 'timed_out',
        taskId: 'task_1',
        text: expect.stringContaining('Exceeded'),
      });
      expect(s.methods()).toEqual(['message/stream', 'tasks/cancel']);
      expect((s.calls[1]!.params as { id: string }).id).toBe('task_1');
    });

    it('gives long jobs a longer per-call budget than the default', async () => {
      const s = (await fake()).queue({
        frames: [task('working'), status('working'), status('completed', { final: true })],
        delayMs: 120,
      });
      const gw = new A2AGateway({ defaultTimeoutMs: 100 });
      expect(states(await collect(gw.send(ref(s), { text: 'x', timeoutMs: 5000 }))).at(-1)).toBe(
        'completed',
      );
    });

    it('aborts when the agent goes silent, independent of the total budget', async () => {
      const s = (await fake()).queue({ frames: [task('working')], hang: true });
      const evs = await collect(
        new A2AGateway({ inactivityMs: 150 }).send(ref(s), { text: 'x', timeoutMs: 60_000 }),
      );
      expect(evs.at(-1)).toMatchObject({
        state: 'timed_out',
        text: expect.stringContaining('No activity'),
      });
    });

    it('a caller abort cancels the task and ends canceled', async () => {
      const s = (await fake()).queue({ frames: [task('working')], hang: true });
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 150);
      const evs = await collect(new A2AGateway().send(ref(s), { text: 'x', signal: ac.signal }));
      expect(evs.at(-1)).toMatchObject({ state: 'canceled' });
      expect(s.methods()).toContain('tasks/cancel');
    });

    it('cancel() sends tasks/cancel for the given task', async () => {
      const s = await fake();
      await new A2AGateway().cancel(ref(s), 'task_77');
      expect(s.calls).toHaveLength(1);
      expect(s.calls[0]).toMatchObject({ method: 'tasks/cancel', params: { id: 'task_77' } });
    });
  });

  describe('the correlation context', () => {
    const done = { frames: [task('submitted'), status('completed', { final: true })] };

    it('is sent with the request in the wrapper’s own names', async () => {
      const s = (await fake()).queue(done);
      const gw = new A2AGateway();
      await collect(
        gw.send(ref(s), {
          text: 'hi',
          correlation: {
            runId: 'run_1',
            phaseId: 'draft',
            stepId: 'stp_1',
            traceId: 'ctx_1',
            parentAgentId: 'agt_orch',
          },
        }),
      );
      const message = (s.calls[0]!.params as { message: { metadata: unknown } }).message;
      expect(message.metadata).toEqual({
        trace_id: 'ctx_1',
        parent_agent_id: 'agt_orch',
        propagated_metadata: { run_id: 'run_1', phase_id: 'draft', step_id: 'stp_1' },
      });
    });

    it('is left out when the caller has none, so an older wrapper sees the request it always did', async () => {
      const s = (await fake()).queue(done);
      await collect(new A2AGateway().send(ref(s), { text: 'hi' }));
      expect(
        (s.calls[0]!.params as { message: Record<string, unknown> }).message,
      ).not.toHaveProperty('metadata');
    });
  });
});
