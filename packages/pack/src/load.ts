import { readFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { BackendDescriptor } from '@kramahq/contract';
import { canonicalJson, sha256Hex, validateAgentGraph, type BackendCatalog } from '@kramahq/engine';
import { parse as parseYaml } from 'yaml';
import { cardSkills, referencedVars, secretValues, sectionIssues } from './config-checks.js';
import { formatGitSource, parseGitSource, type GitSource } from './git-source.js';
import { error, hasErrors, warning, type PackIssue } from './issues.js';
import { parsePackText, type AgentEntry, type PackFile } from './pack-file.js';

/** The name of the pack file inside a pack directory. */
export const PACK_FILE = 'krama-pack.yaml';
/** Variables Krama itself provides to an agent's process, so a config may refer to them unbound. */
export const KRAMA_VARS: readonly string[] = ['KRAMA_MCP_TOKEN', 'WORKSPACE_DIR'];

export interface PackLoadEnv {
  /** Registered backends: a config is matched to one by its provider key. */
  backends: BackendCatalog;
  /** The backends policy allows; empty or absent means all of them. */
  allowedBackends?: readonly string[] | undefined;
  /**
   * Checks the provider section of a config against what the wrapper accepts (unknown keys, types, values). Supplied by
   * the host, which owns that knowledge; without it the section is not checked.
   */
  checkProviderConfig?:
    | ((
        descriptor: BackendDescriptor,
        section: Record<string, unknown>,
      ) => { path: string; message: string }[])
    | undefined;
  /**
   * Fetches a git source and says where its agent directory is. Without it git agents are reported as unresolved (a
   * warning) and their configs are not checked.
   */
  resolveGit?:
    ((source: GitSource) => Promise<{ dir: string; sha: string } | undefined>) | undefined;
  /** More variables that need no `secrets` binding. */
  providedVars?: readonly string[] | undefined;
}

export interface ResolvedAgent {
  id: string;
  kind: 'config' | 'git' | 'external';
  role: string;
  description?: string;
  /** The wrapper config, as JSON would carry it. Absent for an external agent and an unresolved git agent. */
  config?: Record<string, unknown>;
  /** The registered backend the config belongs to. */
  backend?: string;
  /** The directory relative paths in the config resolve against. */
  dir?: string;
  /** The commit a git agent was resolved to. */
  sha?: string;
  git?: GitSource;
  secrets: Record<string, string>;
  subAgents: { agent: string; hint?: string | undefined }[];
}

export interface PackLoad {
  /** No errors (warnings are allowed). */
  ok: boolean;
  issues: PackIssue[];
  file?: PackFile;
  agents: Record<string, ResolvedAgent>;
  /** Over the pack file and every resolved config, so the same pack always has the same digest. */
  digest?: string;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const exists = async (p: string, dir = false): Promise<boolean> => {
  try {
    const s = await stat(p);
    return dir ? s.isDirectory() : s.isFile();
  } catch {
    return false;
  }
};

/** A pack from its directory: `krama-pack.yaml` and the files it points at. */
export async function loadPackDir(dir: string, env: PackLoadEnv): Promise<PackLoad> {
  const file = join(dir, PACK_FILE);
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return {
      ok: false,
      agents: {},
      issues: [error('missing_pack_file', PACK_FILE, `There is no ${PACK_FILE} in ${dir}`)],
    };
  }
  return loadPackText(text, resolve(dir), env);
}

/** A pack from its text. Without a base directory a pack cannot point at files, only carry its text inline. */
export async function loadPackText(
  text: string,
  baseDir: string | undefined,
  env: PackLoadEnv,
): Promise<PackLoad> {
  const parsed = parsePackText(text);
  if (!parsed.file) return { ok: false, issues: parsed.issues, agents: {} };
  const file = parsed.file;
  const issues: PackIssue[] = [];
  const agents: Record<string, ResolvedAgent> = {};

  // 1. One source each, then the graph.
  for (const [id, a] of Object.entries(file.agents)) {
    const sources = (['git', 'config', 'external'] as const).filter((k) => a[k] !== undefined);
    if (sources.length !== 1)
      issues.push(
        error(
          'agent_source',
          `agents.${id}`,
          sources.length === 0
            ? 'An agent needs a source: git, config or external'
            : `An agent has exactly one source, not ${sources.join(' and ')}`,
        ),
      );
    if (a.external && a.role)
      issues.push(
        warning(
          'role_ignored',
          `agents.${id}.role`,
          'An external agent has no role label of its own',
        ),
      );
  }
  for (const g of validateAgentGraph({
    orchestrator: file.orchestrator,
    agents: Object.fromEntries(
      Object.entries(file.agents).map(([id, a]) => [
        id,
        { external: a.external !== undefined, subAgents: a.subAgents },
      ]),
    ),
  }))
    issues.push(error('graph', g.path, g.message));

  const referenced = new Set(
    Object.values(file.agents).flatMap((a) => (a.subAgents ?? []).map((r) => r.agent)),
  );
  const providedVars = new Set([...KRAMA_VARS, ...(env.providedVars ?? [])]);

  for (const [id, a] of Object.entries(file.agents)) {
    const resolved = await resolveAgent(id, a, baseDir, env, issues);
    agents[id] = resolved;
    if (a.external) {
      checkExternal(id, a, issues);
    } else if (resolved.config) {
      await checkConfig(
        id,
        resolved,
        { isOrchestrator: id === file.orchestrator, referenced: referenced.has(id) },
        env,
        providedVars,
        issues,
      );
    }
    (a.subAgents ?? []).forEach((r, i) => {
      // eslint-disable-next-line no-control-regex
      if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(r.hint ?? ''))
        issues.push(
          error('hint_not_text', `agents.${id}.subAgents[${i}].hint`, 'A hint is plain text'),
        );
    });
  }

  // 2. Warnings that are not about one agent.
  const reachable = reach(file);
  for (const id of Object.keys(file.agents))
    if (!reachable.has(id))
      issues.push(
        warning(
          'unreachable_agent',
          `agents.${id}`,
          `"${id}" is not reachable from the orchestrator, so it is never started`,
        ),
      );
  if (file.delegation && !file.delegation.includes('native'))
    issues.push(
      warning(
        'needs_native',
        'delegation',
        'A pack with an agent graph is meant for native delegation',
      ),
    );

  const ok = !hasErrors(issues);
  return {
    ok,
    issues,
    file,
    agents,
    ...(ok
      ? {
          digest: sha256Hex(
            canonicalJson({
              file,
              configs: Object.fromEntries(
                Object.entries(agents).map(([id, a]) => [
                  id,
                  { config: a.config ?? null, sha: a.sha ?? null },
                ]),
              ),
            }),
          ),
        }
      : {}),
  };
}

function reach(file: PackFile): Set<string> {
  const seen = new Set<string>();
  const visit = (id: string): void => {
    if (seen.has(id) || !(id in file.agents)) return;
    seen.add(id);
    for (const r of file.agents[id]!.subAgents ?? []) visit(r.agent);
  };
  visit(file.orchestrator);
  return seen;
}

async function resolveAgent(
  id: string,
  a: AgentEntry,
  baseDir: string | undefined,
  env: PackLoadEnv,
  issues: PackIssue[],
): Promise<ResolvedAgent> {
  const base: ResolvedAgent = {
    id,
    kind: a.external ? 'external' : a.git !== undefined ? 'git' : 'config',
    role: a.role ?? id,
    ...(a.description ? { description: a.description } : {}),
    secrets: a.secrets ?? {},
    subAgents: (a.subAgents ?? []).map((r) => ({ agent: r.agent, hint: r.hint })),
  };
  if (a.config)
    return { ...base, config: structuredClone(a.config), ...(baseDir ? { dir: baseDir } : {}) };
  if (a.git === undefined) return base;

  const src = parseGitSource(a.git);
  if ('error' in src) {
    issues.push(error('bad_git_source', `agents.${id}.git`, src.error));
    return base;
  }
  const withGit = { ...base, git: src };
  if (!env.resolveGit) {
    issues.push(
      warning(
        'git_source_unresolved',
        `agents.${id}.git`,
        `${formatGitSource(src)} was not fetched, so this agent's config was not checked`,
      ),
    );
    return withGit;
  }
  let got: { dir: string; sha: string } | undefined;
  try {
    got = await env.resolveGit(src);
  } catch (e) {
    issues.push(
      error(
        'git_source_failed',
        `agents.${id}.git`,
        `Could not fetch ${formatGitSource(src)}: ${(e as Error).message}`,
      ),
    );
    return withGit;
  }
  if (!got) {
    issues.push(
      error('git_source_missing', `agents.${id}.git`, `${formatGitSource(src)} was not found`),
    );
    return withGit;
  }
  // The path may name the agent directory or its config.json.
  const configFile = got.dir.endsWith('.json') ? got.dir : join(got.dir, 'config.json');
  const dir = got.dir.endsWith('.json') ? dirname(got.dir) : got.dir;
  let config: unknown;
  try {
    config = JSON.parse(await readFile(configFile, 'utf8'));
  } catch (e) {
    issues.push(
      error(
        'agent_config_unreadable',
        `agents.${id}.git`,
        `${formatGitSource(src)} has no readable config.json (${(e as Error).message.split('\n')[0]})`,
      ),
    );
    return { ...withGit, dir, sha: got.sha };
  }
  if (!isObject(config)) {
    issues.push(
      error('agent_config_unreadable', `agents.${id}.git`, 'config.json is not a JSON object'),
    );
    return { ...withGit, dir, sha: got.sha };
  }
  return { ...withGit, config, dir, sha: got.sha };
}

function checkExternal(id: string, a: AgentEntry, issues: PackIssue[]): void {
  const ext = a.external!;
  if (!/^[A-Za-z0-9_-]+$/.test(ext.name))
    issues.push(
      error(
        'bad_external_name',
        `agents.${id}.external.name`,
        'Use letters, digits, hyphens and underscores',
      ),
    );
  try {
    const u = new URL(ext.agentCardUrl);
    if (!/^https?:$/.test(u.protocol)) throw new Error('not http');
  } catch {
    issues.push(
      error(
        'bad_external_url',
        `agents.${id}.external.agentCardUrl`,
        'The agent card address must be an http or https URL',
      ),
    );
  }
  if (!a.description)
    issues.push(
      error(
        'external_needs_description',
        `agents.${id}.description`,
        "Krama does not fetch an external agent's card, so the pack must describe it",
      ),
    );
  const auth = ext.auth;
  if (auth && auth.mode !== 'none') {
    const token = auth.token;
    const m = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(token);
    if (!m)
      issues.push(
        error(
          'secret_in_config',
          `agents.${id}.external.auth.token`,
          'The token must be a ${VAR} reference, never the token itself',
        ),
      );
    else if (!(m[1]! in (a.secrets ?? {})))
      issues.push(
        error(
          'unbound_variable',
          `agents.${id}.external.auth.token`,
          `\${${m[1]}} is not bound: add ${m[1]} under this agent's \`secrets\`, or the call goes out without authentication`,
        ),
      );
  }
}

interface Role {
  isOrchestrator: boolean;
  referenced: boolean;
}

async function checkConfig(
  id: string,
  agent: ResolvedAgent,
  role: Role,
  env: PackLoadEnv,
  providedVars: ReadonlySet<string>,
  issues: PackIssue[],
): Promise<void> {
  const config = agent.config!;
  const base = agent.kind === 'git' ? `agents.${id}.git(config)` : `agents.${id}.config`;
  issues.push(...sectionIssues(config, base));
  issues.push(...secretValues(config, base));

  // Which backend this config is for.
  const matches = env.backends.list().filter((b) => b.providerKey in config);
  let descriptor: BackendDescriptor | undefined;
  if (matches.length === 0)
    issues.push(
      error(
        'backend_unknown',
        base,
        'No registered backend has its provider key in this config (claude, codex, copilot, opencode, antigravity, ...)',
      ),
    );
  else if (matches.length > 1)
    issues.push(
      error(
        'backend_ambiguous',
        base,
        `More than one backend matches (${matches.map((b) => b.id).join(', ')}); a config is for one`,
      ),
    );
  else descriptor = matches[0];
  if (descriptor) {
    agent.backend = descriptor.id;
    const allowed = env.allowedBackends ?? [];
    if (allowed.length > 0 && !allowed.includes(descriptor.id))
      issues.push(error('backend_not_allowed', base, `${descriptor.id} is not an allowed backend`));
    if (role.isOrchestrator && !descriptor.capabilities.canOrchestrate)
      issues.push(
        error('cannot_orchestrate', `agents.${id}`, `${descriptor.id} cannot be an orchestrator`),
      );
    const section = config[descriptor.providerKey];
    if (env.checkProviderConfig && isObject(section))
      for (const p of env.checkProviderConfig(descriptor, section))
        issues.push(
          error(
            'provider_config',
            `${base}.${descriptor.providerKey}${p.path ? `.${p.path}` : ''}`,
            p.message,
          ),
        );
    if (descriptor.capabilities.cost === 'not_reported')
      issues.push(
        warning(
          'cost_not_reported',
          `agents.${id}`,
          `${descriptor.id} does not report cost, so its spend shows as "not reported"`,
        ),
      );
    if (descriptor.id === 'a2a-opencode' && isObject(section))
      for (const k of ['autoApprovePermissions', 'autoAnswerQuestions'])
        if (section[k] === true)
          issues.push(
            warning(
              'bypasses_people',
              `${base}.opencode.${k}`,
              'This lets the agent skip a human decision',
            ),
          );
  }

  // Every ${VAR} is bound, or Krama's own, or a variable the backend takes from the environment.
  const fromBackend = new Set(descriptor?.env.map((e) => e.name) ?? []);
  const seen = new Set<string>();
  for (const v of referencedVars(config, base))
    if (
      !seen.has(v.name) &&
      !providedVars.has(v.name) &&
      !fromBackend.has(v.name) &&
      !(v.name in agent.secrets)
    ) {
      seen.add(v.name);
      issues.push(
        error(
          'unbound_variable',
          v.path,
          `\${${v.name}} is not bound: add ${v.name} under \`secrets\` for this agent`,
        ),
      );
    }

  // A caller gets one tool per skill the card advertises.
  if (role.referenced) {
    const skills = cardSkills(config);
    if (skills.length === 0)
      issues.push(
        error(
          'no_skills',
          `${base}.agentCard.skills`,
          `"${id}" is called by another agent, so its agent card must advertise at least one skill (the caller gets one tool per skill)`,
        ),
      );
    skills.forEach((s, i) => {
      for (const f of ['id', 'name', 'description'] as const)
        if (typeof s[f] !== 'string' || !(s[f] as string).trim())
          issues.push(
            error('bad_skill', `${base}.agentCard.skills[${i}].${f}`, `A skill needs an ${f}`),
          );
    });
  }

  await checkFiles(base, agent, config, issues);
}

/** `memory.instructions` and each `memory.skills[]` must exist; a skill directory holds a valid SKILL.md. */
async function checkFiles(
  base: string,
  agent: ResolvedAgent,
  config: Record<string, unknown>,
  issues: PackIssue[],
): Promise<void> {
  const memory = config['memory'];
  if (!isObject(memory)) return;
  const at = (rel: string) =>
    isAbsolute(rel) ? rel : agent.dir ? resolve(agent.dir, rel) : undefined;
  const noDir = (path: string, rel: string) =>
    issues.push(
      error(
        'files_need_directory',
        path,
        `"${rel}" points at a file, but this pack was given as text with no directory. Put the text inline in the config, or load the pack from a directory that holds the file.`,
      ),
    );

  const instructions = memory['instructions'];
  if (typeof instructions === 'string') {
    const p = at(instructions);
    if (!p) noDir(`${base}.memory.instructions`, instructions);
    else if (!(await exists(p)))
      issues.push(
        error(
          'file_missing',
          `${base}.memory.instructions`,
          `${instructions} does not exist (looked in ${agent.dir ?? 'the pack directory'})`,
        ),
      );
  }
  const skills = memory['skills'];
  if (Array.isArray(skills))
    for (let i = 0; i < skills.length; i++) {
      const rel = skills[i];
      const path = `${base}.memory.skills[${i}]`;
      if (typeof rel !== 'string') continue;
      const p = at(rel);
      if (!p) {
        noDir(path, rel);
        continue;
      }
      if (!(await exists(p, true))) {
        issues.push(error('file_missing', path, `${rel} is not a directory`));
        continue;
      }
      const why = await skillProblem(join(p, 'SKILL.md'));
      if (why) issues.push(error('invalid_skill', path, `${rel}: ${why}`));
    }
}

/** A skill is a directory with a `SKILL.md` whose frontmatter has a `name` and a `description` (Agent Skills format). */
async function skillProblem(file: string): Promise<string | undefined> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return 'it has no SKILL.md';
  }
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return 'SKILL.md has no frontmatter';
  let fm: unknown;
  try {
    fm = parseYaml(m[1]!);
  } catch {
    return 'the frontmatter of SKILL.md is not valid YAML';
  }
  if (!isObject(fm) || typeof fm['name'] !== 'string' || typeof fm['description'] !== 'string')
    return 'the frontmatter of SKILL.md needs a name and a description';
  return undefined;
}
