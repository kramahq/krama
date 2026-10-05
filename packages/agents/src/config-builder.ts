import { COMMON_CONFIG_SECTIONS, type BackendDescriptor } from '@kramahq/contract';
import { validateOptions, type OptionIssue } from './options.js';

export interface DefinitionBackend {
  model?: string | undefined;
  options?: Record<string, unknown> | undefined;
  common?: Record<string, unknown> | undefined;
  /** Environment variable name → secret reference. */
  secrets?: Record<string, string> | undefined;
}

export interface RuntimeContext {
  /** Port allocated by the port pool. */
  port: number;
  /** Absolute path of the agent's workspace. */
  workspace: string;
  /** Path where the caller will write the config file (passed as `--config`). */
  configPath: string;
  agentName: string;
  agentDescription: string;
  systemPrompt?: string;
  allowedTools?: string[];
  /** MCP servers for the agent, in the wrapper's `mcp` format. */
  mcp?: Record<string, unknown>;
  /** Resolved values for secret references, keyed by secret reference name. */
  secretValues?: Record<string, string>;
  /** Ambient environment, used to satisfy env requirements without a binding. */
  ambientEnv?: Record<string, string | undefined>;
  /** Bind address; loopback by default. */
  hostname?: string;
}

export type BuildProblemCode =
  | OptionIssue['code']
  | 'unknown_common'
  | 'missing_env'
  | 'unresolved_secret'
  | 'no_provider_section';
export interface BuildProblem {
  path: string;
  code: BuildProblemCode;
  message: string;
}

export interface BuiltLaunch {
  command: string;
  args: string[];
  /** Environment for the child process: only the variables the backend declares, never the parent's secrets wholesale. */
  env: Record<string, string>;
  /** The wrapper config to write to `configPath` (contains no secret values). */
  config: Record<string, unknown>;
  problems: BuildProblem[];
  ok: boolean;
}

const setPath = (target: Record<string, unknown>, dotted: string, value: unknown) => {
  const parts = dotted.split('.');
  let cur = target;
  for (const p of parts.slice(0, -1)) cur = (cur[p] ??= {}) as Record<string, unknown>;
  cur[parts.at(-1)!] = value;
};

const getPath = (source: Record<string, unknown>, dotted: string): unknown =>
  dotted
    .split('.')
    .reduce<unknown>(
      (cur, k) =>
        cur && typeof cur === 'object' ? (cur as Record<string, unknown>)[k] : undefined,
      source,
    );

const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Overlays `over` on `base` without touching either: objects merge key by key, anything else (arrays included)
 * is replaced. This is how Krama sets live sub-agents and event sinks on top of an agent's own config.
 */
export function deepMerge(
  base: Record<string, unknown>,
  over: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = structuredClone(base);
  for (const [k, v] of Object.entries(over)) {
    const cur = out[k];
    out[k] = isPlain(cur) && isPlain(v) ? deepMerge(cur, v) : structuredClone(v);
  }
  return out;
}

/** Environment for the child: only the variables the backend declares, from bound secrets first, then the ambient environment. */
function launchEnv(
  descriptor: BackendDescriptor,
  secrets: Record<string, string> | undefined,
  rt: RuntimeContext,
  problems: BuildProblem[],
): Record<string, string> {
  const env: Record<string, string> = {};
  const satisfied = new Set<string>();
  for (const v of descriptor.env) {
    const ref = secrets?.[v.name];
    let value: string | undefined;
    if (ref !== undefined) {
      value = rt.secretValues?.[ref];
      if (value === undefined)
        problems.push({
          path: `secrets.${v.name}`,
          code: 'unresolved_secret',
          message: `Secret "${ref}" for ${v.name} could not be resolved`,
        });
    } else {
      value = rt.ambientEnv?.[v.name];
    }
    if (value !== undefined && value !== '') {
      env[v.name] = value;
      satisfied.add(v.group ?? v.name);
    }
  }
  const groupsSeen = new Set<string>();
  for (const v of descriptor.env) {
    const key = v.group ?? v.name;
    if (satisfied.has(key) || groupsSeen.has(key)) continue;
    const members = descriptor.env.filter((x) => (x.group ?? x.name) === key);
    const needed = v.group ? members.some((x) => x.required) || false : v.required;
    if (needed) {
      groupsSeen.add(key);
      problems.push({
        path: `env.${v.name}`,
        code: 'missing_env',
        message: `${members.map((x) => x.name).join(' or ')} is required by ${descriptor.id}`,
      });
    }
  }
  return env;
}

function launchArgs(descriptor: BackendDescriptor, rt: RuntimeContext, host: string): string[] {
  return [
    '--config',
    rt.configPath,
    '--port',
    String(rt.port),
    '--hostname',
    host,
    '--advertise-host',
    host === '0.0.0.0' ? 'localhost' : host,
    ...descriptor.launch.extraArgs,
  ];
}

/**
 * Turns an agent definition plus runtime facts into a launch plan for one backend: the command and
 * arguments, the config file contents, and the environment. This is where Krama's common settings are
 * translated into each wrapper's own keys (system prompt, workspace, model, tool lists).
 */
export function buildLaunch(
  descriptor: BackendDescriptor,
  def: DefinitionBackend,
  rt: RuntimeContext,
  overrides?: Record<string, unknown>,
): BuiltLaunch {
  const problems: BuildProblem[] = validateOptions(descriptor, def.options, {
    workspaceProvided: true,
  }).map((i) => ({ path: i.path, code: i.code, message: i.message }));
  const host = rt.hostname ?? '127.0.0.1';

  const config: Record<string, unknown> = {
    agentCard: { name: rt.agentName, description: rt.agentDescription },
    server: {
      port: rt.port,
      hostname: host,
      advertiseHost: host === '0.0.0.0' ? 'localhost' : host,
    },
  };

  const common = def.common ?? {};
  for (const [k, v] of Object.entries(common)) {
    if (!(COMMON_CONFIG_SECTIONS as readonly string[]).includes(k)) {
      problems.push({
        path: `common.${k}`,
        code: 'unknown_common',
        message: `"${k}" is not a shared setting. Shared: ${COMMON_CONFIG_SECTIONS.join(', ')}. Put provider-specific settings in options.`,
      });
      continue;
    }
    config[k] = v;
  }
  if (rt.mcp && Object.keys(rt.mcp).length > 0)
    config.mcp = { ...((config.mcp as Record<string, unknown> | undefined) ?? {}), ...rt.mcp };

  const section: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(def.options ?? {})) section[k] = v;
  const m = descriptor.mapping;
  setPath(section, m.workspace, rt.workspace);
  if (def.model) setPath(section, m.model, def.model);
  if (rt.systemPrompt && m.systemPrompt) setPath(section, m.systemPrompt, rt.systemPrompt);
  if (rt.allowedTools?.length && m.allowedTools) setPath(section, m.allowedTools, rt.allowedTools);
  config[descriptor.providerKey] = section;

  const env = launchEnv(descriptor, def.secrets, rt, problems);
  const final = overrides ? deepMerge(config, overrides) : config;
  return {
    command: descriptor.package.bin,
    args: launchArgs(descriptor, rt, host),
    env,
    config: final,
    problems,
    ok: problems.length === 0,
  };
}

/**
 * Launch plan for an agent that already has its own wrapper config (PACK-FORMAT section 3). The config is kept as it is;
 * Krama overlays only what belongs to this run: the port, the workspace, the prompt hints, its MCP servers and `overrides`
 * (live sub-agents, events). The provider key in the config decides which backend it is.
 */
export function deriveLaunch(
  descriptor: BackendDescriptor,
  base: Record<string, unknown>,
  def: { secrets?: Record<string, string> | undefined },
  rt: RuntimeContext,
  overrides?: Record<string, unknown>,
): BuiltLaunch {
  const problems: BuildProblem[] = [];
  const key = descriptor.providerKey;
  const own = base[key];
  if (!isPlain(own)) {
    problems.push({
      path: key,
      code: 'no_provider_section',
      message: `The config has no "${key}" section, which ${descriptor.id} needs`,
    });
  } else {
    problems.push(
      ...validateOptions(descriptor, own, { workspaceProvided: true }).map((i) => ({
        path: `${key}.${i.path}`,
        code: i.code,
        message: i.message,
      })),
    );
  }
  const host = rt.hostname ?? '127.0.0.1';
  let config = deepMerge(base, {
    server: {
      port: rt.port,
      hostname: host,
      advertiseHost: host === '0.0.0.0' ? 'localhost' : host,
    },
  });
  if (!isPlain(config.agentCard))
    config.agentCard = { name: rt.agentName, description: rt.agentDescription };
  if (rt.mcp && Object.keys(rt.mcp).length > 0) config = deepMerge(config, { mcp: rt.mcp });

  const section: Record<string, unknown> = isPlain(config[key]) ? config[key] : {};
  const m = descriptor.mapping;
  setPath(section, m.workspace, rt.workspace);
  if (rt.systemPrompt && m.systemPrompt) {
    const existing = getPath(section, m.systemPrompt);
    setPath(
      section,
      m.systemPrompt,
      typeof existing === 'string' && existing.trim() !== ''
        ? `${existing}\n\n${rt.systemPrompt}`
        : rt.systemPrompt,
    );
  }
  config[key] = section;
  if (overrides) config = deepMerge(config, overrides);

  const env = launchEnv(descriptor, def.secrets, rt, problems);
  return {
    command: descriptor.package.bin,
    args: launchArgs(descriptor, rt, host),
    env,
    config,
    problems,
    ok: problems.length === 0,
  };
}
