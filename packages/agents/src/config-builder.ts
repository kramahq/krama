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
  OptionIssue['code'] | 'unknown_common' | 'missing_env' | 'unresolved_secret';
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

/**
 * Turns an agent definition plus runtime facts into a launch plan for one backend: the command and
 * arguments, the config file contents, and the environment. This is where Krama's common settings are
 * translated into each wrapper's own keys (system prompt, workspace, model, tool lists).
 */
export function buildLaunch(
  descriptor: BackendDescriptor,
  def: DefinitionBackend,
  rt: RuntimeContext,
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

  // Environment: only declared variables, from bound secrets first, then the ambient environment.
  const env: Record<string, string> = {};
  const satisfied = new Set<string>();
  for (const v of descriptor.env) {
    const ref = def.secrets?.[v.name];
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

  const args = [
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
  return {
    command: descriptor.package.bin,
    args,
    env,
    config,
    problems,
    ok: problems.length === 0,
  };
}
