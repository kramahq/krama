import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import cors from '@fastify/cors';
import { API_BASE_PATH, ROUTES, buildOpenApi, type RouteDef } from '@kramahq/contract';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { Krama } from '../compose.js';
import { TokenAuth, satisfies, type Principal } from './auth.js';
import { isLoopback, type ServerConfig } from './config.js';
import type { ApiContext, ApiReply, Handler, Handlers } from './context.js';
import { etagOf, notModified, parseIfMatch, Versioned } from './helpers.js';
import { IDEMPOTENCY_HEADER, IdempotencyStore } from './idempotency.js';
import { Preferences, platformHandlers } from './platform.js';
import { ApiProblem, toProblem, validationProblem } from './problems.js';

export interface ApiOptions {
  krama: Krama;
  config: ServerConfig;
  /** Route handlers by `operationId`, layered over the platform ones. A route with none answers 501. */
  handlers?: Handlers;
  /** Check every success body against its contract schema. On in tests, off in production. */
  validateResponses?: boolean;
  idempotency?: IdempotencyStore;
  /** Reported as `engineVersion`; defaults to this package's version. */
  version?: string;
  logger?: boolean;
}

const packageVersion = (): string => {
  try {
    const p = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    return typeof p.version === 'string' ? p.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
};

/** Loopback origins (any port) are always allowed: the UI dev server and the bundled UI run there. */
const LOOPBACK_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

const hostOf = (header: string | undefined): string => {
  const h = (header ?? '').toLowerCase();
  return h.startsWith('[') ? h.slice(1, h.indexOf(']')) : h.replace(/:\d+$/, '');
};

/**
 * Builds the `/api/v1` HTTP server over a composed Krama. Everything cross-cutting lives here (auth, problem+json,
 * validation, idempotency, ETags, the OpenAPI document) so route handlers only translate a request into engine calls.
 */
export async function buildApi(o: ApiOptions): Promise<FastifyInstance> {
  const { krama, config } = o;
  const ctx: ApiContext = { krama, config, version: o.version ?? packageVersion() };
  const auth = new TokenAuth(config.token);
  const idem = o.idempotency ?? new IdempotencyStore();
  const handlers: Handlers = {
    ...platformHandlers(new Preferences(config.home)),
    ...(o.handlers ?? {}),
  };
  const loopbackOnly = isLoopback(config.host);

  const app = Fastify({
    logger: o.logger ?? false,
    bodyLimit: config.bodyLimit,
    genReqId: () => `req_${randomUUID()}`,
    routerOptions: { ignoreTrailingSlash: true },
  });

  app.addHook('onRequest', async (req, reply) => {
    reply.header('x-request-id', req.id);
    // DNS-rebinding guard: a loopback-bound server only answers requests addressed to a loopback name.
    if (loopbackOnly && !isLoopback(hostOf(req.headers.host)))
      throw new ApiProblem('forbidden', 'Requests must be addressed to a loopback host');
  });

  await app.register(cors, {
    origin: (origin, cb) =>
      cb(null, !origin || LOOPBACK_ORIGIN.test(origin) || config.corsOrigins.includes(origin)),
    exposedHeaders: ['etag', 'content-range', 'x-request-id', 'retry-after', 'location'],
    allowedHeaders: [
      'authorization',
      'content-type',
      'idempotency-key',
      'if-match',
      'if-none-match',
      'last-event-id',
    ],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  app.setErrorHandler((err, req, reply) => {
    const p = toProblem(err, req.id);
    if (p.problem.status >= 500) req.log.error({ err }, 'unhandled error');
    return reply
      .code(p.problem.status)
      .headers(p.headers)
      .type('application/problem+json')
      .send(p.problem);
  });
  app.setNotFoundHandler((_req, reply) => {
    const p = new ApiProblem('not_found', 'No such route');
    return reply.code(404).type('application/problem+json').send(p.problem);
  });

  const authenticate = (req: FastifyRequest): Principal => {
    const principal = auth.authenticate(req.headers.authorization);
    if (!principal)
      throw new ApiProblem('unauthenticated', 'A valid bearer token is required', {
        headers: { 'www-authenticate': 'Bearer' },
      });
    return principal;
  };

  for (const r of ROUTES) registerRoute(app, r);

  function registerRoute(a: FastifyInstance, r: RouteDef) {
    const url = `${API_BASE_PATH}${r.path.replace(/\{(\w+)\}/g, ':$1')}`;
    const wantsKey = r.method === 'POST' && r.idempotent === true;
    a.route({
      method: r.method,
      url,
      // Authentication runs before the body is parsed or validated, so an anonymous caller learns nothing.
      onRequest: async (req) => {
        if (r.perm === 'public') return;
        const principal = authenticate(req);
        if (!satisfies(principal, r.perm))
          throw new ApiProblem('forbidden', `This needs the ${r.perm} role`);
        (req as unknown as { principal: Principal }).principal = principal;
      },
      handler: async (req, reply) => {
        const principal = (req as unknown as { principal?: Principal }).principal ?? {
          id: 'anonymous',
          name: 'Anonymous',
          roles: [],
          permissions: [],
        };

        let query: unknown = req.query;
        if (r.query) {
          const parsed = r.query.safeParse(req.query);
          if (!parsed.success) throw validationProblem('query', parsed.error);
          query = parsed.data;
        }
        let body: unknown = req.body;
        if (r.body && r.method !== 'GET') {
          const parsed = r.body.safeParse(req.body ?? {});
          if (!parsed.success) throw validationProblem('body', parsed.error);
          body = parsed.data;
        }

        const ifMatch = r.ifMatch
          ? parseIfMatch(req.headers['if-match'] as string | undefined, true)
          : undefined;
        const handler: Handler | undefined = handlers[r.operationId];
        if (!handler || r.stream)
          throw new ApiProblem(
            'not_implemented',
            `${r.operationId} is not available on this server yet`,
          );

        const key = wantsKey ? (req.headers[IDEMPOTENCY_HEADER] as string | undefined) : undefined;
        const send = async (): Promise<{
          status: number;
          body: unknown;
          headers: Record<string, string>;
        }> => {
          const headers: Record<string, string> = {};
          let status: number = r.status ?? 200;
          const rep: ApiReply = {
            code: (s) => void (status = s),
            header: (n, v) => void (headers[n.toLowerCase()] = v),
          };
          let result = await handler(
            {
              params: req.params as Record<string, string>,
              query,
              body,
              headers: req.headers,
              principal,
              ifMatch,
              idempotencyKey: key,
              requestId: req.id,
              ctx,
            },
            rep,
          );
          if (result instanceof Versioned) {
            headers['etag'] = etagOf(result.version);
            if (
              r.method === 'GET' &&
              notModified(req.headers['if-none-match'] as string | undefined, result.version)
            )
              return { status: 304, body: undefined, headers };
            result = result.body;
          }
          if (o.validateResponses && r.response && result !== undefined) {
            const check = r.response.safeParse(result);
            if (!check.success)
              throw new Error(
                `${r.operationId} returned a body that breaks the contract: ` +
                  check.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
              );
          }
          return {
            status: r.response ? status : 204,
            body: r.response ? result : undefined,
            headers,
          };
        };

        const reply0 = reply as FastifyReply;
        const emit = (
          res: { status: number; body: unknown; headers: Record<string, string> },
          replayed = false,
        ) => {
          reply0.code(res.status).headers(res.headers);
          if (replayed) reply0.header('idempotent-replayed', 'true');
          return res.status === 204 || res.status === 304 ? reply0.send() : reply0.send(res.body);
        };

        if (key === undefined) return emit(await send());

        const fp = IdempotencyStore.fingerprint(r.method, req.url, body);
        const stored = idem.begin(principal.id, key, fp);
        if (stored) return emit(stored, true);
        try {
          const res = await send();
          idem.complete(principal.id, key, res);
          return emit(res);
        } catch (e) {
          // A deliberate client error (4xx) is part of the answer to this key; anything else may be retried.
          if (e instanceof ApiProblem && e.problem.status < 500)
            idem.complete(principal.id, key, {
              status: e.problem.status,
              body: e.problem,
              headers: { 'content-type': 'application/problem+json', ...e.headers },
            });
          else idem.abandon(principal.id, key);
          throw e;
        }
      },
    });
  }

  // The OpenAPI document is generated from the same route table the server registers.
  const openapi = buildOpenApi(ctx.version);
  app.get(`${API_BASE_PATH}/openapi.json`, async () => openapi);

  // Agents that Krama does not call itself report here with their per-instance token (not the user's token).
  // The body is left unread: the collector enforces its own size cap and parses it.
  await app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', (_req, _payload, done) => done(null));
    scope.route({
      method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
      url: '/agent-events',
      handler: async (req, reply) => {
        reply.hijack();
        await krama.collector.handle(req.raw, reply.raw);
      },
    });
  });

  return app;
}
