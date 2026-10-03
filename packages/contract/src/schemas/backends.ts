import { z } from 'zod';

/**
 * A backend is one A2A wrapper (`a2a-claude`, `a2a-codex`, …). Every wrapper shares one core
 * (agent card, server, session, timeouts, logging, MCP, memory, sub-agents) and adds its own
 * provider section, auth, workspace key and prerequisites. A descriptor is the declarative record of
 * both halves, so adding a provider means adding a file, never changing the engine.
 */

export const backendOptionType = z.enum([
  'string',
  'number',
  'boolean',
  'enum',
  'string[]',
  'object',
  'any',
]);

export const backendOption = z.object({
  /** Dotted path inside the provider section, e.g. `sandboxMode` or `provider.type`. */
  key: z.string().min(1),
  type: backendOptionType,
  /** Allowed values when `type` is `enum`. */
  values: z.array(z.string()).optional(),
  description: z.string(),
  default: z.unknown().optional(),
  required: z.boolean().optional(),
  /** The wrapper also reads this environment variable as a fallback. */
  env: z.string().optional(),
  /** Turning this on widens what the agent may do; the consent screen flags it. */
  risk: z.enum(['low', 'medium', 'high']).optional(),
  /** The value is a secret: pass it as a secret reference, never in the config file. */
  secret: z.boolean().optional(),
});
export type BackendOption = z.infer<typeof backendOption>;

export const backendEnvVar = z.object({
  name: z.string().min(1),
  description: z.string(),
  required: z.boolean().default(false),
  secret: z.boolean().default(false),
  /** Variables sharing a group are alternatives (any one satisfies the group). */
  group: z.string().optional(),
});

export const osHints = z.object({
  any: z.string().optional(),
  macos: z.string().optional(),
  linux: z.string().optional(),
  windows: z.string().optional(),
});

export const backendPrerequisite = z.object({
  id: z.string(),
  description: z.string(),
  kind: z.enum(['binary', 'service', 'runtime', 'account']),
  /** How `krama doctor` checks it. A command is run without a shell; a URL is probed with GET. */
  check: z.union([
    z.object({ command: z.array(z.string()).min(1), expect: z.string().optional() }),
    z.object({ url: z.string() }),
    z.object({ manual: z.literal(true) }),
  ]),
  /** Optional prerequisites degrade gracefully instead of failing the check. */
  optional: z.boolean().optional(),
  install: osHints.optional(),
});
export type BackendPrerequisite = z.infer<typeof backendPrerequisite>;

/** Where Krama's common settings land inside the provider section (they differ per wrapper). */
export const backendMapping = z.object({
  /** Workspace directory the agent operates in. */
  workspace: z.string(),
  model: z.string().default('model'),
  /** Persona or system prompt text. */
  systemPrompt: z.string().optional(),
  /** Where the provider's tool allow/deny lists live, if it has them. */
  allowedTools: z.string().optional(),
});

export const backendCapabilities = z.object({
  /** May act as the run's orchestrator (needs MCP tool calling). */
  canOrchestrate: z.boolean(),
  /** Whether the wrapper reports cost: `unknown` until verified for that wrapper (wrapper task W2). */
  cost: z.enum(['reported', 'partial', 'not_reported', 'unknown']),
  /** Streams thought/trace/tool-call events (the sideband). */
  sideband: z.boolean(),
  /** Conversations can be resumed by `contextId`. */
  resumableSessions: z.boolean(),
});

export const backendDescriptor = z.object({
  $schema: z.string().optional(),
  /** Wrapper id; this is `AgentDefinition.backend.wrapper`. */
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  label: z.string(),
  description: z.string().optional(),
  /** The npm package that ships the wrapper and its executable. */
  package: z.object({
    name: z.string(),
    bin: z.string(),
    install: z.string(),
    docs: z.string().optional(),
    minVersion: z.string().optional(),
  }),
  launch: z.object({
    defaultPort: z.number().int().positive(),
    /** GET path that answers once the wrapper is ready. */
    readyPath: z.string().default('/.well-known/agent-card.json'),
    startupTimeoutMs: z.number().int().positive().default(60_000),
    /** Extra CLI args always passed (rare). */
    extraArgs: z.array(z.string()).default([]),
  }),
  /** Key of the provider section in the wrapper config (`claude`, `codex`, …). */
  providerKey: z.string(),
  mapping: backendMapping,
  options: z.array(backendOption),
  env: z.array(backendEnvVar),
  prerequisites: z.array(backendPrerequisite),
  capabilities: backendCapabilities,
  /** Suggested models for pickers. Any model string the wrapper accepts still works. */
  models: z.array(z.string()).default([]),
  /** Where this descriptor came from. Set by the loader, not by authors. */
  origin: z.enum(['builtin', 'user', 'pack']).optional(),
});
export type BackendDescriptor = z.infer<typeof backendDescriptor>;
export type BackendDescriptorInput = z.input<typeof backendDescriptor>;

/** Settings every wrapper shares (the wrapper's core). Authors may set these per agent alongside provider options. */
export const COMMON_CONFIG_SECTIONS = [
  'session',
  'features',
  'timeouts',
  'logging',
  'mcp',
  'memory',
  'subAgents',
  'events',
] as const;

export const backendCheckResult = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      ok: z.boolean(),
      optional: z.boolean().optional(),
      detail: z.string().optional(),
      fix: z.string().optional(),
    }),
  ),
  ok: z.boolean(),
});
