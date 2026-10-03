import type { ActivityItem, Agent, Decision, Pack, Run, RunCost, Spend } from '@kramahq/contract';
import type { FastifyReply } from 'fastify';
import type { EventBus } from './bus.js';
import { controlRun, resolveDecision, touchRun } from './effects.js';
import { ProblemError, notFound } from './problems.js';
import type { MockState } from './state.js';

interface Req {
  params: Record<string, string>;
  query: Record<string, string>;
  body: any;
  headers: Record<string, string | string[] | undefined>;
}
export type Handler = (req: Req, reply: FastifyReply) => unknown;

export interface Ctx {
  state: MockState;
  bus: EventBus;
  autoProgress: boolean;
}

const page = <T>(items: T[], q: Record<string, string | undefined>) => {
  const limit = Math.min(Number(q.limit ?? 50) || 50, 200);
  const start = Number(q.cursor ?? 0) || 0;
  const slice = items.slice(start, start + limit);
  return {
    items: slice,
    total: items.length,
    ...(start + limit < items.length ? { nextCursor: String(start + limit) } : {}),
  };
};

const csv = (v?: string) =>
  v
    ? v
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean)
    : [];
const sortBy = <T extends Record<string, any>>(items: T[], sort?: string): T[] => {
  if (!sort) return items;
  const desc = sort.startsWith('-');
  const key = sort.replace(/^-/, '');
  return [...items].sort(
    (a, b) => (a[key] > b[key] ? 1 : a[key] < b[key] ? -1 : 0) * (desc ? -1 : 1),
  );
};
const textMatch = (q: string | undefined, ...fields: (string | undefined)[]) =>
  !q || fields.some((f) => f?.toLowerCase().includes(q.toLowerCase()));

const find = <T extends { id: string }>(list: T[], id: string, what: string): T => {
  const x = list.find((i) => i.id === id);
  if (!x) throw notFound(what, id);
  return x;
};

const spendSum = (items: Spend[]): Spend => {
  if (items.length === 0 || items.every((i) => i === null)) return null;
  return {
    amount: Math.round(items.reduce((a, i) => a + (i?.amount ?? 0), 0) * 100) / 100,
    currency: 'USD',
  };
};

const runCost = (s: MockState, run: Run): RunCost => {
  const byPhase = (run.phases ?? []).map((p) => ({
    key: p.id,
    label: p.label,
    cost: p.cost ?? null,
    usage: [],
  }));
  const runSteps = s.steps.filter((x) => x.runId === run.id);
  const group = (keyOf: (x: (typeof runSteps)[number]) => string) => {
    const m = new Map<string, typeof runSteps>();
    for (const st of runSteps) m.set(keyOf(st), [...(m.get(keyOf(st)) ?? []), st]);
    return [...m].map(([key, items]) => ({
      key,
      label: key,
      cost: spendSum(items.map((i) => i.cost ?? null)),
      usage: items.flatMap((i) => i.usage ?? []),
    }));
  };
  return {
    total: run.budget.spent,
    usage: runSteps.flatMap((x) => x.usage ?? []),
    byPhase,
    byAgent: group((x) => x.agent.role),
    byBackend: group((x) => x.agent.backend),
    byTool: s.activity
      .filter((a) => a.runId === run.id && a.toolName)
      .map((a) => ({ key: a.toolName!, label: a.toolName!, cost: a.cost ?? null, usage: [] })),
  };
};

const tree = (s: MockState, dir: string) => {
  const prefix = dir ? `${dir.replace(/\/$/, '')}/` : '';
  const seen = new Map<
    string,
    { name: string; path: string; type: 'file' | 'dir'; size?: number }
  >();
  for (const [path, body] of Object.entries(s.workspaceFiles)) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const [head, ...more] = rest.split('/');
    if (!head) continue;
    seen.set(
      head,
      more.length
        ? { name: head, path: `${prefix}${head}`, type: 'dir' }
        : { name: head, path, type: 'file', size: body.length },
    );
  }
  return [...seen.values()].sort((a, b) =>
    a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1,
  );
};

const mediaTypeOf = (path: string) =>
  path.endsWith('.ts')
    ? 'text/typescript; charset=utf-8'
    : path.endsWith('.json')
      ? 'application/json'
      : path.endsWith('.md')
        ? 'text/markdown; charset=utf-8'
        : 'text/plain; charset=utf-8';

const sendBytes = (req: Req, reply: FastifyReply, body: Buffer, mediaType: string) => {
  reply.header('accept-ranges', 'bytes').type(mediaType);
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
  if (!range) return reply.send(body);
  const start = range[1] ? Number(range[1]) : Math.max(body.length - Number(range[2]), 0);
  const end = range[1] && range[2] ? Math.min(Number(range[2]), body.length - 1) : body.length - 1;
  if (start > end || start >= body.length)
    return reply.code(416).header('content-range', `bytes */${body.length}`).send();
  return reply
    .code(206)
    .header('content-range', `bytes ${start}-${end}/${body.length}`)
    .send(body.subarray(start, end + 1));
};

export function buildHandlers({ state: s, bus, autoProgress }: Ctx): Record<string, Handler> {
  const run = (id: string) => find(s.runs, id, 'Run');
  const filtered = <T>(
    items: T[],
    q: Record<string, string>,
    test: (i: T, q: Record<string, string>) => boolean,
  ) => page(sortBy(items.filter((i) => test(i, q)) as any[], q.sort) as T[], q);

  const emitAudit = (action: string, subject: { type: string; id: string }) => {
    s.audit.unshift({
      id: `aud_${s.seq}`,
      at: new Date().toISOString(),
      actor: { type: 'user', id: 'u_priya', name: 'Priya' },
      action,
      subject,
    });
    bus.emit('audit.recorded', subject, { action });
  };

  const pendingOp = (type: string, result: Record<string, unknown>, delayMs = 500) => {
    const id = `op_${Date.now().toString(36)}${s.operations.size}` as const;
    const op = {
      id,
      type,
      status: 'running' as const,
      progress: 0,
      startedAt: new Date().toISOString(),
      links: { self: { href: `/api/v1/operations/${id}` } },
    };
    s.operations.set(id, op);
    const done = () => {
      Object.assign(op, {
        status: 'succeeded',
        progress: 1,
        result,
        endedAt: new Date().toISOString(),
      });
      bus.emit('operation.succeeded', { type: 'operation', id }, { operationId: id, progress: 1 });
    };
    if (autoProgress) setTimeout(done, delayMs).unref();
    else done();
    return op;
  };

  return {
    // Platform
    getCapabilities: () => s.capabilities,
    getHealth: () => ({
      status: 'ok',
      version: s.capabilities.engineVersion,
      components: { store: { status: 'ok' }, agents: { status: 'ok' } },
    }),
    getMe: () => ({
      id: 'u_priya',
      name: 'Priya',
      email: 'priya@example.com',
      roles: s.capabilities.features.auth.roles,
      permissions: ['*'],
      preferences: { theme: 'system' },
    }),
    patchPreferences: (req) => ({
      id: 'u_priya',
      name: 'Priya',
      roles: s.capabilities.features.auth.roles,
      permissions: ['*'],
      preferences: req.body ?? {},
    }),
    getOperation: (req) => {
      const op = s.operations.get(req.params.id!);
      if (!op) throw notFound('Operation', req.params.id!);
      return op;
    },
    cancelOperation: (req) => {
      const op = s.operations.get(req.params.id!);
      if (!op) throw notFound('Operation', req.params.id!);
      op.status = 'canceled';
      return op;
    },

    // Runs
    createRun: (req, reply) => {
      const b = req.body;
      const pack = find(s.packs, b.packId, 'Pack');
      const now = new Date().toISOString();
      const id = `run_${Date.now().toString(36).toUpperCase()}`;
      const r: Run = {
        id: id as Run['id'],
        title: b.title ?? b.input.text?.slice(0, 60) ?? pack.name,
        input: b.input,
        pack: { id: pack.id, version: pack.version, sha: pack.source.sha },
        ...(b.projectId ? { projectId: b.projectId } : {}),
        ...(b.workItem ? { workItem: b.workItem } : {}),
        status: 'planning',
        mode: b.mode ?? 'review',
        orchestrator: {
          definitionId: 'orchestrator/default',
          backend: b.orchestrator?.backend ?? 'a2a-codex',
          ...(b.orchestrator?.model ? { model: b.orchestrator.model } : {}),
        },
        budget: {
          max: { amount: b.budget?.max ?? 40, currency: 'USD' },
          spent: null,
          warnAtPct: 80,
          onExceed: 'pause',
        },
        currentPhaseIds: [],
        pendingDecisions: 0,
        trigger: { type: 'manual' },
        labels: b.labels ?? [],
        createdBy: { type: 'user', id: 'u_priya', name: 'Priya' },
        createdAt: now,
        updatedAt: now,
        links: {},
        phases: pack.methodology.phases.map((t) => ({
          id: t.id,
          label: t.label,
          ...(t.kind ? { kind: t.kind } : {}),
          agentRoles: t.roles,
          dependsOn: t.dependsOn,
          status: 'pending' as const,
          iteration: 0,
        })),
      };
      s.runs.unshift(r);
      bus.emit('run.created', { type: 'run', id }, { status: 'planning' }, id);
      const start = () => {
        r.status = 'running';
        const first = r.phases![0];
        if (first) {
          first.status = 'active';
          first.iteration = 1;
          r.currentPhaseIds = [first.id];
        }
        touchRun(s, bus, r, 'run.planned', { phases: r.phases!.map((p) => p.id) });
      };
      if (autoProgress) setTimeout(start, 1200).unref();
      else start();
      reply.code(201);
      return r;
    },
    listRuns: (req) =>
      filtered(
        s.runs,
        req.query,
        (r, q) =>
          (!q.status || csv(q.status).includes(r.status)) &&
          (!q.pack || r.pack.id === q.pack) &&
          (!q.project || r.projectId === q.project) &&
          (!q.trigger || r.trigger.type === q.trigger) &&
          textMatch(q.q, r.title, r.workItem?.ref),
      ),
    getRun: (req) => {
      const r = run(req.params.id!);
      if (csv(req.query.expand).includes('phases')) return r;
      const { phases: _p, ...lite } = r;
      return lite;
    },
    patchRun: (req) => {
      const r = run(req.params.id!);
      const b = req.body;
      if (b.mode) r.mode = b.mode;
      if (b.labels) r.labels = b.labels;
      if (b.title) r.title = b.title;
      if (b.budget) r.budget.max = { amount: b.budget.max, currency: 'USD' };
      touchRun(s, bus, r);
      return r;
    },
    pauseRun: (req) => controlRun(s, bus, run(req.params.id!), 'pause'),
    resumeRun: (req) => controlRun(s, bus, run(req.params.id!), 'resume'),
    stopRun: (req) => controlRun(s, bus, run(req.params.id!), 'stop', req.body?.reason),
    estimateRun: (req) => {
      const pack = find(s.packs, req.body.packId, 'Pack');
      return {
        phases: pack.methodology.phases.map((p) => ({
          id: p.id,
          label: p.label,
          agentRoles: p.roles,
          dependsOn: p.dependsOn,
        })),
        typical: {
          costUsd: pack.stats?.avgCost?.amount ?? null,
          durationSeconds: null,
          basedOnRuns: pack.stats?.runs ?? 0,
        },
      };
    },
    listPhases: (req) => ({ items: run(req.params.id!).phases ?? [] }),
    getPhase: (req) => {
      const p = (run(req.params.id!).phases ?? []).find((x) => x.id === req.params.phaseId);
      if (!p) throw notFound('Phase', req.params.phaseId!);
      return p;
    },
    listSteps: (req) =>
      page(
        s.steps.filter((x) => x.runId === req.params.id),
        req.query,
      ),
    listActivity: (req) => {
      const items: ActivityItem[] = s.activity.filter(
        (a) =>
          a.runId === req.params.id &&
          (!req.query.type || csv(req.query.type).includes(a.type)) &&
          (!req.query.agent || a.agent?.id === req.query.agent) &&
          (!req.query.phase || a.phaseId === req.query.phase),
      );
      return page(items, req.query);
    },
    getRunCost: (req) => runCost(s, run(req.params.id!)),
    getRunMemory: (req) =>
      page(
        s.memory.filter((m) => m.provenance.runId === req.params.id),
        req.query,
      ),
    listFindings: (req) => ({ items: s.findings[req.params.id!] ?? [] }),

    // Workspaces
    listWorkspaces: (req) => {
      run(req.params.id!);
      return {
        items: [
          {
            id: 'ws_main',
            mode: 'isolated',
            path: `/work/${req.params.id}`,
            agents: ['developer-1', 'developer-2', 'reviewer-1'],
          },
        ],
      };
    },
    getWorkspaceTree: (req) => ({ items: tree(s, req.query.path ?? '') }),
    getWorkspaceFile: (req, reply) => {
      const path = req.query.path ?? '';
      const body = s.workspaceFiles[path];
      if (body === undefined) throw notFound('File', path);
      return sendBytes(req, reply, Buffer.from(body), mediaTypeOf(path));
    },
    getWorkspaceGitStatus: () => ({
      branch: 'bolt-2-oauth',
      files: [
        { path: 'src/auth/clientCredentials.ts', status: 'modified' },
        { path: 'src/auth/jwt.ts', status: 'added' },
      ],
    }),
    getWorkspaceDiff: () => ({
      base: 'main',
      diff: Buffer.from(s.artifactContent.get('art_patch')?.body ?? '').toString(),
    }),

    // Artifacts
    listRunArtifacts: (req) =>
      page(
        s.artifacts.filter(
          (a) =>
            a.runId === req.params.id &&
            (!req.query.phase || a.phaseId === req.query.phase) &&
            (!req.query.type || a.type === req.query.type) &&
            (!req.query.status || a.status === req.query.status),
        ),
        req.query,
      ),
    getArtifact: (req) => find(s.artifacts, req.params.id!, 'Artifact'),
    getArtifactContent: (req, reply) => {
      const a = find(s.artifacts, req.params.id!, 'Artifact');
      const c = s.artifactContent.get(a.id);
      if (!c) throw notFound('Artifact content', a.id);
      reply.header('etag', `"${a.sha256}"`);
      return sendBytes(req, reply, c.body, c.mediaType);
    },
    listArtifactVersions: (req) => ({ items: [find(s.artifacts, req.params.id!, 'Artifact')] }),

    // Decisions
    listDecisions: (req) =>
      filtered(
        s.decisions,
        req.query,
        (d: Decision, q) =>
          (!q.status || csv(q.status).includes(d.status)) &&
          (!q.kind || csv(q.kind).includes(d.kind)) &&
          (!q.runId || d.runId === q.runId) &&
          textMatch(q.q, d.title, d.question),
      ),
    getDecision: (req) => find(s.decisions, req.params.id!, 'Decision'),
    resolveDecision: (req) =>
      resolveDecision(s, bus, find(s.decisions, req.params.id!, 'Decision'), req.body),
    listRunDecisions: (req) =>
      page(
        s.decisions.filter(
          (d) => d.runId === req.params.id && (!req.query.status || d.status === req.query.status),
        ),
        req.query,
      ),

    // Packs
    listPacks: (req) =>
      filtered(
        s.packs,
        req.query,
        (p: Pack, q) =>
          (!q.status || csv(q.status).includes(p.status)) && textMatch(q.q, p.name, p.description),
      ),
    getPack: (req) => find(s.packs, req.params.id!, 'Pack'),
    previewPack: (req) => {
      const url = String(req.body?.source?.url ?? '');
      const pack =
        s.packs.find((p) => p.source.url === url) ?? s.packs.find((p) => p.status === 'available');
      if (!pack) throw new ProblemError('not_found', 'No pack at that source');
      const preview = {
        previewId: `pv_${Date.now().toString(36)}`,
        manifestDigest: `sha256:${pack.source.sha}`,
        sha: pack.source.sha,
        manifest: pack,
        trust: pack.trust,
        engineCompatible: true,
        issues: [],
        permissions: pack.permissions,
        secretsToBind: pack.requirements.secrets.map((ref) => ({ ref, bound: false })),
        skills: [],
        definitions: [],
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      };
      bus.emit(
        'pack.previewed',
        { type: 'pack', id: pack.id },
        { packId: pack.id, sha: pack.source.sha },
      );
      return pendingOp('pack.preview', { preview });
    },
    installPack: (req, reply) => {
      const pack = s.packs.find((p) => `sha256:${p.source.sha}` === req.body.manifestDigest);
      if (!pack)
        throw new ProblemError(
          'not_found',
          'Unknown preview',
          'manifestDigest does not match any previewed pack',
        );
      const declined = new Set<string>(req.body.consent.declined);
      const bad = pack.permissions.filter(
        (p) => p.risk === 'high' && !(req.body.consent.granted as string[]).includes(p.id),
      );
      if (bad.length || pack.permissions.some((p) => declined.has(p.id) && p.risk === 'high')) {
        throw new ProblemError(
          'consent_incomplete',
          'Required permissions were declined',
          undefined,
          bad.map((p) => ({
            field: `consent.${p.id}`,
            message: `${p.kind} ${p.subject} is required`,
          })),
        );
      }
      pack.status = 'installed';
      pack.installedAt = new Date().toISOString();
      bus.emit(
        'pack.installed',
        { type: 'pack', id: pack.id },
        { packId: pack.id, sha: pack.source.sha },
      );
      emitAudit('pack.installed', { type: 'pack', id: pack.id });
      reply.code(201);
      return pack;
    },
    getPackManifest: (req) => find(s.packs, req.params.id!, 'Pack'),
    listPackRuns: (req) =>
      page(
        s.runs.filter((r) => r.pack.id === req.params.id),
        req.query,
      ),
    getPackInputsSchema: (req) => find(s.packs, req.params.id!, 'Pack').inputsSchema,

    // Agent definitions / projects
    listAgentDefinitions: (req) =>
      filtered(
        s.definitions,
        req.query,
        (d, q) =>
          (!q.role || d.role === q.role) &&
          (!q.backend || d.backend.wrapper === q.backend) &&
          (!q.capability || d.capabilities.includes(q.capability)),
      ),
    getAgentDefinition: (req) =>
      find(s.definitions, decodeURIComponent(req.params.id!), 'Agent definition'),
    listProjects: (req) => page(s.projects, req.query),
    createProject: (req, reply) => {
      const b = req.body;
      const p = {
        id: `proj_${Date.now().toString(36)}` as `proj_${string}`,
        name: b.name,
        ...(b.description ? { description: b.description } : {}),
        ...(b.defaultPackId ? { defaultPackId: b.defaultPackId } : {}),
        memoryScope: { type: 'project' as const, id: `proj_${b.name}` },
        ...(b.budget
          ? { budget: { max: { amount: b.budget.max, currency: 'USD' as const }, spent: null } }
          : {}),
        createdAt: new Date().toISOString(),
        links: {},
      };
      s.projects.push(p);
      reply.code(201);
      return p;
    },
    getProject: (req) => find(s.projects, req.params.id!, 'Project'),
    patchProject: (req) => Object.assign(find(s.projects, req.params.id!, 'Project'), req.body),

    // Fleet
    listAgents: (req) =>
      filtered(
        s.agents,
        req.query,
        (a: Agent, q) =>
          (!q.status || csv(q.status).includes(a.status)) &&
          (!q.role || a.role === q.role) &&
          (!q.runId || a.assignment?.runId === q.runId),
      ),
    spawnAgent: (req, reply) => {
      const def = find(s.definitions, req.body.definitionId, 'Agent definition');
      const id = `agt_${Date.now().toString(36)}`;
      const a: Agent = {
        id: id as Agent['id'],
        definitionId: def.id,
        role: def.role,
        backend: def.backend.wrapper,
        ...(def.backend.model ? { model: def.backend.model } : {}),
        status: 'starting',
        url: 'http://127.0.0.1:41999',
        startedAt: new Date().toISOString(),
        links: {},
      };
      s.agents.push(a);
      bus.emit('agent.spawned', { type: 'agent', id }, { agentId: id, status: 'starting' });
      const idle = () => {
        a.status = 'idle';
        bus.emit('agent.idle', { type: 'agent', id }, { agentId: id, status: 'idle' });
      };
      if (autoProgress) setTimeout(idle, 800).unref();
      else idle();
      reply.code(201);
      return a;
    },
    getAgent: (req) => find(s.agents, req.params.id!, 'Agent'),
    stopAgent: (req, reply) => {
      const a = find(s.agents, req.params.id!, 'Agent');
      s.agents.splice(s.agents.indexOf(a), 1);
      bus.emit('agent.stopped', { type: 'agent', id: a.id }, { agentId: a.id, status: 'stopped' });
      reply.code(204);
      return undefined;
    },
    restartAgent: (req) => {
      const a = find(s.agents, req.params.id!, 'Agent');
      a.status = 'idle';
      bus.emit('agent.restarted', { type: 'agent', id: a.id }, { agentId: a.id, status: 'idle' });
      return a;
    },
    getAgentHealth: (req) => ({
      status: find(s.agents, req.params.id!, 'Agent').status === 'unhealthy' ? 'degraded' : 'ok',
    }),
    getAgentCard: (req) => {
      const a = find(s.agents, req.params.id!, 'Agent');
      return { name: a.role, url: a.url, protocolVersion: '1.0', skills: [] };
    },
    sendAgentMessage: (req, reply) => {
      const a = find(s.agents, req.params.id!, 'Agent');
      const messageId = `msg_${Date.now().toString(36)}`;
      const steps: [string, string][] = [
        ['activity.status', 'Thinking'],
        ['activity.tool_call', 'fs.list .'],
        ['activity.tool_result', '5 entries'],
        ['activity.message', `Echo: ${req.body.text}`],
      ];
      steps.forEach(([type, text], i) => {
        const emit = () =>
          bus.emit(type, { type: 'agent', id: a.id }, { messageId, text, agent: a.role });
        if (autoProgress) setTimeout(emit, 300 * (i + 1)).unref();
        else emit();
      });
      reply.code(202);
      return { messageId };
    },
    matchAgents: (req) => {
      const want = req.body.capabilities as string[];
      const candidates = s.definitions
        .map((d) => {
          const hit = want.filter((c) => d.capabilities.includes(c));
          const backendBonus = req.body.backend && d.backend.wrapper === req.body.backend ? 1 : 0;
          return {
            definition: d,
            score: hit.length / Math.max(want.length, 1) + backendBonus,
            reasons: [...hit.map((c) => `capability:${c}`), ...(backendBonus ? ['backend'] : [])],
          };
        })
        .filter((c) => c.score > 0)
        .sort((a, b) => b.score - a.score);
      return { candidates };
    },
    getFleetCapacity: () => ({
      used: s.agents.length,
      max: s.capabilities.limits.agentCapacity.max,
      backends: s.capabilities.backends.map((b) => ({
        wrapper: b.wrapper,
        used: s.agents.filter((a) => a.backend === b.wrapper).length,
        healthy: b.wrapper !== 'a2a-antigravity',
        costToday: b.wrapper === 'a2a-copilot' ? 0 : b.wrapper === 'a2a-antigravity' ? null : 38.1,
      })),
    }),

    // Memory
    listMemoryRecords: (req) =>
      filtered(
        s.memory,
        req.query,
        (m, q) =>
          (!q.scope || m.scope.type === q.scope) &&
          (!q.scopeId || m.scope.id === q.scopeId) &&
          (!q.status || csv(q.status).includes(m.status)) &&
          (!q.trust || m.trust === q.trust) &&
          textMatch(q.q, m.content),
      ),
    getMemoryRecord: (req) => find(s.memory, req.params.id!, 'Memory record'),
    listMemoryScopes: () => ({ items: s.memoryScopes }),
    listMemoryProposals: (req) =>
      page(
        s.decisions.filter((d) => d.kind === 'memory'),
        req.query,
      ),

    // Schedules
    listSchedules: (req) => page(s.schedules, req.query),
    getSchedule: (req) => find(s.schedules, req.params.id!, 'Schedule'),
    patchSchedule: (req) => Object.assign(find(s.schedules, req.params.id!, 'Schedule'), req.body),
    deleteSchedule: (req, reply) => {
      s.schedules.splice(s.schedules.indexOf(find(s.schedules, req.params.id!, 'Schedule')), 1);
      reply.code(204);
      return undefined;
    },
    pauseSchedule: (req) => {
      const x = find(s.schedules, req.params.id!, 'Schedule');
      x.status = 'paused';
      bus.emit('schedule.paused', { type: 'schedule', id: x.id }, { scheduleId: x.id });
      return x;
    },
    resumeSchedule: (req) => {
      const x = find(s.schedules, req.params.id!, 'Schedule');
      x.status = 'active';
      return x;
    },

    // Governance
    listPermissions: (req) =>
      page(
        s.packs
          .filter((p) => p.status === 'installed')
          .flatMap((p) =>
            p.permissions.map((pr) => ({
              id: `${p.id}:${pr.id}`,
              holder: { type: 'pack' as const, id: p.id },
              request: { kind: pr.kind, subject: pr.subject, risk: pr.risk },
              grantedAt: p.installedAt ?? new Date().toISOString(),
            })),
          ),
        req.query,
      ),
    revokePermission: (req, reply) => {
      emitAudit('permission.revoked', { type: 'permission', id: req.params.id! });
      reply.code(204);
      return undefined;
    },
    listBudgets: () => ({
      items: s.projects
        .filter((p) => p.budget)
        .map((p) => ({
          scopeType: 'project' as const,
          scopeId: p.id,
          max: p.budget!.max,
          spent: p.budget!.spent,
          period: 'month' as const,
        })),
    }),
    putBudget: (req) => {
      const p = find(s.projects, req.params.id!, 'Project');
      p.budget = { max: req.body.max, spent: p.budget?.spent ?? null };
      return {
        scopeType: 'project',
        scopeId: p.id,
        max: p.budget.max,
        spent: p.budget.spent,
        period: req.body.period,
      };
    },
    getUsage: (req) => {
      const groupBy = req.query.groupBy ?? 'backend';
      const rows = s.capabilities.backends.map((b) => {
        const rs = s.runs.filter((r) => r.orchestrator.backend === b.wrapper);
        const reported = rs.filter((r) => r.budget.spent !== null);
        return {
          key: b.wrapper,
          label: b.label,
          cost: reported.length
            ? {
                amount:
                  Math.round(reported.reduce((a, r) => a + r.budget.spent!.amount, 0) * 100) / 100,
                currency: 'USD' as const,
              }
            : null,
          usage: [{ unit: 'calls', quantity: rs.length }],
        };
      });
      return { groupBy, rows };
    },
    listAudit: (req) => page(s.audit, req.query),
    listAllowedBackends: () => ({
      items: s.capabilities.backends.map((b) => ({
        wrapper: b.wrapper,
        allowed: b.wrapper !== 'a2a-copilot',
      })),
    }),
  };
}
