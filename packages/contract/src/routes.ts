import { z } from 'zod';
import { API_BASE_PATH, jsonSchema, page } from './schemas/common.js';
import {
  activityItem,
  artifact,
  createRun,
  decision,
  finding,
  gitStatus,
  phase,
  resolveDecision,
  run,
  runCost,
  step,
  treeEntry,
  workspace,
  workspaceDiff,
} from './schemas/work.js';
import {
  agent,
  agentDefinition,
  agentMatchRequest,
  agentMatchResult,
  installPack,
  pack,
  packPreviewRequest,
  skill,
} from './schemas/catalog.js';
import {
  auditEntry,
  budget,
  capabilities,
  createProject,
  eventEnvelope,
  eventTicket,
  grantedPermission,
  health,
  me,
  memoryRecord,
  memoryScope,
  operation,
  project,
  schedule,
  source,
  usageReport,
} from './schemas/platform.js';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RouteDef {
  operationId: string;
  method: HttpMethod;
  /** Path relative to `/api/v1`, with `{param}` placeholders. */
  path: string;
  tag: string;
  summary: string;
  /** Permission required (contract section 6.8). `public` means no auth. */
  perm: string;
  query?: z.ZodObject;
  body?: z.ZodType;
  /** Success body; omit for 204. */
  response?: z.ZodType;
  /** Success status (default 200). */
  status?: 200 | 201 | 202 | 204;
  /** Needs the `Idempotency-Key` header. */
  idempotent?: boolean;
  /** Needs `If-Match`. */
  ifMatch?: boolean;
  /** Streams `text/event-stream` instead of JSON. */
  stream?: boolean;
  /** Present in Cut 1 (UI-CUT-1). */
  cut1: boolean;
}

const list = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().optional(),
  sort: z.string().optional(),
  q: z.string().optional(),
  fields: z.string().optional(),
});
const q = (shape: z.ZodRawShape = {}) => list.extend(shape);
const str = z.string().optional();
const generic = jsonSchema;
const genericPage = page(generic);

type Opts = Partial<Omit<RouteDef, 'operationId' | 'method' | 'path' | 'tag' | 'summary' | 'perm'>>;
const routes: RouteDef[] = [];
const def =
  (tag: string) =>
  (
    method: HttpMethod,
    path: string,
    operationId: string,
    summary: string,
    perm: string,
    o: Opts = {},
  ) => {
    routes.push({ operationId, method, path, tag, summary, perm, cut1: true, ...o });
  };
const later = (o: Opts = {}): Opts => ({ cut1: false, ...o });
const asyncOp: Opts = { status: 202, response: operation };

// ---- A. Platform -----------------------------------------------------------
{
  const d = def('Platform');
  d(
    'GET',
    '/capabilities',
    'getCapabilities',
    'Feature flags, versions, limits, viewers',
    'public',
    { response: capabilities },
  );
  d('GET', '/health', 'getHealth', 'Liveness and component status', 'public', { response: health });
  d('GET', '/me', 'getMe', 'Identity, roles, permissions, preferences', 'any', { response: me });
  d('PATCH', '/me/preferences', 'patchPreferences', 'Update UI preferences', 'any', {
    body: generic,
    response: me,
  });
  d('GET', '/search', 'search', 'Global search', 'viewer', {
    query: z.object({ q: z.string(), types: str }),
    response: genericPage,
    ...later(),
  });
  d('GET', '/operations/{id}', 'getOperation', 'Long-running operation status', 'owner/admin', {
    response: operation,
  });
  d('POST', '/operations/{id}/cancel', 'cancelOperation', 'Cancel an operation', 'owner/admin', {
    response: operation,
  });
  d('GET', '/settings', 'getSettings', 'Engine settings', 'admin', {
    response: generic,
    ...later(),
  });
  d('PATCH', '/settings', 'patchSettings', 'Update engine settings', 'admin', {
    body: generic,
    response: generic,
    ...later(),
  });
}

// ---- Events ----------------------------------------------------------------
{
  const d = def('Events');
  d(
    'GET',
    '/events',
    'streamEvents',
    'SSE stream; `?after=` with `Accept: application/json` replays a page',
    'viewer',
    {
      query: z.object({
        topics: str,
        cursor: str,
        after: str,
        limit: z.coerce.number().optional(),
        ticket: str,
      }),
      response: page(eventEnvelope),
      stream: true,
    },
  );
  d('POST', '/events/tickets', 'createEventTicket', 'Single-use SSE ticket (60 s)', 'viewer', {
    response: eventTicket,
    status: 201,
  });
}

// ---- B. Work ---------------------------------------------------------------
{
  const d = def('Runs');
  d('POST', '/runs', 'createRun', 'Create and plan a run', 'requester', {
    body: createRun,
    response: run,
    status: 201,
    idempotent: true,
  });
  d('GET', '/runs', 'listRuns', 'List runs', 'viewer', {
    query: q({
      status: str,
      pack: str,
      project: str,
      trigger: str,
      labels: str,
      createdBy: str,
      expand: str,
    }),
    response: page(run),
  });
  d('GET', '/runs/{id}', 'getRun', 'Run detail', 'viewer', {
    query: z.object({ expand: str }),
    response: run,
  });
  d(
    'PATCH',
    '/runs/{id}',
    'patchRun',
    'Change mode, labels, budget.max, title',
    'requester(own)/operator',
    {
      body: z.object({
        mode: z.enum(['autopilot', 'review']).optional(),
        labels: z.array(z.string()).optional(),
        budget: z.object({ max: z.number() }).optional(),
        title: z.string().optional(),
      }),
      response: run,
      ifMatch: true,
    },
  );
  d('POST', '/runs/{id}/pause', 'pauseRun', 'Pause', 'requester(own)/operator', { response: run });
  d(
    'POST',
    '/runs/{id}/resume',
    'resumeRun',
    'Resume with optional context',
    'requester(own)/operator',
    {
      body: z.object({ context: str }).optional(),
      response: run,
    },
  );
  d('POST', '/runs/{id}/stop', 'stopRun', 'Stop', 'requester(own)/operator', {
    body: z.object({ reason: str }).optional(),
    response: run,
  });
  d('POST', '/runs/{id}/phases/{phaseId}/restart', 'restartPhase', 'Re-run a phase', 'operator', {
    body: z.object({ feedback: str }).optional(),
    response: run,
    ...later(),
  });
  d('POST', '/runs/{id}/fork', 'forkRun', 'Branch a run', 'requester', {
    body: z.object({ fromPhaseId: str, packRef: str }).optional(),
    response: run,
    status: 201,
    ...later(),
  });
  d(
    'POST',
    '/runs/estimate',
    'estimateRun',
    'Static phase preview and typical cost from history',
    'requester',
    {
      body: createRun,
      response: z.object({
        phases: z.array(phase.pick({ id: true, label: true, agentRoles: true, dependsOn: true })),
        typical: z.object({
          costUsd: z.number().nullable(),
          durationSeconds: z.number().nullable(),
          basedOnRuns: z.number(),
        }),
      }),
    },
  );
  d('GET', '/runs/{id}/phases', 'listPhases', 'Phases and outcomes', 'viewer', {
    response: z.object({ items: z.array(phase) }),
  });
  d('GET', '/runs/{id}/phases/{phaseId}', 'getPhase', 'One phase', 'viewer', { response: phase });
  d('GET', '/runs/{id}/steps', 'listSteps', 'Delegations (A2A tasks)', 'viewer', {
    query: q(),
    response: page(step),
  });
  d(
    'GET',
    '/runs/{id}/messages',
    'listRunMessages',
    'Orchestrator and agent conversation',
    'viewer',
    { query: q(), response: genericPage, ...later() },
  );
  d(
    'GET',
    '/runs/{id}/activity',
    'listActivity',
    'Tool calls, results, status; filter by agent, phase, type',
    'viewer',
    {
      query: q({ agent: str, phase: str, type: str }),
      response: page(activityItem),
    },
  );
  d('GET', '/runs/{id}/trace', 'getTrace', 'Span tree for the timeline view', 'viewer', {
    response: generic,
    ...later(),
  });
  d(
    'GET',
    '/runs/{id}/cost',
    'getRunCost',
    'Breakdown by phase, agent, backend, tool; unit-aware',
    'viewer',
    { response: runCost },
  );
  d('GET', '/runs/{id}/memory', 'getRunMemory', 'Records read or proposed by this run', 'viewer', {
    response: page(memoryRecord),
    ...later(),
  });
  d(
    'GET',
    '/runs/{id}/events',
    'streamRunEvents',
    'Run-scoped alias of /events?topics=run:{id}',
    'viewer',
    {
      query: z.object({ cursor: str, after: str, ticket: str }),
      response: page(eventEnvelope),
      stream: true,
    },
  );
  d('GET', '/runs/{id}/findings', 'listFindings', 'Findings across phases', 'viewer', {
    response: z.object({ items: z.array(finding) }),
    ...later(),
  });
}
{
  const d = def('Workspaces');
  d('GET', '/runs/{id}/workspaces', 'listWorkspaces', 'Workspaces and assigned agents', 'viewer', {
    response: z.object({ items: z.array(workspace) }),
  });
  d('GET', '/runs/{id}/workspaces/{wid}/tree', 'getWorkspaceTree', 'Directory tree', 'viewer', {
    query: z.object({ path: str }),
    response: z.object({ items: z.array(treeEntry) }),
  });
  d(
    'GET',
    '/runs/{id}/workspaces/{wid}/file',
    'getWorkspaceFile',
    'File content (binary-safe, Range)',
    'viewer',
    { query: z.object({ path: z.string() }) },
  );
  d(
    'GET',
    '/runs/{id}/workspaces/{wid}/git-status',
    'getWorkspaceGitStatus',
    'Git status',
    'viewer',
    { response: gitStatus },
  );
  d('GET', '/runs/{id}/workspaces/{wid}/diff', 'getWorkspaceDiff', 'Unified diff', 'viewer', {
    query: z.object({ base: str }),
    response: workspaceDiff,
  });
}
{
  const d = def('Artifacts');
  d('GET', '/runs/{id}/artifacts', 'listRunArtifacts', 'Artifacts of a run', 'viewer', {
    query: q({ phase: str, type: str, status: str }),
    response: page(artifact),
  });
  d('GET', '/artifacts', 'listArtifacts', 'Global list and search', 'viewer', {
    query: q({ type: str, status: str }),
    response: page(artifact),
    ...later(),
  });
  d('POST', '/artifacts', 'uploadArtifact', 'Upload (multipart or resumable)', 'requester', {
    response: artifact,
    status: 201,
    ...later(),
  });
  d('GET', '/artifacts/{id}', 'getArtifact', 'Metadata and renditions', 'viewer', {
    response: artifact,
  });
  d(
    'GET',
    '/artifacts/{id}/content',
    'getArtifactContent',
    'Bytes (Range, ETag, Content-Type)',
    'viewer',
  );
  d(
    'GET',
    '/artifacts/{id}/renditions/{kind}',
    'getArtifactRendition',
    'Thumbnail, poster, waveform, slides',
    'viewer',
    later(),
  );
  d('GET', '/artifacts/{id}/versions', 'listArtifactVersions', 'Version chain', 'viewer', {
    response: page(artifact),
  });
  d('GET', '/artifacts/{id}/diff', 'getArtifactDiff', 'Text or structured diff', 'viewer', {
    query: z.object({ against: z.string() }),
    response: workspaceDiff,
    ...later(),
  });
  d('GET', '/artifacts/{id}/lineage', 'getArtifactLineage', 'Derived-from graph', 'viewer', {
    response: generic,
    ...later(),
  });
  d('POST', '/artifacts/{id}/status', 'setArtifactStatus', 'Mark final or rejected', 'approver', {
    body: z.object({ status: z.enum(['draft', 'in_review', 'final', 'rejected']) }),
    response: artifact,
    ...later(),
  });
}
{
  const d = def('Decisions');
  d('GET', '/decisions', 'listDecisions', 'The inbox', 'viewer', {
    query: q({
      status: str,
      kind: str,
      runId: str,
      assignee: str,
      overdue: z.coerce.boolean().optional(),
    }),
    response: page(decision),
  });
  d('GET', '/decisions/{id}', 'getDecision', 'Decision with context', 'viewer', {
    response: decision,
  });
  d(
    'POST',
    '/decisions/{id}/resolve',
    'resolveDecision',
    'Resolve (first resolve wins; engine is always notified)',
    'approver',
    {
      body: resolveDecision,
      response: decision,
    },
  );
  d('POST', '/decisions/{id}/defer', 'deferDecision', 'Snooze', 'approver', {
    body: z.object({ until: z.iso.datetime() }),
    response: decision,
    ...later(),
  });
  d('POST', '/decisions/{id}/reassign', 'reassignDecision', 'Reassign', 'approver/operator', {
    body: z.object({
      roles: z.array(z.string()).optional(),
      users: z.array(z.string()).optional(),
    }),
    response: decision,
    ...later(),
  });
  d('GET', '/runs/{id}/decisions', 'listRunDecisions', 'Decisions of a run', 'viewer', {
    query: q({ status: str }),
    response: page(decision),
  });
}

// ---- C. Catalog ------------------------------------------------------------
{
  const d = def('Packs');
  d('GET', '/packs', 'listPacks', 'Installed and available packs', 'viewer', {
    query: q({ status: str, tag: str }),
    response: page(pack),
  });
  d('GET', '/packs/{id}', 'getPack', 'Pack detail', 'viewer', { response: pack });
  d('POST', '/packs/preview', 'previewPack', 'Resolve, validate, permission surface', 'author', {
    body: packPreviewRequest,
    ...asyncOp,
  });
  d('POST', '/packs', 'installPack', 'Install after consent', 'admin', {
    body: installPack,
    response: pack,
    status: 201,
    idempotent: true,
  });
  d(
    'POST',
    '/packs/{id}/update/preview',
    'previewPackUpdate',
    'Diff against a newer SHA',
    'admin',
    { ...asyncOp, ...later() },
  );
  d('POST', '/packs/{id}/update', 'updatePack', 'Update after consent', 'admin', {
    body: installPack,
    response: pack,
    ...later(),
  });
  d('POST', '/packs/{id}/rollback', 'rollbackPack', 'Roll back to a SHA', 'admin', {
    body: z.object({ sha: z.string() }),
    response: pack,
    ...later(),
  });
  d('POST', '/packs/{id}/disable', 'disablePack', 'Disable', 'admin', {
    response: pack,
    ...later(),
  });
  d('POST', '/packs/{id}/enable', 'enablePack', 'Enable', 'admin', { response: pack, ...later() });
  d('DELETE', '/packs/{id}', 'uninstallPack', 'Uninstall', 'admin', { status: 204, ...later() });
  d('GET', '/packs/{id}/manifest', 'getPackManifest', 'Raw manifest', 'viewer', {
    response: generic,
  });
  d('GET', '/packs/{id}/files', 'getPackFiles', 'Read-only file browser', 'viewer', {
    query: z.object({ path: str }),
    ...later(),
  });
  d('GET', '/packs/{id}/versions', 'listPackVersions', 'Installed history', 'viewer', {
    response: genericPage,
    ...later(),
  });
  d('GET', '/packs/{id}/runs', 'listPackRuns', 'Runs of this pack', 'viewer', {
    query: q(),
    response: page(run),
  });
  d(
    'GET',
    '/packs/{id}/inputs-schema',
    'getPackInputsSchema',
    'JSON Schema with ui hints',
    'viewer',
    { response: generic },
  );
}
{
  const d = def('Agent definitions');
  d('GET', '/agent-definitions', 'listAgentDefinitions', 'List definitions', 'viewer', {
    query: q({ role: str, capability: str, pack: str, backend: str }),
    response: page(agentDefinition),
  });
  d(
    'GET',
    '/agent-definitions/{id}',
    'getAgentDefinition',
    'Definition (id = role/variant)',
    'viewer',
    { response: agentDefinition },
  );
  d('GET', '/mcp-servers', 'listMcpServers', 'MCP catalog and connectivity', 'viewer', {
    response: genericPage,
    ...later(),
  });
}
{
  const d = def('Projects');
  d('GET', '/projects', 'listProjects', 'List projects', 'viewer', {
    query: q(),
    response: page(project),
  });
  d('POST', '/projects', 'createProject', 'Create project', 'operator', {
    body: createProject,
    response: project,
    status: 201,
    idempotent: true,
  });
  d('GET', '/projects/{id}', 'getProject', 'Project detail', 'viewer', { response: project });
  d('PATCH', '/projects/{id}', 'patchProject', 'Update project', 'operator', {
    body: createProject.partial(),
    response: project,
    ifMatch: true,
  });
  d('DELETE', '/projects/{id}', 'deleteProject', 'Delete project', 'admin', {
    status: 204,
    ...later(),
  });
}

// ---- D. Fleet --------------------------------------------------------------
{
  const d = def('Fleet');
  d('GET', '/agents', 'listAgents', 'Running instances', 'viewer', {
    query: q({ status: str, role: str, runId: str }),
    response: page(agent),
  });
  d('POST', '/agents', 'spawnAgent', 'Spawn an instance', 'operator', {
    body: z.object({ definitionId: z.string(), overrides: generic.optional() }),
    response: agent,
    status: 201,
  });
  d('GET', '/agents/{id}', 'getAgent', 'Instance detail', 'viewer', { response: agent });
  d('DELETE', '/agents/{id}', 'stopAgent', 'Stop and remove', 'operator', { status: 204 });
  d('POST', '/agents/{id}/restart', 'restartAgent', 'Restart', 'operator', { response: agent });
  d('GET', '/agents/{id}/health', 'getAgentHealth', 'Health', 'viewer', {
    response: health.pick({ status: true }),
  });
  d('GET', '/agents/{id}/card', 'getAgentCard', 'A2A agent card', 'viewer', { response: generic });
  d('POST', '/agents/{id}/messages', 'sendAgentMessage', 'Playground chat (audited)', 'operator', {
    body: z.object({ text: z.string(), contextId: str }),
    response: z.object({ messageId: z.string() }),
    status: 202,
  });
  d(
    'GET',
    '/agents/{id}/messages/{mid}/events',
    'streamAgentMessage',
    'Stream the response with sideband events',
    'operator',
    { response: page(eventEnvelope), stream: true },
  );
  d('GET', '/agents/{id}/sessions', 'listAgentSessions', 'Contexts held', 'operator', {
    response: genericPage,
    ...later(),
  });
  d('POST', '/agents/match', 'matchAgents', 'Ranked candidates', 'viewer', {
    body: agentMatchRequest,
    response: agentMatchResult,
  });
  d('GET', '/fleet/capacity', 'getFleetCapacity', 'Used and max per backend', 'viewer', {
    response: z.object({
      used: z.number(),
      max: z.number(),
      backends: z.array(
        z.object({
          wrapper: z.string(),
          used: z.number(),
          healthy: z.boolean(),
          costToday: z.number().nullable(),
        }),
      ),
    }),
  });
}

// ---- E. Knowledge ----------------------------------------------------------
{
  const d = def('Memory');
  d('GET', '/memory/records', 'listMemoryRecords', 'Search and list records', 'viewer', {
    query: q({ scope: str, scopeId: str, type: str, status: str, trust: str, tag: str }),
    response: page(memoryRecord),
  });
  d('POST', '/memory/records', 'createMemoryRecord', 'Human-authored record', 'operator', {
    body: generic,
    response: memoryRecord,
    status: 201,
    ...later(),
  });
  d('GET', '/memory/records/{id}', 'getMemoryRecord', 'Record with provenance', 'viewer', {
    response: memoryRecord,
  });
  d('PATCH', '/memory/records/{id}', 'patchMemoryRecord', 'Edit', 'operator', {
    body: generic,
    response: memoryRecord,
    ifMatch: true,
    ...later(),
  });
  d('POST', '/memory/records/{id}/expire', 'expireMemoryRecord', 'Expire now', 'operator', {
    response: memoryRecord,
    ...later(),
  });
  d('DELETE', '/memory/records/{id}', 'forgetMemoryRecord', 'Forget (audited)', 'operator', {
    status: 204,
    ...later(),
  });
  d('GET', '/memory/scopes', 'listMemoryScopes', 'Scopes with stats', 'viewer', {
    response: z.object({ items: z.array(memoryScope) }),
  });
  d('POST', '/memory/export', 'exportMemory', 'Export as PAM', 'operator', {
    ...asyncOp,
    ...later(),
  });
  d('POST', '/memory/import', 'importMemory', 'Import a PAM file as proposals', 'operator', {
    ...asyncOp,
    ...later(),
  });
  d('POST', '/memory/consolidate', 'consolidateMemory', 'Run consolidation now', 'operator', {
    ...asyncOp,
    ...later(),
  });
  d(
    'GET',
    '/memory/proposals',
    'listMemoryProposals',
    'Alias of /decisions?kind=memory',
    'viewer',
    { response: page(decision) },
  );
}
{
  const d = def('Skills');
  d('GET', '/skills', 'listSkills', 'Installed skills', 'viewer', {
    query: q({ risk: str, validation: str }),
    response: page(skill),
    ...later(),
  });
  d('GET', '/skills/{id}', 'getSkill', 'Skill detail', 'viewer', { response: skill, ...later() });
  d('POST', '/skills/validate', 'validateSkill', 'Validate against the spec', 'author', {
    body: generic,
    response: generic,
    ...later(),
  });
}

// ---- F. Automation, governance --------------------------------------------
{
  const d = def('Schedules');
  d('GET', '/schedules', 'listSchedules', 'List schedules', 'operator', {
    query: q({ status: str }),
    response: page(schedule),
  });
  d('POST', '/schedules', 'createSchedule', 'Create schedule', 'operator', {
    body: generic,
    response: schedule,
    status: 201,
    idempotent: true,
    ...later(),
  });
  d('GET', '/schedules/{id}', 'getSchedule', 'Schedule detail', 'operator', { response: schedule });
  d('PATCH', '/schedules/{id}', 'patchSchedule', 'Update schedule', 'operator', {
    body: generic,
    response: schedule,
    ifMatch: true,
  });
  d('DELETE', '/schedules/{id}', 'deleteSchedule', 'Delete schedule', 'operator', { status: 204 });
  d('POST', '/schedules/{id}/pause', 'pauseSchedule', 'Pause', 'operator', { response: schedule });
  d('POST', '/schedules/{id}/resume', 'resumeSchedule', 'Resume', 'operator', {
    response: schedule,
  });
  d('POST', '/schedules/{id}/fire', 'fireSchedule', 'Fire now', 'operator', {
    response: run,
    status: 201,
    ...later(),
  });
  d('GET', '/schedules/{id}/runs', 'listScheduleRuns', 'History', 'viewer', {
    query: q(),
    response: page(run),
    ...later(),
  });
  d('POST', '/schedules/preview', 'previewSchedule', 'Next N fire times', 'operator', {
    body: z.object({ trigger: generic, count: z.number().optional() }),
    response: z.object({ fireTimes: z.array(z.iso.datetime()) }),
    ...later(),
  });
  d(
    'POST',
    '/triggers/webhooks/{token}',
    'receiveWebhook',
    'Inbound webhook (signature-verified)',
    'public',
    { body: generic, status: 202, ...later() },
  );
}
{
  const d = def('Governance');
  d('GET', '/sources', 'listSources', 'Git sources and trust', 'admin', {
    response: page(source),
    ...later(),
  });
  d('GET', '/permissions', 'listPermissions', 'What each pack, skill or agent holds', 'admin', {
    response: page(grantedPermission),
  });
  d('DELETE', '/permissions/{id}', 'revokePermission', 'Revoke', 'admin', { status: 204 });
  d('GET', '/budgets', 'listBudgets', 'Budgets by scope', 'admin', {
    response: z.object({ items: z.array(budget) }),
  });
  d('PUT', '/budgets/{scopeType}/{id}', 'putBudget', 'Set a budget', 'admin', {
    body: budget.pick({ max: true, period: true }),
    response: budget,
  });
  d('GET', '/usage', 'getUsage', 'Spend and usage report, multi-unit', 'operator', {
    query: z.object({ groupBy: str, from: str, to: str }),
    response: usageReport,
  });
  d('GET', '/audit', 'listAudit', 'Audit log', 'admin', {
    query: q({ actor: str, action: str, from: str, to: str }),
    response: page(auditEntry),
  });
  d('GET', '/allowed-backends', 'listAllowedBackends', 'Backends the platform may use', 'admin', {
    response: z.object({ items: z.array(z.object({ wrapper: z.string(), allowed: z.boolean() })) }),
  });
}

/** Every route the platform exposes under `/api/v1`. */
export const ROUTES: readonly RouteDef[] = routes;
export const CUT1_ROUTES: readonly RouteDef[] = routes.filter((r) => r.cut1);

export const fullPath = (r: Pick<RouteDef, 'path'>): string => `${API_BASE_PATH}${r.path}`;
