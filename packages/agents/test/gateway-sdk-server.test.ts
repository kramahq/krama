import { createServer, type Server } from 'node:http';
import { AgentCard, Task, TaskArtifactUpdateEvent, TaskStatusUpdateEvent } from '@a2a-js/sdk';
import {
  AgentEvent,
  DefaultRequestHandler,
  InMemoryTaskStore,
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext,
} from '@a2a-js/sdk/server';
import { UserBuilder, jsonRpcHandler } from '@a2a-js/sdk/server/express';
import type { GatewayEvent } from '@kramahq/engine';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { A2AGateway } from '../src/index.js';

/**
 * An agent built the way the a2a-wrapper core builds one: the official SDK's request handler behind express, a card that
 * is v1 or 0.3 depending on the `A2A-Version` header of the request, and the JSON-RPC route in compatibility mode.
 */
let server: Server | undefined;
const seen: { path: string; version: string | undefined }[] = [];
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

const executor: AgentExecutor = {
  async execute(ctx: RequestContext, bus: ExecutionEventBus) {
    const { taskId, contextId } = ctx;
    const status = (state: string, extra: Record<string, unknown> = {}) =>
      AgentEvent.statusUpdate(
        TaskStatusUpdateEvent.fromJSON({ taskId, contextId, status: { state }, ...extra }),
      );
    bus.publish(
      AgentEvent.task(
        Task.fromJSON({ id: taskId, contextId, status: { state: 'TASK_STATE_SUBMITTED' } }),
      ),
    );
    bus.publish(status('TASK_STATE_WORKING'));
    bus.publish(
      AgentEvent.artifactUpdate(
        TaskArtifactUpdateEvent.fromJSON({
          taskId,
          contextId,
          artifact: {
            artifactId: 'a1',
            name: 'response',
            parts: [{ text: `echo: ${ctx.userMessage.parts[0]?.content?.value}` }],
          },
          lastChunk: true,
        }),
      ),
    );
    bus.publish(
      status('TASK_STATE_COMPLETED', {
        metadata: { 'x-usage': { inputTokens: 10, outputTokens: 5, llmCalls: 1 } },
      }),
    );
    bus.finished();
  },
  async cancelTask() {},
};

async function start(): Promise<string> {
  const app = express();
  let base = '';
  const v1Card = () => ({
    name: 'Wrapper-like agent',
    description: 'Built on the official SDK',
    version: '1.0.0',
    capabilities: { streaming: true },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: [{ id: 'echo', name: 'Echo', description: 'Echoes', tags: [] }],
    supportedInterfaces: [
      {
        url: `${base}/a2a/jsonrpc`,
        protocolBinding: 'JSONRPC',
        protocolVersion: '1.0',
        tenant: '',
      },
      {
        url: `${base}/a2a/jsonrpc`,
        protocolBinding: 'JSONRPC',
        protocolVersion: '0.3.0',
        tenant: '',
      },
    ],
  });
  const handler = new DefaultRequestHandler(
    AgentCard.fromJSON(v1Card()),
    new InMemoryTaskStore(),
    executor,
  );
  app.use((req, _res, next) => {
    seen.push({ path: req.path, version: req.headers['a2a-version'] as string | undefined });
    next();
  });
  app.get('/.well-known/agent-card.json', (req, res) => {
    const v = (req.headers['a2a-version'] as string) || '0.3';
    res.json(
      v.startsWith('0.3')
        ? {
            ...v1Card(),
            supportedInterfaces: undefined,
            protocolVersion: '0.3.0',
            url: `${base}/a2a/jsonrpc`,
            preferredTransport: 'JSONRPC',
          }
        : AgentCard.toJSON(AgentCard.fromJSON(v1Card())),
    );
  });
  app.use(
    '/a2a/jsonrpc',
    jsonRpcHandler({
      requestHandler: handler,
      userBuilder: UserBuilder.noAuthentication,
      legacyCompat: { enabled: true },
    }),
  );
  server = createServer(app);
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server!.address() as { port: number }).port}`;
  return base;
}

describe('an agent built on the official SDK server (as the wrappers are)', () => {
  it('is discovered with a v1 card and called with A2A-Version 1.0', async () => {
    seen.length = 0;
    const url = await start();
    const evs: GatewayEvent[] = [];
    for await (const e of new A2AGateway().send(
      { id: 'a', url, role: 'echo', backend: 'sdk' },
      { text: 'hello', correlation: { runId: 'run_1' } },
    ))
      evs.push(e);

    // The wrapper serves a 0.3 card to a caller that does not say 1.0, so discovery must say it.
    expect(seen[0]).toEqual({ path: '/.well-known/agent-card.json', version: '1.0' });
    expect(seen.slice(1).every((s) => s.version === '1.0')).toBe(true);
    expect(evs.find((e) => e.kind === 'artifact')).toMatchObject({
      name: 'response',
      bytes: new TextEncoder().encode('echo: hello'),
    });
    expect(evs.find((e) => e.kind === 'usage')).toMatchObject({
      usage: [
        { unit: 'tokens', quantity: 15 },
        { unit: 'calls', quantity: 1 },
      ],
    });
    expect(evs.at(-1)).toMatchObject({ kind: 'state', state: 'completed' });
  });
});
