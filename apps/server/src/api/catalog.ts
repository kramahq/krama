import type { Agent, AgentDefinition, Pack } from '@kramahq/contract';
import { matchDefinitions } from '@kramahq/engine';
import type { ApiContext, Handlers } from './context.js';
import {
  clampLimit,
  csvParam,
  decodeCursor,
  encodePageCursor,
  paginate,
  pickFieldsPage,
} from './helpers.js';
import { MAX_AGENTS } from './platform.js';
import { ApiProblem, notFound } from './problems.js';

const V1 = '/api/v1';

interface ListQuery {
  limit?: number;
  cursor?: string;
  sort?: string;
  q?: string;
  fields?: string;
}

const has = (q: string | undefined, ...fields: (string | undefined)[]): boolean =>
  !q || fields.some((f) => f?.toLowerCase().includes(q.toLowerCase()));

const presentPack = (p: Pack): Pack => p;

const presentAgent = (a: Agent): Agent => ({
  ...a,
  links: {
    self: { href: `${V1}/agents/${a.id}` },
    health: { href: `${V1}/agents/${a.id}/health` },
    ...(a.assignment ? { run: { href: `${V1}/runs/${a.assignment.runId}` } } : {}),
    ...a.links,
  },
});

/** Decodes a path segment that carries an id with a slash in it (`role/variant`, sent as `role%2Fvariant`). */
const decodeId = (raw: string): string => {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
};

const usableBackend = (ctx: ApiContext) => (d: AgentDefinition) => {
  const allowed = ctx.config.policy.engine.allowedBackends;
  return (
    ctx.krama.backends.get(d.backend.wrapper) !== undefined &&
    (!allowed?.length || allowed.includes(d.backend.wrapper))
  );
};

const AGENT_STATUS = ['starting', 'idle', 'busy', 'unhealthy', 'stopped'] as const;

export function catalogHandlers(): Handlers {
  const definitions = (ctx: ApiContext): AgentDefinition[] =>
    ctx.krama.definitions.map((b) => b.definition);
  const agent = (ctx: ApiContext, id: string): Agent => {
    const a = ctx.krama.runtime.get(id);
    if (!a) throw notFound('Agent', id);
    return a;
  };

  return {
    // ---- Packs (read) -------------------------------------------------------
    listPacks: async (req) => {
      const q = req.query as ListQuery & { status?: string; tag?: string };
      const status = csvParam(q.status);
      const packs = (await req.ctx.krama.ports.packs.list())
        .filter(
          (p) =>
            (!status || status.includes(p.status)) &&
            (!q.tag || p.tags.includes(q.tag)) &&
            has(q.q, p.name, p.description),
        )
        .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
      return pickFieldsPage(paginate(packs.map(presentPack), q), q.fields);
    },
    getPack: async (req) => presentPack(await requirePack(req.ctx, req.params['id']!)),
    getPackManifest: async (req) => ({ ...(await requirePack(req.ctx, req.params['id']!)) }),
    getPackInputsSchema: async (req) =>
      (await requirePack(req.ctx, req.params['id']!)).inputsSchema,
    listPackRuns: async (req) => {
      const q = req.query as ListQuery;
      const pack = await requirePack(req.ctx, req.params['id']!);
      const page = await req.ctx.krama.ports.store.runs.list({
        limit: clampLimit(q.limit),
        ...(q.cursor ? { cursor: String(decodeCursor(q.cursor)) } : {}),
        packId: pack.id,
      });
      return pickFieldsPage(
        {
          items: page.items.map((v) => v.value.run),
          ...(page.nextCursor ? { nextCursor: encodePageCursor(Number(page.nextCursor)) } : {}),
        },
        q.fields,
      );
    },

    // ---- Agent definitions and backends -------------------------------------
    listAgentDefinitions: async (req) => {
      const q = req.query as ListQuery & {
        role?: string;
        capability?: string;
        pack?: string;
        backend?: string;
      };
      const items = definitions(req.ctx)
        .filter(
          (d) =>
            (!q.role || d.role === q.role) &&
            (!q.capability || d.capabilities.includes(q.capability)) &&
            (!q.pack || d.source.packId === q.pack) &&
            (!q.backend || d.backend.wrapper === q.backend) &&
            has(q.q, d.name, d.description),
        )
        .sort((a, b) => a.id.localeCompare(b.id));
      return pickFieldsPage(paginate(items, q), q.fields);
    },
    getAgentDefinition: async (req) => {
      const id = decodeId(req.params['id']!);
      const d = definitions(req.ctx).find((x) => x.id === id);
      if (!d) throw notFound('Agent definition', id);
      return d;
    },
    listBackends: async (req) => {
      const q = req.query as ListQuery;
      const items = req.ctx.krama.backends.list().filter((b) => has(q.q, b.id, b.label));
      return pickFieldsPage(paginate(items, q), q.fields);
    },
    getBackend: async (req) => {
      const b = req.ctx.krama.backends.get(req.params['id']!);
      if (!b) throw notFound('Backend', req.params['id']);
      return b;
    },

    // ---- Fleet ---------------------------------------------------------------
    listAgents: async (req) => {
      const q = req.query as ListQuery & { status?: string; role?: string; runId?: string };
      const status = csvParam(q.status);
      const bad = status?.filter((s) => !(AGENT_STATUS as readonly string[]).includes(s));
      if (bad?.length)
        throw new ApiProblem('validation_failed', 'Unknown status', {
          errors: bad.map((s) => ({ field: 'status', message: `"${s}" is not an agent status` })),
        });
      const items = req.ctx.krama.runtime
        .list({
          ...(status ? { status: status as Agent['status'][] } : {}),
          ...(q.role ? { role: q.role } : {}),
          ...(q.runId ? { runId: q.runId } : {}),
        })
        .sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id));
      return pickFieldsPage(paginate(items.map(presentAgent), q), q.fields);
    },
    getAgent: async (req) => presentAgent(agent(req.ctx, req.params['id']!)),
    getAgentHealth: async (req) => {
      const a = agent(req.ctx, req.params['id']!);
      return {
        status:
          a.status === 'stopped'
            ? 'down'
            : a.status === 'idle' || a.status === 'busy'
              ? 'ok'
              : 'degraded',
      };
    },
    stopAgent: async (req, reply) => {
      const a = agent(req.ctx, req.params['id']!);
      await req.ctx.krama.runtime.stop(a.id);
      reply.code(204);
      return undefined;
    },
    restartAgent: async (req) => {
      const a = agent(req.ctx, req.params['id']!);
      return presentAgent(await req.ctx.krama.runtime.restart(a.id));
    },
    matchAgents: async (req) => {
      const body = req.body as { capabilities: string[]; backend?: string; maxCost?: number };
      const candidates = matchDefinitions(
        definitions(req.ctx),
        {
          capabilities: body.capabilities,
          ...(body.backend ? { backend: body.backend } : {}),
          ...(body.maxCost !== undefined ? { maxCostPerMTok: body.maxCost } : {}),
        },
        usableBackend(req.ctx),
      ).map((c) => ({
        definition: c.definition,
        score: Math.round((c.coverage + (c.backendMatch ? 1 : 0)) * 1000) / 1000,
        reasons: c.reasons,
      }));
      return { candidates };
    },
    getFleetCapacity: async (req) => {
      const { runtime, backends } = req.ctx.krama;
      const live = runtime.list().filter((a) => a.status !== 'stopped');
      return {
        used: live.length,
        max: MAX_AGENTS,
        backends: backends.list().map((b) => {
          const mine = live.filter((a) => a.backend === b.id);
          return {
            wrapper: b.id,
            used: mine.length,
            healthy: !mine.some((a) => a.status === 'unhealthy'),
            // Spend per backend today is not tracked; it is never estimated.
            costToday: null,
          };
        }),
      };
    },
  };
}

async function requirePack(ctx: ApiContext, id: string): Promise<Pack> {
  const p = await ctx.krama.ports.packs.get(id);
  if (!p) throw notFound('Pack', id);
  return p;
}
