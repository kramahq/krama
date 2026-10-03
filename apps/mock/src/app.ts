import cors from '@fastify/cors';
import { API_BASE_PATH, ROUTES, type Capabilities } from '@kramahq/contract';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { EventBus, cursorOf, matches } from './bus.js';
import { buildHandlers } from './handlers.js';
import { ProblemError } from './problems.js';
import { registerMockControl } from './control.js';
import { createState, type MockState } from './state.js';

export interface MockOptions {
  /** Simulate timers (planning, previews). Tests turn this off for determinism. */
  autoProgress?: boolean;
  /** Directory with `events-*.ndjson` scenarios. */
  scenariosDir?: string;
  /** Initial capability overrides, merged into the fixture. */
  capabilities?: DeepPartial<Capabilities>;
}
type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

export interface MockApp {
  app: FastifyInstance;
  state: MockState;
  bus: EventBus;
  reset(): void;
}

export const deepMerge = <T extends Record<string, any>>(
  base: T,
  patch: Record<string, any>,
): T => {
  for (const [k, v] of Object.entries(patch)) {
    base[k as keyof T] = (
      v &&
      typeof v === 'object' &&
      !Array.isArray(v) &&
      typeof base[k] === 'object' &&
      base[k] !== null
        ? deepMerge(base[k], v)
        : v
    ) as T[keyof T];
  }
  return base;
};

export async function buildMock(options: MockOptions = {}): Promise<MockApp> {
  const app = Fastify({ logger: false });
  await app.register(cors, { origin: true, exposedHeaders: ['etag', 'content-range'] });

  let state = createState();
  if (options.capabilities) deepMerge(state.capabilities, options.capabilities);
  let bus = new EventBus(state);
  const autoProgress = options.autoProgress ?? true;
  const handle = {
    get state() {
      return state;
    },
    get bus() {
      return bus;
    },
  };

  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof ProblemError)
      return reply.code(err.problem.status).type('application/problem+json').send(err.problem);
    if (err instanceof z.ZodError) {
      const problem = {
        type: 'https://kramahq.dev/problems/validation_failed',
        title: 'Validation failed',
        status: 422,
        code: 'validation_failed',
        errors: err.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
      };
      return reply.code(422).type('application/problem+json').send(problem);
    }
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    return reply
      .code(status)
      .type('application/problem+json')
      .send({
        type: 'https://kramahq.dev/problems/internal',
        title: err.message,
        status,
        code: status === 404 ? 'not_found' : 'internal',
      });
  });
  app.setNotFoundHandler((_req, reply) =>
    reply
      .code(404)
      .type('application/problem+json')
      .send({
        type: 'https://kramahq.dev/problems/not_found',
        title: 'Route not found',
        status: 404,
        code: 'not_found',
      }),
  );

  // Handlers read `state` through the handle, so `reset()` swaps data without re-registering routes.
  const liveState = new Proxy({} as MockState, {
    get: (_t, k) => (handle.state as any)[k],
    set: (_t, k, v) => (((handle.state as any)[k] = v), true),
  });
  const liveBus = new Proxy({} as EventBus, {
    get: (_t, k) => (handle.bus as any)[k]?.bind(handle.bus),
  });
  const handlers = buildHandlers({ state: liveState, bus: liveBus, autoProgress });

  const sse = (topics: string[], req: any, reply: any) => {
    const lastId = (req.headers['last-event-id'] as string | undefined) ?? req.query.cursor;
    if (lastId && bus.tooOld(lastId))
      throw new ProblemError(
        'gone',
        'Cursor too old',
        'Fetch a fresh snapshot, then resume from the latest cursor.',
      );
    reply.hijack();
    const res = reply.raw as import('node:http').ServerResponse;
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'access-control-allow-origin': '*',
    });
    const write = (e: { id: string; type: string }) =>
      res.write(`id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    res.write(`retry: 2000\n: connected cursor=${cursorOf(state.seq - 1)}\n\n`);
    if (lastId) for (const e of bus.since(lastId, topics, 1000)) write(e);
    const unsub = bus.subscribe((e) => {
      if (matches(e, topics)) write(e);
    });
    const beat = setInterval(() => res.write(': heartbeat\n\n'), 15_000);
    req.raw.on('close', () => {
      clearInterval(beat);
      unsub();
    });
  };

  for (const r of ROUTES) {
    const url = `${API_BASE_PATH}${r.path.replace(/\{(\w+)\}/g, ':$1')}`;
    app.route({
      method: r.method,
      url,
      handler: async (req: any, reply) => {
        if (r.query) {
          const q = r.query.safeParse(req.query);
          if (!q.success) throw q.error;
        }
        if (r.body && r.method !== 'GET') {
          const b = r.body.safeParse(req.body ?? {});
          if (!b.success) throw b.error;
          req.body = b.data;
        }
        if (r.stream) {
          const wantsJson =
            String(req.headers.accept ?? '').includes('application/json') ||
            req.query.after !== undefined;
          const topics =
            r.operationId === 'streamRunEvents'
              ? [`run:${req.params.id}`]
              : String(req.query.topics ?? '')
                  .split(',')
                  .filter(Boolean);
          if (r.operationId === 'streamAgentMessage')
            return sse([`agent:${req.params.id}`], req, reply);
          if (wantsJson) {
            if (req.query.after && bus.tooOld(req.query.after))
              throw new ProblemError('gone', 'Cursor too old', 'Fetch a fresh snapshot.');
            const items = bus.since(req.query.after, topics, Number(req.query.limit ?? 200));
            return { items, ...(items.length ? { nextCursor: items.at(-1)!.id } : {}) };
          }
          return sse(topics, req, reply);
        }
        if (r.operationId === 'createEventTicket') {
          reply.code(201);
          return {
            ticket: `tk_${Date.now().toString(36)}`,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          };
        }
        const h = handlers[r.operationId];
        if (!h)
          throw new ProblemError(
            'not_implemented',
            `${r.operationId} is not implemented in the mock yet`,
          );
        return h(req, reply);
      },
    });
  }

  const reset = () => {
    state = createState();
    if (options.capabilities) deepMerge(state.capabilities, options.capabilities);
    bus = new EventBus(state);
  };
  registerMockControl(app, { handle, reset, scenariosDir: options.scenariosDir, autoProgress });
  return {
    app,
    get state() {
      return state;
    },
    get bus() {
      return bus;
    },
    reset,
  } as MockApp;
}
