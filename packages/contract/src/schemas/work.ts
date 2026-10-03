import { z } from 'zod';
import { actorRef, id, iso, links, money, packRef, spend, usage } from './common.js';

export const finding = z.object({
  severity: z.enum(['info', 'minor', 'major', 'blocker']),
  title: z.string(),
  detail: z.string().optional(),
  ref: z.string().optional(),
});
export type Finding = z.infer<typeof finding>;

export const runStatus = z.enum([
  'planning',
  'running',
  'paused',
  'awaiting_decision',
  'blocked',
  'completed',
  'failed',
  'stopped',
  'interrupted',
]);
export type RunStatus = z.infer<typeof runStatus>;

export const workItem = z.object({
  source: z.string(),
  ref: z.string().optional(),
  url: z.string().optional(),
  title: z.string().optional(),
  status: z.string().optional(),
});
export type WorkItem = z.infer<typeof workItem>;

export const phaseStatus = z.enum([
  'pending',
  'active',
  'completed',
  'skipped',
  'failed',
  'looping',
  'awaiting_decision',
]);

export const phaseOutcome = z.object({
  status: z.enum(['success', 'failure', 'partial', 'blocked', 'skipped']),
  reason: z.string(),
  gating: z.enum(['continue', 'loop_back', 'skip_downstream', 'halt']),
  loopTarget: z.string().optional(),
  feedback: z.string().optional(),
  findings: z.array(finding).optional(),
});
export type PhaseOutcome = z.infer<typeof phaseOutcome>;

export const phase = z.object({
  id: z.string(),
  label: z.string(),
  kind: z.string().optional(),
  description: z.string().optional(),
  agentRoles: z.array(z.string()),
  count: z.number().optional(),
  parallel: z.boolean().optional(),
  dependsOn: z.array(z.string()),
  status: phaseStatus,
  iteration: z.number(),
  outcome: phaseOutcome.optional(),
  startedAt: iso.optional(),
  endedAt: iso.optional(),
  cost: spend.optional(),
  stepIds: z.array(id('step')).optional(),
  artifactIds: z.array(id('art')).optional(),
});
export type Phase = z.infer<typeof phase>;

export const stepStatus = z.enum([
  'queued',
  'working',
  'input_required',
  'completed',
  'failed',
  'canceled',
  'timed_out',
]);

export const step = z.object({
  id: id('step'),
  runId: id('run'),
  phaseId: z.string(),
  agent: z.object({ id: id('agt'), role: z.string(), backend: z.string() }),
  summary: z.string(),
  /** Idempotency key of the delegation; an identical completed step is returned instead of repeated. */
  key: z.string().optional(),
  status: stepStatus,
  a2a: z.object({
    taskId: z.string().optional(),
    contextId: z.string().optional(),
    resumed: z.boolean(),
  }),
  startedAt: iso.optional(),
  endedAt: iso.optional(),
  cost: spend.optional(),
  usage: z.array(usage).optional(),
  async: z
    .object({
      jobId: z.string(),
      progress: z.number().optional(),
      etaSeconds: z.number().optional(),
    })
    .optional(),
});
export type Step = z.infer<typeof step>;

/**
 * How the orchestrator reaches its workers. `native`: its own A2A sub-agent tools, configured by Krama from the roster.
 * `krama`: through Krama's `delegate_to_agent` tool, which relays over the agent gateway.
 */
export const delegationMode = z.enum(['krama', 'native']);
export type DelegationMode = z.infer<typeof delegationMode>;

export const run = z.object({
  id: id('run'),
  title: z.string(),
  input: z.object({
    text: z.string().optional(),
    params: z.record(z.string(), z.unknown()).optional(),
    attachments: z.array(id('art')).optional(),
  }),
  pack: packRef,
  projectId: id('proj').optional(),
  workItem: workItem.optional(),
  status: runStatus,
  statusReason: z.string().optional(),
  mode: z.enum(['autopilot', 'review']),
  orchestrator: z.object({
    agentId: id('agt').optional(),
    definitionId: z.string(),
    backend: z.string(),
    model: z.string().optional(),
    /** Absent on runs created before delegation modes existed; those behave as `krama`. */
    delegation: delegationMode.optional(),
  }),
  budget: z.object({
    max: money,
    spent: spend,
    warnAtPct: z.number(),
    onExceed: z.enum(['pause', 'stop']),
  }),
  currentPhaseIds: z.array(z.string()),
  phases: z.array(phase).optional(),
  pendingDecisions: z.number(),
  parentRunId: id('run').optional(),
  trigger: z.object({
    type: z.enum(['manual', 'schedule', 'webhook', 'event', 'api']),
    scheduleId: id('sch').optional(),
  }),
  labels: z.array(z.string()),
  createdBy: actorRef,
  createdAt: iso,
  updatedAt: iso,
  startedAt: iso.optional(),
  endedAt: iso.optional(),
  summary: z.string().optional(),
  links,
});
export type Run = z.infer<typeof run>;

export const createRun = z.object({
  packId: id('pack'),
  packVersion: z.string().optional(),
  projectId: id('proj').optional(),
  title: z.string().optional(),
  input: run.shape.input,
  workItem: z.object({ source: z.string(), ref: z.string().optional() }).optional(),
  budget: z.object({ max: z.number() }).optional(),
  mode: z.enum(['autopilot', 'review']).optional(),
  orchestrator: z
    .object({
      definitionId: z.string().optional(),
      backend: z.string().optional(),
      model: z.string().optional(),
      delegation: delegationMode.optional(),
    })
    .optional(),
  labels: z.array(z.string()).optional(),
});
export type CreateRun = z.infer<typeof createRun>;

// ---- Decisions -------------------------------------------------------------

export const decisionKind = z.enum([
  'approval',
  'review',
  'input',
  'budget',
  'access', // agent asks for a path outside the workspace (allow once / for project / deny)
  'consent',
  'memory',
  'publish',
]);
export type DecisionKind = z.infer<typeof decisionKind>;

export const decisionOption = z.object({
  id: z.string(),
  label: z.string(),
  style: z.enum(['primary', 'danger', 'neutral']),
  input: z
    .object({
      required: z.boolean(),
      label: z.string(),
      kind: z.enum(['text', 'markdown', 'choice']),
      choices: z.array(z.string()).optional(),
    })
    .optional(),
  effect: z.string().optional(),
});
export type DecisionOption = z.infer<typeof decisionOption>;

export const decision = z.object({
  id: id('dec'),
  kind: decisionKind,
  status: z.enum(['pending', 'resolved', 'expired', 'canceled']),
  runId: id('run').optional(),
  phaseId: z.string().optional(),
  subject: z.object({ type: z.string(), id: z.string() }).optional(),
  title: z.string(),
  question: z.string(),
  context: z
    .object({
      artifacts: z.array(id('art')).optional(),
      summary: z.string().optional(),
      diffs: z.array(id('art')).optional(),
      findings: z.array(finding).optional(),
    })
    .optional(),
  /** Present when `kind` is `access`. */
  access: z
    .object({ path: z.string(), agent: z.string(), mode: z.enum(['read', 'write']).optional() })
    .optional(),
  options: z.array(decisionOption),
  assignees: z
    .object({ roles: z.array(z.string()).optional(), users: z.array(z.string()).optional() })
    .optional(),
  /** Number of distinct approvers required (default 1). */
  need: z.number().int().min(1).default(1),
  approvals: z.array(z.object({ optionId: z.string(), by: actorRef, at: iso })).optional(),
  deadline: iso.optional(),
  onTimeout: z.enum(['expire', 'escalate', 'auto_approve', 'auto_reject']).optional(),
  createdAt: iso,
  resolvedAt: iso.optional(),
  resolution: z
    .object({ optionId: z.string(), input: z.string().optional(), by: actorRef, at: iso })
    .optional(),
  links,
});
export type Decision = z.infer<typeof decision>;

export const resolveDecision = z.object({
  optionId: z.string(),
  input: z.string().optional(),
  scope: z.enum(['once', 'project']).optional(),
});
export type ResolveDecision = z.infer<typeof resolveDecision>;

// ---- Artifacts -------------------------------------------------------------

export const rendition = z.object({
  kind: z.enum(['thumbnail', 'poster', 'waveform', 'text', 'html', 'slides', 'pages']),
  mediaType: z.string(),
  href: z.string(),
  meta: z.record(z.string(), z.unknown()).optional(),
});

export const artifact = z.object({
  id: id('art'),
  runId: id('run').optional(),
  phaseId: z.string().optional(),
  stepId: id('step').optional(),
  name: z.string(),
  type: z.string(),
  mediaType: z.string(),
  size: z.number(),
  sha256: z.string(),
  version: z.number(),
  supersedes: id('art').optional(),
  status: z.enum(['draft', 'in_review', 'final', 'rejected', 'superseded']),
  producer: actorRef,
  summary: z.string().optional(),
  derivedFrom: z.array(id('art')).optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
  renditions: z.array(rendition),
  createdAt: iso,
  links,
});
export type Artifact = z.infer<typeof artifact>;

// ---- Cost / activity -------------------------------------------------------

export const costBreakdownRow = z.object({
  key: z.string(),
  label: z.string(),
  cost: spend,
  usage: z.array(usage),
});
export const runCost = z.object({
  total: spend,
  usage: z.array(usage),
  byPhase: z.array(costBreakdownRow),
  byAgent: z.array(costBreakdownRow),
  byBackend: z.array(costBreakdownRow),
  byTool: z.array(costBreakdownRow),
});
export type RunCost = z.infer<typeof runCost>;

export const activityItem = z.object({
  id: z.string(),
  at: iso,
  type: z.enum([
    'tool_call',
    'tool_result',
    'thinking',
    'status',
    'message',
    'artifact',
    'decision',
  ]),
  runId: id('run'),
  phaseId: z.string().optional(),
  stepId: id('step').optional(),
  agent: z.object({ id: z.string(), role: z.string(), backend: z.string() }).optional(),
  toolName: z.string().optional(),
  isError: z.boolean().optional(),
  durationMs: z.number().optional(),
  text: z.string().optional(),
  cost: spend.optional(),
  data: z.record(z.string(), z.unknown()).optional(),
});
export type ActivityItem = z.infer<typeof activityItem>;

// ---- Workspaces ------------------------------------------------------------

export const workspace = z.object({
  id: z.string(),
  mode: z.enum(['isolated', 'shared']),
  path: z.string(),
  agents: z.array(z.string()),
});
export const treeEntry = z.object({
  name: z.string(),
  path: z.string(),
  type: z.enum(['file', 'dir']),
  size: z.number().optional(),
});
export const gitStatus = z.object({
  branch: z.string().optional(),
  files: z.array(
    z.object({
      path: z.string(),
      status: z.enum(['added', 'modified', 'deleted', 'renamed', 'untracked']),
    }),
  ),
});
export const workspaceDiff = z.object({ base: z.string().optional(), diff: z.string() });

export type PhaseStatus = z.infer<typeof phaseStatus>;
export type StepStatus = z.infer<typeof stepStatus>;
