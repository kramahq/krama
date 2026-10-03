import { z } from 'zod';
import { actorRef, id, iso, jsonSchema, links, money, problem, spend } from './common.js';
import { memoryScopeType, viewerId, trust } from './catalog.js';
import { runStatus } from './work.js';

// ---- Memory ----------------------------------------------------------------

export const memoryRecord = z.object({
  id: id('mem'),
  scope: z.object({ type: memoryScopeType, id: z.string() }),
  type: z.enum(['episodic', 'semantic', 'procedural']),
  kind: z.string().optional(),
  content: z.string(),
  tags: z.array(z.string()),
  status: z.enum(['active', 'proposed', 'rejected', 'expired', 'superseded']),
  trust: z.enum(['trusted', 'untrusted']),
  confidence: z.object({ initial: z.number(), current: z.number() }),
  provenance: z.object({
    method: z.enum(['agent_inference', 'human', 'import', 'consolidation']),
    runId: id('run').optional(),
    phaseId: z.string().optional(),
    agent: z.string().optional(),
    evidence: z.array(z.object({ type: z.string(), ref: z.string() })).optional(),
  }),
  contentHash: z.string(),
  version: z.number(),
  access: z.object({ read: z.array(z.string()), write: z.array(z.string()) }),
  createdAt: iso,
  updatedAt: iso,
  expiresAt: iso.optional(),
  usage: z.object({ reads: z.number(), lastReadAt: iso.optional() }).optional(),
  links,
});
export type MemoryRecord = z.infer<typeof memoryRecord>;

export const memoryScope = z.object({
  type: memoryScopeType,
  id: z.string(),
  label: z.string(),
  acl: z.array(
    z.object({
      principal: z.string(),
      access: z.enum(['none', 'read', 'propose', 'write', 'admin']),
    }),
  ),
  stats: z.object({ records: z.number(), proposed: z.number(), untrusted: z.number() }),
  sync: z
    .object({
      git: z.object({ url: z.string(), branch: z.string(), lastSyncAt: iso.optional() }).optional(),
    })
    .optional(),
});

// ---- Projects --------------------------------------------------------------

export const project = z.object({
  id: id('proj'),
  name: z.string(),
  description: z.string().optional(),
  defaultPackId: id('pack').optional(),
  workItemSource: z.string().optional(),
  memoryScope: z.object({ type: z.literal('project'), id: z.string() }).optional(),
  budget: z.object({ max: money, spent: spend }).optional(),
  members: z.array(actorRef).optional(),
  createdAt: iso,
  links,
});
export type Project = z.infer<typeof project>;
export const createProject = z.object({
  name: z.string(),
  description: z.string().optional(),
  defaultPackId: id('pack').optional(),
  workItemSource: z.string().optional(),
  budget: z.object({ max: z.number() }).optional(),
});

// ---- Automation ------------------------------------------------------------

export const schedule = z.object({
  id: id('sch'),
  name: z.string(),
  description: z.string().optional(),
  pack: z.object({ id: id('pack'), pin: z.enum(['latest', 'sha']), sha: z.string().optional() }),
  projectId: id('proj').optional(),
  trigger: z.discriminatedUnion('type', [
    z.object({ type: z.literal('cron'), expression: z.string(), timezone: z.string() }),
    z.object({ type: z.literal('interval'), everySeconds: z.number() }),
    z.object({ type: z.literal('once'), at: iso }),
    z.object({
      type: z.literal('webhook'),
      url: z.string(),
      secretRef: z.string(),
      filter: z.string().optional(),
    }),
    z.object({
      type: z.literal('event'),
      source: z.string(),
      filter: z.record(z.string(), z.unknown()),
    }),
  ]),
  input: z.record(z.string(), z.unknown()),
  policies: z.object({
    overlap: z.enum(['skip', 'queue', 'cancel_previous', 'allow']),
    missedFire: z.enum(['catch_up', 'drop']),
    maxConcurrent: z.number(),
    decisionTimeout: z
      .object({ after: z.string(), action: z.enum(['expire', 'escalate']) })
      .optional(),
  }),
  budget: z.object({
    perRun: money,
    perPeriod: z.object({ amount: money, period: z.enum(['day', 'week', 'month']) }).optional(),
  }),
  status: z.enum(['active', 'paused', 'error', 'budget_exhausted']),
  nextFireAt: iso.optional(),
  lastRun: z.object({ runId: id('run'), status: runStatus, at: iso }).optional(),
  owner: actorRef.optional(),
  createdAt: iso.optional(),
  links,
});
export type Schedule = z.infer<typeof schedule>;

// ---- Governance ------------------------------------------------------------

export const operation = z.object({
  id: id('op'),
  type: z.string().optional(),
  status: z.enum(['queued', 'running', 'succeeded', 'failed', 'canceled']),
  progress: z.number().optional(),
  message: z.string().optional(),
  result: z.record(z.string(), z.unknown()).optional(),
  error: problem.optional(),
  startedAt: iso.optional(),
  endedAt: iso.optional(),
  links,
});
export type Operation = z.infer<typeof operation>;

export const auditEntry = z.object({
  id: z.string(),
  at: iso,
  actor: actorRef,
  action: z.string(),
  subject: z.object({ type: z.string(), id: z.string() }),
  detail: z.record(z.string(), z.unknown()).optional(),
  ip: z.string().optional(),
});
export type AuditEntry = z.infer<typeof auditEntry>;

export const source = z.object({
  id: id('src'),
  type: z.literal('git'),
  url: z.string(),
  trust,
  authRef: z.string().optional(),
  signing: z.object({ required: z.boolean(), keys: z.array(z.string()) }).optional(),
  addedBy: actorRef,
  packs: z.number(),
});

export const usageReportRow = z.object({
  key: z.string(),
  label: z.string(),
  cost: spend,
  usage: z.array(z.object({ unit: z.string(), quantity: z.number() })),
});
export const usageReport = z.object({ groupBy: z.string(), rows: z.array(usageReportRow) });

export const budget = z.object({
  scopeType: z.enum(['org', 'project', 'pack', 'schedule']),
  scopeId: z.string(),
  max: money,
  spent: spend,
  period: z.enum(['run', 'day', 'week', 'month']).optional(),
});

export const grantedPermission = z.object({
  id: z.string(),
  holder: z.object({ type: z.enum(['pack', 'skill', 'agent']), id: z.string() }),
  request: z.object({
    kind: z.string(),
    subject: z.string(),
    risk: z.enum(['low', 'medium', 'high']),
  }),
  grantedAt: iso,
});

// ---- Identity / capabilities -----------------------------------------------

export const me = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().optional(),
  roles: z.array(z.string()),
  permissions: z.array(z.string()),
  preferences: z.record(z.string(), z.unknown()),
});
export type Me = z.infer<typeof me>;

export const health = z.object({
  status: z.enum(['ok', 'degraded', 'down']),
  version: z.string(),
  components: z.record(
    z.string(),
    z.object({ status: z.enum(['ok', 'degraded', 'down']), detail: z.string().optional() }),
  ),
});

export const capabilities = z.object({
  apiVersion: z.literal('v1'),
  engineVersion: z.string(),
  a2a: z.object({ versions: z.array(z.string()) }),
  features: z.object({
    runs: z.literal(true),
    decisions: z.literal(true),
    packs: z.boolean(),
    packInstallFromGit: z.boolean(),
    skills: z.boolean(),
    memory: z.object({
      enabled: z.boolean(),
      scopes: z.array(memoryScopeType),
      export: z.array(z.literal('pam')),
      gitSync: z.boolean(),
    }),
    schedules: z.object({
      enabled: z.boolean(),
      triggers: z.array(z.enum(['cron', 'interval', 'once', 'webhook', 'event'])),
    }),
    packTests: z.boolean(),
    builder: z.boolean(),
    typedArtifacts: z.boolean(),
    eventReplay: z.boolean(),
    multiProject: z.boolean(),
    auth: z.object({ mode: z.enum(['token', 'oidc']), roles: z.array(z.string()) }),
  }),
  workItemSources: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      searchable: z.boolean(),
      connected: z.boolean(),
    }),
  ),
  backends: z.array(
    z.object({
      wrapper: z.string(),
      label: z.string(),
      models: z.array(z.string()),
      canOrchestrate: z.boolean(),
    }),
  ),
  viewers: z.array(viewerId),
  limits: z.object({
    maxUploadBytes: z.number(),
    maxRunsConcurrent: z.number(),
    agentCapacity: z.object({ used: z.number(), max: z.number() }),
  }),
  deprecations: z.array(z.object({ path: z.string(), sunset: iso, replacement: z.string() })),
});
export type Capabilities = z.infer<typeof capabilities>;

// ---- Events ----------------------------------------------------------------

export const EVENT_TYPES = [
  'run.created',
  'run.planned',
  'run.updated',
  'run.completed',
  'run.failed',
  'run.stopped',
  'phase.started',
  'phase.completed',
  'phase.skipped',
  'phase.failed',
  'phase.looped',
  'phase.outcome',
  'step.started',
  'step.progress',
  'step.completed',
  'step.failed',
  'decision.requested',
  'decision.resolved',
  'decision.expired',
  'decision.reassigned',
  'artifact.created',
  'artifact.updated',
  'artifact.status_changed',
  'cost.updated',
  'budget.threshold',
  'budget.exceeded',
  'activity.tool_call',
  'activity.tool_result',
  'activity.status',
  'activity.message',
  'agent.spawned',
  'agent.idle',
  'agent.busy',
  'agent.unhealthy',
  'agent.restarted',
  'agent.stopped',
  'memory.proposed',
  'memory.accepted',
  'memory.rejected',
  'memory.expired',
  'memory.consolidated',
  'schedule.fired',
  'schedule.skipped',
  'schedule.failed',
  'schedule.paused',
  'schedule.budget_exhausted',
  'pack.previewed',
  'pack.installed',
  'pack.updated',
  'pack.rolled_back',
  'pack.disabled',
  'test.run.started',
  'test.run.progress',
  'test.run.finished',
  'operation.progress',
  'operation.succeeded',
  'operation.failed',
  'audit.recorded',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const eventEnvelope = z.object({
  id: z.string(),
  type: z.string(), // open set: unknown types are preserved by consumers, never dropped
  at: iso,
  schema: z.literal(1),
  runId: id('run').optional(),
  subject: z.object({ type: z.string(), id: z.string() }),
  actor: actorRef.optional(),
  data: z.unknown(),
});
export type EventEnvelope = z.infer<typeof eventEnvelope>;

export const eventTicket = z.object({ ticket: z.string(), expiresAt: iso });

// Re-exported for the route table
export { jsonSchema };
