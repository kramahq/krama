import { z } from 'zod';
import { decisionKind } from './work.js';
import { id, iso, jsonSchema, links, money, spend } from './common.js';

export const memoryScopeType = z.enum(['agent', 'role', 'project', 'pack', 'org', 'orchestrator']);
export type MemoryScopeType = z.infer<typeof memoryScopeType>;
export const memoryAccess = z.enum(['read', 'propose', 'write']);

export const viewerId = z.enum([
  'markdown',
  'code',
  'diff',
  'json',
  'table',
  'image',
  'audio',
  'video',
  'pdf',
  'slides',
  'html-sandboxed',
  'download',
]);
export type ViewerId = z.infer<typeof viewerId>;

export const trust = z.enum(['trusted', 'verified', 'untrusted', 'blocked']);

export const permissionRequest = z.object({
  id: z.string(),
  kind: z.enum([
    'mcp_server',
    'tool',
    'network',
    'secret_ref',
    'memory_scope',
    'workspace',
    'script_execution',
  ]),
  subject: z.string(),
  access: z.string().optional(),
  risk: z.enum(['low', 'medium', 'high']),
  reason: z.string().optional(),
  requestedBy: z.string(),
});
export type PermissionRequest = z.infer<typeof permissionRequest>;

// ---- Methodology -----------------------------------------------------------

export const phaseTemplate = z.object({
  id: z.string(),
  label: z.string(),
  kind: z.string().optional(),
  roles: z.array(z.string()),
  dependsOn: z.array(z.string()),
  optional: z.boolean().optional(),
  parallel: z.boolean().optional(),
});
export const gateRule = z.object({
  afterPhase: z.string(),
  kind: decisionKind,
  policy: z.enum(['human_required', 'auto', 'conditional']),
  condition: z.string().optional(),
  label: z.string(),
  /** Distinct approvers required (default 1). */
  need: z.number().int().min(1).optional(),
});
export const evaluatorRule = z.object({
  producer: z.string(),
  evaluator: z.string(),
  maxLoops: z.number().int().min(0),
  crossBackend: z.boolean().optional(),
});
export const methodology = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  phases: z.array(phaseTemplate),
  gates: z.array(gateRule),
  evaluators: z.array(evaluatorRule),
  iteration: z.object({ unit: z.string(), label: z.string() }).optional(),
});
export type Methodology = z.infer<typeof methodology>;

export const rosterEntry = z.object({
  role: z.string(),
  select: z.object({
    definitionId: z.string().optional(),
    capabilities: z.array(z.string()).optional(),
    backend: z.string().optional(),
  }),
  count: z.number().optional(),
  optional: z.boolean().optional(),
});
export const artifactTypeDef = z.object({
  type: z.string(),
  label: z.string(),
  mediaTypes: z.array(z.string()),
  viewer: viewerId,
  icon: z.string().optional(),
});

export const packUi = z.object({
  terminology: z.record(z.string(), z.string()).optional(),
  phases: z
    .record(
      z.string(),
      z.object({
        label: z.string().optional(),
        icon: z.string().optional(),
        color: z.string().optional(),
      }),
    )
    .optional(),
  decisions: z
    .record(z.string(), z.object({ label: z.string().optional(), helpText: z.string().optional() }))
    .optional(),
  artifacts: z
    .record(
      z.string(),
      z.object({
        viewer: viewerId.optional(),
        label: z.string().optional(),
        primary: z.boolean().optional(),
      }),
    )
    .optional(),
  runCard: z
    .object({
      badges: z.array(z.string()).optional(),
      metrics: z.array(z.object({ label: z.string(), path: z.string() })).optional(),
    })
    .optional(),
  links: z.record(z.string(), z.string()).optional(),
});
export type PackUi = z.infer<typeof packUi>;

export const pack = z.object({
  id: id('pack'),
  name: z.string(),
  version: z.string(),
  description: z.string(),
  icon: z.string().optional(),
  tags: z.array(z.string()),
  status: z.enum(['installed', 'available', 'update_available', 'disabled', 'draft']),
  source: z.object({
    type: z.literal('git'),
    url: z.string(),
    ref: z.string(),
    sha: z.string(),
    path: z.string().optional(),
  }),
  trust,
  engine: z.object({ requires: z.string(), compatible: z.boolean() }),
  methodology,
  roster: z.array(rosterEntry),
  inputsSchema: jsonSchema,
  ui: packUi,
  artifactTypes: z.array(artifactTypeDef),
  requirements: z.object({
    mcpServers: z.array(z.string()),
    secrets: z.array(z.string()),
    workItemSources: z.array(z.string()),
  }),
  permissions: z.array(permissionRequest),
  memoryScopes: z.array(z.object({ scope: memoryScopeType, access: memoryAccess })),
  tests: z.object({
    suites: z.number(),
    lastRun: z
      .object({ status: z.enum(['passed', 'failed', 'never']), at: iso.optional() })
      .optional(),
  }),
  /** Historical figures only; `avgCost` is null when no run reported cost. */
  stats: z.object({ runs: z.number(), successRate: z.number(), avgCost: spend }).optional(),
  installedAt: iso.optional(),
  links,
});
export type Pack = z.infer<typeof pack>;

// ---- Agents ----------------------------------------------------------------

export const skillRef = z.object({ id: z.string(), sha: z.string().optional() });

export const agentDefinition = z.object({
  id: z.string(),
  role: z.string(),
  variant: z.string(),
  name: z.string(),
  description: z.string(),
  backend: z.object({
    /** Backend id from the registry, e.g. `a2a-codex`. Open set: any registered backend works. */
    wrapper: z.string(),
    model: z.string().optional(),
    /** Provider-specific options, validated against that backend's descriptor. */
    options: z.record(z.string(), z.unknown()).optional(),
    /** Settings every wrapper shares (session, timeouts, logging, …). */
    common: z.record(z.string(), z.unknown()).optional(),
    /** Environment variable name → secret reference. Values are never stored here. */
    secrets: z.record(z.string(), z.string()).optional(),
  }),
  skills: z.array(skillRef),
  mcpServers: z.array(z.string()),
  permissions: z.object({ tools: z.record(z.string(), z.enum(['allow', 'ask', 'off'])) }),
  memory: z.object({
    enabled: z.boolean(),
    scopes: z.array(z.object({ scope: memoryScopeType, access: memoryAccess })),
  }),
  capabilities: z.array(z.string()),
  source: z.object({
    type: z.enum(['pack', 'local']),
    packId: id('pack').optional(),
    sha: z.string().optional(),
  }),
  costHint: z.object({ perMillionTokens: money.optional() }).optional(),
  links,
});
export type AgentDefinition = z.infer<typeof agentDefinition>;

export const agent = z.object({
  id: id('agt'),
  definitionId: z.string(),
  role: z.string(),
  variant: z.string().optional(),
  backend: z.string(),
  model: z.string().optional(),
  status: z.enum(['starting', 'idle', 'busy', 'unhealthy', 'stopped']),
  url: z.string(),
  port: z.number().optional(),
  pid: z.number().optional(),
  startedAt: iso,
  lastHealthAt: iso.optional(),
  assignment: z
    .object({ runId: id('run'), phaseId: z.string().optional(), stepId: id('step').optional() })
    .optional(),
  workspace: z.object({ mode: z.enum(['isolated', 'shared']), path: z.string() }).optional(),
  session: z.object({ contextId: z.string().optional(), resumable: z.boolean() }).optional(),
  card: z.record(z.string(), z.unknown()).optional(),
  links,
});
export type Agent = z.infer<typeof agent>;

export const agentMatchRequest = z.object({
  capabilities: z.array(z.string()),
  backend: z.string().optional(),
  maxCost: z.number().optional(),
});
export const agentMatchResult = z.object({
  candidates: z.array(
    z.object({ definition: agentDefinition, score: z.number(), reasons: z.array(z.string()) }),
  ),
});

// ---- Skills ----------------------------------------------------------------

export const skill = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  license: z.string().optional(),
  compatibility: z.string().optional(),
  allowedTools: z.array(z.string()).optional(),
  metadata: z.record(z.string(), z.string()).optional(),
  source: z.object({
    type: z.enum(['git', 'pack', 'local']),
    url: z.string().optional(),
    ref: z.string().optional(),
    sha: z.string().optional(),
    path: z.string().optional(),
  }),
  contains: z.object({ scripts: z.boolean(), references: z.boolean(), assets: z.boolean() }),
  risk: z.enum(['low', 'medium', 'high']),
  validation: z.object({
    status: z.enum(['valid', 'warnings', 'invalid']),
    issues: z.array(
      z.object({ path: z.string(), message: z.string(), severity: z.enum(['warn', 'error']) }),
    ),
  }),
  usedBy: z.object({ definitionIds: z.array(z.string()), packIds: z.array(id('pack')) }),
  links,
});
export type Skill = z.infer<typeof skill>;

// ---- Pack preview / install ------------------------------------------------

export const packPreviewRequest = z.object({
  source: z.object({ url: z.string(), ref: z.string().optional(), path: z.string().optional() }),
});
export const packPreview = z.object({
  previewId: z.string(),
  manifestDigest: z.string(),
  sha: z.string(),
  manifest: pack,
  trust,
  signatureVerified: z.boolean().optional(),
  engineCompatible: z.boolean(),
  issues: z.array(
    z.object({
      severity: z.enum(['warn', 'error']),
      message: z.string(),
      path: z.string().optional(),
    }),
  ),
  permissions: z.array(permissionRequest),
  secretsToBind: z.array(
    z.object({ ref: z.string(), description: z.string().optional(), bound: z.boolean() }),
  ),
  skills: z.array(skill),
  definitions: z.array(agentDefinition),
  diff: z
    .object({
      added: z.array(z.string()),
      removed: z.array(z.string()),
      changed: z.array(z.object({ path: z.string(), summary: z.string() })),
      permissionChanges: z.array(permissionRequest),
    })
    .optional(),
  expiresAt: iso,
});
export type PackPreview = z.infer<typeof packPreview>;

export const installPack = z.object({
  previewId: z.string(),
  manifestDigest: z.string(),
  consent: z.object({ granted: z.array(z.string()), declined: z.array(z.string()) }),
});

export type PhaseTemplate = z.infer<typeof phaseTemplate>;
export type GateRule = z.infer<typeof gateRule>;
export type EvaluatorRule = z.infer<typeof evaluatorRule>;
export type RosterEntry = z.infer<typeof rosterEntry>;
