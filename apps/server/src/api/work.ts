import {
  runStatus,
  type ActivityItem,
  type ActorRef,
  type Artifact,
  type CreateRun,
  type Decision,
  type EventEnvelope,
  type Project,
  type Run,
  type RunCost,
  type Step,
  type Usage,
} from '@kramahq/contract';
import {
  CursorGoneError,
  aggregateSpend,
  aggregateUsage,
  type Page as StorePage,
  type RunPatch,
} from '@kramahq/engine';
import type { ApiContext, ApiRequest, Handlers } from './context.js';
import { ApiProblem, notFound } from './problems.js';
import { satisfies, type Principal } from './auth.js';
import {
  Versioned,
  clampLimit,
  csvParam,
  decodeCursor,
  encodePageCursor,
  paginate,
  parseExpand,
  pickFieldsPage,
  type Paged,
} from './helpers.js';

const V1 = '/api/v1';

interface ListQuery {
  limit?: number;
  cursor?: string;
  sort?: string;
  q?: string;
  fields?: string;
}

export const actorOf = (p: Principal): ActorRef => ({ type: 'user', id: p.id, name: p.name });

/** A store page as an API page. The store pages by offset; clients only ever see the opaque cursor. */
function fromStore<T, U>(page: StorePage<T>, map: (t: T) => U): Paged<U> {
  return {
    items: page.items.map(map),
    ...(page.nextCursor ? { nextCursor: encodePageCursor(Number(page.nextCursor)) } : {}),
  };
}

/** Lists the store keeps in one fixed order take no `sort`; asking for another order is an error, not a silent no-op. */
function onlyDefaultOrder(sort: string | undefined, allowed: readonly string[]): void {
  if (sort === undefined || allowed.includes(sort)) return;
  throw new ApiProblem('validation_failed', `Cannot sort by ${sort}`, {
    errors: [{ field: 'sort', message: `this list is ordered ${allowed[0]}` }],
  });
}

const paging = (q: ListQuery) => ({
  limit: clampLimit(q.limit),
  ...(q.cursor ? { cursor: String(decodeCursor(q.cursor)) } : {}),
});

const runLinks = (id: string): Run['links'] => ({
  self: { href: `${V1}/runs/${id}` },
  phases: { href: `${V1}/runs/${id}/phases` },
  steps: { href: `${V1}/runs/${id}/steps` },
  activity: { href: `${V1}/runs/${id}/activity` },
  cost: { href: `${V1}/runs/${id}/cost` },
  decisions: { href: `${V1}/runs/${id}/decisions` },
  artifacts: { href: `${V1}/runs/${id}/artifacts` },
  workspaces: { href: `${V1}/runs/${id}/workspaces` },
  events: { href: `${V1}/runs/${id}/events` },
});

const presentRun = (run: Run, withPhases: boolean): Run => {
  const out: Run = { ...run, links: { ...runLinks(run.id), ...run.links } };
  if (!withPhases) delete out.phases;
  return out;
};

const presentDecision = (d: Decision): Decision => ({
  ...d,
  links: {
    self: { href: `${V1}/decisions/${d.id}` },
    ...(d.status === 'pending'
      ? { resolve: { href: `${V1}/decisions/${d.id}/resolve`, method: 'POST' as const } }
      : {}),
    ...(d.runId ? { run: { href: `${V1}/runs/${d.runId}` } } : {}),
    ...d.links,
  },
});

const presentProject = (p: Project): Project => ({
  ...p,
  links: { self: { href: `${V1}/projects/${p.id}` }, ...p.links },
});

export const presentArtifact = (a: Artifact): Artifact => ({
  ...a,
  links: {
    self: { href: `${V1}/artifacts/${a.id}` },
    content: { href: `${V1}/artifacts/${a.id}/content` },
    versions: { href: `${V1}/artifacts/${a.id}/versions` },
    ...a.links,
  },
});

async function loadRun(ctx: ApiContext, id: string) {
  const cur = await ctx.krama.ports.store.runs.get(id);
  if (!cur) throw notFound('Run', id);
  return cur;
}

/** Whoever started a run, or an operator, may steer it (contract section 6.8, `requester(own)/operator`). */
function assertMayControl(run: Run, p: Principal): void {
  if (satisfies(p, 'operator') || run.createdBy.id === p.id) return;
  throw new ApiProblem(
    'forbidden',
    'Only the person who started this run, or an operator, can change it',
  );
}

const ACTIVITY_TYPES = new Set<ActivityItem['type']>([
  'tool_call',
  'tool_result',
  'thinking',
  'status',
  'message',
  'artifact',
  'decision',
]);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
const rec = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

/** An event of a run as an activity row, or `undefined` for the events that are not activity. */
export function toActivity(e: EventEnvelope): ActivityItem | undefined {
  if (!e.runId) return undefined;
  const d = rec(e.data) ?? {};
  let type: string | undefined;
  let text: string | undefined = str(d['text']);
  if (e.type.startsWith('activity.')) {
    type = d['kind'] === 'thinking' ? 'thinking' : e.type.slice('activity.'.length);
  } else if (e.type === 'artifact.created') {
    type = 'artifact';
    text = str(d['name']) ?? text;
  } else if (e.type === 'decision.requested') {
    type = 'decision';
    text = str(d['title']) ?? text;
  }
  if (!type || !ACTIVITY_TYPES.has(type as ActivityItem['type'])) return undefined;
  const agent = rec(d['agent']);
  const extra: Record<string, unknown> = {};
  if (d['channel'] !== undefined) extra['channel'] = d['channel'];
  if (d['raw'] !== undefined) extra['raw'] = d['raw'];
  const phaseId = str(d['phaseId']);
  const stepId = str(d['stepId']);
  const toolName = str(d['toolName']);
  return {
    id: e.id,
    at: e.at,
    type: type as ActivityItem['type'],
    runId: e.runId,
    ...(phaseId ? { phaseId } : {}),
    ...(stepId ? { stepId: stepId as `step_${string}` } : {}),
    ...(agent && str(agent['id']) && str(agent['role']) && str(agent['backend'])
      ? {
          agent: {
            id: agent['id'] as string,
            role: agent['role'] as string,
            backend: agent['backend'] as string,
          },
        }
      : {}),
    ...(toolName ? { toolName } : {}),
    ...(typeof d['isError'] === 'boolean' ? { isError: d['isError'] } : {}),
    ...(typeof d['durationMs'] === 'number' ? { durationMs: d['durationMs'] } : {}),
    ...(text ? { text } : {}),
    ...(Object.keys(extra).length ? { data: extra } : {}),
  };
}

const EVENT_BATCH = 500;

/**
 * Activity is read from the run's events, so it is whatever the log still holds. The cursor is the id of the last event
 * looked at, which makes a page cheap to continue even when the filters skip most events.
 */
async function activityPage(
  ctx: ApiContext,
  runId: string,
  q: ListQuery & { agent?: string; phase?: string; type?: string },
  fixedTypes?: readonly ActivityItem['type'][],
): Promise<Paged<ActivityItem>> {
  const limit = clampLimit(q.limit);
  const types = fixedTypes ? [...fixedTypes] : csvParam(q.type);
  let after: string | undefined;
  if (q.cursor) {
    if (!/^\d+$/.test(q.cursor))
      throw new ApiProblem('validation_failed', 'The cursor is not valid', {
        errors: [{ field: 'cursor', message: 'unknown cursor' }],
      });
    after = q.cursor;
  }
  const items: ActivityItem[] = [];
  try {
    for (;;) {
      const batch = await ctx.krama.ports.events.read({
        topics: [`run:${runId}`],
        limit: EVENT_BATCH,
        ...(after ? { after } : {}),
      });
      for (const e of batch) {
        after = e.id;
        const item = toActivity(e);
        if (!item) continue;
        if (types && !types.includes(item.type)) continue;
        if (q.agent && item.agent?.id !== q.agent) continue;
        if (q.phase && item.phaseId !== q.phase) continue;
        if (q.q && !(item.text ?? '').toLowerCase().includes(q.q.toLowerCase())) continue;
        items.push(item);
        if (items.length === limit) return { items, nextCursor: e.id };
      }
      if (batch.length < EVENT_BATCH) return { items };
    }
  } catch (e) {
    if (e instanceof CursorGoneError)
      throw new ApiProblem('gone', 'The cursor is older than the events the server still keeps');
    throw e;
  }
}

const usageRows = (lists: readonly (readonly Usage[])[]): Usage[] => aggregateUsage(lists);

/**
 * Cost by phase, agent and backend from what providers reported. A total that mixes reported and unreported cost
 * counts only the reported part, and `null` stays `null`: nothing here is ever estimated. Cost is not reported per
 * tool, so `byTool` is empty.
 */
export async function buildRunCost(ctx: ApiContext, run: Run): Promise<RunCost> {
  const { store } = ctx.krama.ports;
  const [ledger, steps] = await Promise.all([
    store.usage.forRun(run.id),
    store.steps.listByRun(run.id),
  ]);

  const byPhase = (run.phases ?? []).map((p) => ({
    key: p.id,
    label: p.label,
    cost: p.cost ?? null,
    usage: usageRows(ledger.filter((e) => e.phaseId === p.id).map((e) => e.usage)),
  }));

  const group = (keyOf: (s: Step) => string, orchestratorKey: string) => {
    const groups = new Map<
      string,
      { costs: (typeof ledger)[number]['cost'][]; usage: Usage[][] }
    >();
    const add = (key: string, cost: (typeof ledger)[number]['cost'], usage: Usage[]) => {
      const g = groups.get(key) ?? { costs: [], usage: [] };
      g.costs.push(cost);
      g.usage.push(usage);
      groups.set(key, g);
    };
    for (const s of steps) add(keyOf(s), s.cost ?? null, s.usage ?? []);
    // Usage the orchestrator reported on its own has no step: it belongs to the orchestrator, not to nobody.
    for (const e of ledger) if (!e.stepId) add(orchestratorKey, e.cost, e.usage);
    return [...groups].map(([key, g]) => ({
      key,
      label: key,
      cost: aggregateSpend(g.costs).total,
      usage: usageRows(g.usage),
    }));
  };

  return {
    total: run.budget.spent,
    usage: usageRows(ledger.map((e) => e.usage)),
    byPhase,
    byAgent: group((s) => s.agent.role, 'orchestrator'),
    byBackend: group((s) => s.agent.backend, run.orchestrator.backend),
    byTool: [],
  };
}

const FILTER_STATUS = new Set<string>(runStatus.options);

function parseStatuses(v: string | undefined): Run['status'][] | undefined {
  const parts = csvParam(v);
  if (!parts) return undefined;
  const bad = parts.filter((s) => !FILTER_STATUS.has(s));
  if (bad.length)
    throw new ApiProblem('validation_failed', 'Unknown status', {
      errors: bad.map((s) => ({ field: 'status', message: `"${s}" is not a run status` })),
    });
  return parts as Run['status'][];
}

export interface WorkOptions {
  /** Hand a created run to the orchestrator at once. */
  autoStart: boolean;
}

export function workHandlers(o: WorkOptions): Handlers {
  const runHandlers: Handlers = {
    createRun: async (req, reply) => {
      const { krama } = req.ctx;
      const body = req.body as CreateRun;
      if (body.projectId && !(await krama.ports.store.projects.get(body.projectId)))
        throw new ApiProblem('validation_failed', 'The project does not exist', {
          errors: [{ field: 'projectId', message: `Project ${body.projectId} does not exist` }],
        });
      const run = await krama.engine.runs.create(body, actorOf(req.principal), {
        ...(req.idempotencyKey ? { idempotencyKey: req.idempotencyKey } : {}),
      });
      if (o.autoStart && run.status === 'planning') {
        // The orchestrator takes a while to start; the caller gets the run now and follows it over events.
        void krama.runner.start(run.id).catch((e: unknown) => {
          const why = e instanceof Error ? e.message : 'unknown error';
          return krama.engine.runs
            .block(run.id, `Could not start the orchestrator: ${why}`)
            .catch(() => undefined);
        });
      }
      reply.header('location', `${V1}/runs/${run.id}`);
      return presentRun(run, true);
    },

    listRuns: async (req) => {
      const q = req.query as ListQuery & {
        status?: string;
        pack?: string;
        project?: string;
        trigger?: string;
        labels?: string;
        createdBy?: string;
        expand?: string;
      };
      onlyDefaultOrder(q.sort, ['-createdAt']);
      parseExpand(q.expand, ['phases'] as const); // a list always carries phases: the runs table draws them
      const status = parseStatuses(q.status);
      const labels = csvParam(q.labels);
      const page = await req.ctx.krama.ports.store.runs.list({
        ...paging(q),
        ...(status ? { status } : {}),
        ...(q.pack ? { packId: q.pack } : {}),
        ...(q.project ? { projectId: q.project } : {}),
        ...(q.q ? { q: q.q } : {}),
      });
      // The store filters on what it indexes; the rest narrows the page it returned.
      const keep = (r: Run) =>
        (!q.trigger || r.trigger.type === q.trigger) &&
        (!q.createdBy || r.createdBy.id === q.createdBy) &&
        (!labels || labels.every((l) => r.labels.includes(l)));
      const out = fromStore(page, (v) => v.value.run);
      return pickFieldsPage(
        { ...out, items: out.items.filter(keep).map((r) => presentRun(r, true)) },
        q.fields,
      );
    },

    getRun: async (req) => {
      const q = req.query as { expand?: string };
      const expand = parseExpand(q.expand, ['phases'] as const);
      const cur = await loadRun(req.ctx, req.params['id']!);
      return new Versioned(presentRun(cur.value.run, expand.has('phases')), cur.version);
    },

    patchRun: async (req) => {
      const { krama } = req.ctx;
      const id = req.params['id']!;
      const body = req.body as RunPatch;
      const errors: { field: string; message: string }[] = [];
      if (body.title !== undefined && body.title.trim() === '')
        errors.push({ field: 'title', message: 'The title cannot be empty' });
      if (body.budget && !(Number.isFinite(body.budget.max) && body.budget.max > 0))
        errors.push({ field: 'budget.max', message: 'The budget must be a positive number' });
      if (errors.length)
        throw new ApiProblem('validation_failed', 'The change is not valid', { errors });
      const cur = await loadRun(req.ctx, id);
      assertMayControl(cur.value.run, req.principal);
      const out = await krama.engine.runs.update(id, body, actorOf(req.principal), req.ifMatch);
      return new Versioned(presentRun(out.run, true), out.version);
    },

    pauseRun: async (req) => {
      const id = req.params['id']!;
      assertMayControl((await loadRun(req.ctx, id)).value.run, req.principal);
      return presentRun(await req.ctx.krama.engine.runs.pause(id, actorOf(req.principal)), true);
    },

    resumeRun: async (req) => {
      const { krama } = req.ctx;
      const id = req.params['id']!;
      const run = (await loadRun(req.ctx, id)).value.run;
      assertMayControl(run, req.principal);
      if (!['paused', 'interrupted', 'blocked'].includes(run.status))
        throw new ApiProblem('conflict', `A run that is ${run.status} cannot be resumed`);
      // The runner moves the run back to `running` and picks the orchestrator's work up again.
      await krama.runner.resume(id, {
        type: 'user',
        id: req.principal.id,
        name: req.principal.name,
      });
      return presentRun((await loadRun(req.ctx, id)).value.run, true);
    },

    stopRun: async (req) => {
      const { krama } = req.ctx;
      const id = req.params['id']!;
      assertMayControl((await loadRun(req.ctx, id)).value.run, req.principal);
      const body = req.body as { reason?: string } | undefined;
      const run = await krama.engine.runs.stop(id, actorOf(req.principal), body?.reason);
      await krama.runner.stop(id);
      return presentRun(run, true);
    },

    estimateRun: async (req) => {
      const { ports } = req.ctx.krama;
      const body = req.body as CreateRun;
      const pack = await ports.packs.get(body.packId);
      if (!pack) throw notFound('Pack', body.packId);
      const done = (
        await ports.store.runs.list({ packId: pack.id, status: ['completed'], limit: 50 })
      ).items.map((i) => i.value.run);
      const costs = done.flatMap((r) => (r.budget.spent ? [r.budget.spent.amount] : []));
      const seconds = done.flatMap((r) =>
        r.startedAt && r.endedAt ? [(Date.parse(r.endedAt) - Date.parse(r.startedAt)) / 1000] : [],
      );
      const mean = (xs: number[]) =>
        xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100 : null;
      return {
        phases: pack.methodology.phases.map((p) => ({
          id: p.id,
          label: p.label,
          agentRoles: p.roles,
          dependsOn: p.dependsOn,
        })),
        typical: {
          costUsd: mean(costs),
          durationSeconds: mean(seconds),
          basedOnRuns: done.length,
        },
      };
    },

    listPhases: async (req) => ({
      items: (await loadRun(req.ctx, req.params['id']!)).value.run.phases ?? [],
    }),

    getPhase: async (req) => {
      const run = (await loadRun(req.ctx, req.params['id']!)).value.run;
      const phase = run.phases?.find((p) => p.id === req.params['phaseId']);
      if (!phase) throw notFound('Phase', req.params['phaseId']);
      return phase;
    },

    listSteps: async (req) => {
      const q = req.query as ListQuery;
      const id = req.params['id']!;
      await loadRun(req.ctx, id);
      return pickFieldsPage(
        paginate(await req.ctx.krama.ports.store.steps.listByRun(id), q),
        q.fields,
      );
    },

    listActivity: async (req) => {
      const id = req.params['id']!;
      await loadRun(req.ctx, id);
      return activityPage(
        req.ctx,
        id,
        req.query as ListQuery & { agent?: string; phase?: string; type?: string },
      );
    },

    /** The conversation is the run's `message` activity: what the orchestrator and agents said. */
    listRunMessages: async (req) => {
      const id = req.params['id']!;
      await loadRun(req.ctx, id);
      return activityPage(req.ctx, id, req.query as ListQuery, ['message']);
    },

    getRunCost: async (req) =>
      buildRunCost(req.ctx, (await loadRun(req.ctx, req.params['id']!)).value.run),
  };

  const decisionHandlers: Handlers = {
    listDecisions: async (req) => listDecisions(req, undefined),
    listRunDecisions: async (req) => {
      const id = req.params['id']!;
      await loadRun(req.ctx, id);
      return listDecisions(req, id);
    },
    getDecision: async (req) => {
      const cur = await req.ctx.krama.ports.store.decisions.get(req.params['id']!);
      if (!cur) throw notFound('Decision', req.params['id']);
      return presentDecision(cur.value.decision);
    },
    resolveDecision: async (req) => {
      const body = req.body as { optionId: string; input?: string; scope?: 'once' | 'project' };
      const d = await req.ctx.krama.engine.decisions.resolve(
        req.params['id']!,
        {
          optionId: body.optionId,
          ...(body.input !== undefined ? { input: body.input } : {}),
          ...(body.scope ? { scope: body.scope } : {}),
        },
        actorOf(req.principal),
      );
      return presentDecision(d);
    },
  };

  const projectHandlers: Handlers = {
    listProjects: async (req) => {
      const q = req.query as ListQuery;
      onlyDefaultOrder(q.sort, ['createdAt']);
      const page = await req.ctx.krama.ports.store.projects.list(paging(q));
      return pickFieldsPage(
        fromStore(page, (v) => presentProject(v.value)),
        q.fields,
      );
    },
    getProject: async (req) => {
      const cur = await req.ctx.krama.ports.store.projects.get(req.params['id']!);
      if (!cur) throw notFound('Project', req.params['id']);
      return new Versioned(presentProject(cur.value), cur.version);
    },
    createProject: async (req, reply) => {
      const { ports } = req.ctx.krama;
      const body = req.body as {
        name: string;
        description?: string;
        defaultPackId?: `pack_${string}`;
        workItemSource?: string;
        budget?: { max: number };
      };
      if (body.name.trim() === '')
        throw new ApiProblem('validation_failed', 'The project needs a name', {
          errors: [{ field: 'name', message: 'The name cannot be empty' }],
        });
      if (body.budget && !(Number.isFinite(body.budget.max) && body.budget.max > 0))
        throw new ApiProblem('validation_failed', 'The budget must be a positive number', {
          errors: [{ field: 'budget.max', message: 'The budget must be a positive number' }],
        });
      if (body.defaultPackId && !(await ports.packs.get(body.defaultPackId)))
        throw new ApiProblem('validation_failed', 'The pack does not exist', {
          errors: [
            { field: 'defaultPackId', message: `Pack ${body.defaultPackId} does not exist` },
          ],
        });
      const id = ports.ids.next('proj');
      const project: Project = {
        id,
        name: body.name.trim(),
        ...(body.description ? { description: body.description } : {}),
        ...(body.defaultPackId ? { defaultPackId: body.defaultPackId } : {}),
        ...(body.workItemSource ? { workItemSource: body.workItemSource } : {}),
        memoryScope: { type: 'project', id },
        ...(body.budget
          ? { budget: { max: { amount: body.budget.max, currency: 'USD' as const }, spent: null } }
          : {}),
        createdAt: ports.clock.now().toISOString(),
        links: {},
      };
      await ports.store.transaction(async (tx) => {
        await tx.projects.put(project);
        await tx.audit.append({
          id: ports.ids.next('aud'),
          at: project.createdAt,
          actor: actorOf(req.principal),
          action: 'project.created',
          subject: { type: 'project', id },
        });
      });
      reply.header('location', `${V1}/projects/${id}`);
      return presentProject(project);
    },
    patchProject: async (req) => {
      const { ports } = req.ctx.krama;
      const id = req.params['id']!;
      const body = req.body as {
        name?: string;
        description?: string;
        defaultPackId?: `pack_${string}`;
        workItemSource?: string;
        budget?: { max: number };
      };
      if (body.name !== undefined && body.name.trim() === '')
        throw new ApiProblem('validation_failed', 'The project needs a name', {
          errors: [{ field: 'name', message: 'The name cannot be empty' }],
        });
      if (body.budget && !(Number.isFinite(body.budget.max) && body.budget.max > 0))
        throw new ApiProblem('validation_failed', 'The budget must be a positive number', {
          errors: [{ field: 'budget.max', message: 'The budget must be a positive number' }],
        });
      if (body.defaultPackId && !(await ports.packs.get(body.defaultPackId)))
        throw new ApiProblem('validation_failed', 'The pack does not exist', {
          errors: [
            { field: 'defaultPackId', message: `Pack ${body.defaultPackId} does not exist` },
          ],
        });
      const saved = await ports.store.transaction(async (tx) => {
        const cur = await tx.projects.get(id);
        if (!cur) throw notFound('Project', id);
        if (req.ifMatch !== undefined && req.ifMatch !== cur.version)
          throw new ApiProblem(
            'precondition_failed',
            'The If-Match value does not match the current version',
          );
        const next: Project = {
          ...cur.value,
          ...(body.name !== undefined ? { name: body.name.trim() } : {}),
          ...(body.description !== undefined ? { description: body.description } : {}),
          ...(body.defaultPackId !== undefined ? { defaultPackId: body.defaultPackId } : {}),
          ...(body.workItemSource !== undefined ? { workItemSource: body.workItemSource } : {}),
          ...(body.budget
            ? {
                budget: {
                  max: { amount: body.budget.max, currency: 'USD' as const },
                  spent: cur.value.budget?.spent ?? null,
                },
              }
            : {}),
        };
        const put = await tx.projects.put(next, cur.version);
        await tx.audit.append({
          id: ports.ids.next('aud'),
          at: ports.clock.now().toISOString(),
          actor: actorOf(req.principal),
          action: 'project.updated',
          subject: { type: 'project', id },
          detail: { changed: Object.keys(body) },
        });
        return put;
      });
      return new Versioned(presentProject(saved.value), saved.version);
    },
  };

  return { ...runHandlers, ...decisionHandlers, ...projectHandlers };
}

/** The inbox: decisions oldest first, narrowed by what the store indexes and then by the rest. */
async function listDecisions(req: ApiRequest, runId: string | undefined) {
  const q = req.query as ListQuery & {
    status?: string;
    kind?: string;
    runId?: string;
    assignee?: string;
    overdue?: boolean;
  };
  onlyDefaultOrder(q.sort, ['createdAt']);
  const status = csvParam(q.status) as Decision['status'][] | undefined;
  const bad = status?.filter((s) => !['pending', 'resolved', 'expired', 'canceled'].includes(s));
  if (bad?.length)
    throw new ApiProblem('validation_failed', 'Unknown status', {
      errors: bad.map((s) => ({ field: 'status', message: `"${s}" is not a decision status` })),
    });
  const kind = csvParam(q.kind) as Decision['kind'][] | undefined;
  const scope = runId ?? q.runId;
  const page = await req.ctx.krama.ports.store.decisions.list({
    ...paging(q),
    ...(status ? { status } : {}),
    ...(kind ? { kind } : {}),
    ...(scope ? { runId: scope } : {}),
  });
  const now = req.ctx.krama.ports.clock.now().toISOString();
  const text = q.q?.toLowerCase();
  const keep = (d: Decision) =>
    (!q.assignee ||
      d.assignees?.users?.includes(q.assignee) ||
      d.assignees?.roles?.includes(q.assignee)) &&
    (q.overdue === undefined ||
      Boolean(d.status === 'pending' && d.deadline && d.deadline < now) === q.overdue) &&
    (!text || d.title.toLowerCase().includes(text) || d.question.toLowerCase().includes(text));
  const out = fromStore(page, (v) => v.value.decision);
  return pickFieldsPage({ ...out, items: out.items.filter(keep).map(presentDecision) }, q.fields);
}
