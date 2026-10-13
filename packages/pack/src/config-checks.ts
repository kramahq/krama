import { error, warning, type PackIssue } from './issues.js';

const VAR = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** A key whose value is a credential by its name. */
const SECRET_KEY =
  /(^|[_-])(token|secret|password|passwd|api[_-]?key|apikey|authorization|credential)s?$/i;

/** Strings that are credentials by their shape, wherever they sit. */
const SECRET_SHAPES: { re: RegExp; what: string }[] = [
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, what: 'a private key' },
  { re: /\bsk-[A-Za-z0-9_-]{20,}/, what: 'an API key' },
  { re: /\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}/, what: 'a GitHub token' },
  { re: /\bAKIA[0-9A-Z]{16}\b/, what: 'an AWS access key' },
  { re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/, what: 'a Slack token' },
  { re: /\bBearer\s+(?!\$\{)[A-Za-z0-9._~+/=-]{20,}/, what: 'a bearer token' },
];

type Json = unknown;
const isObject = (v: Json): v is Record<string, Json> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Every string in a config with its path; `events.httpHeaders` is skipped because the wrapper does not substitute there. */
export function* strings(value: Json, path: string): Generator<[string, string]> {
  if (typeof value === 'string') yield [path, value];
  else if (Array.isArray(value))
    for (let i = 0; i < value.length; i++) yield* strings(value[i], `${path}[${i}]`);
  else if (isObject(value))
    for (const [k, v] of Object.entries(value)) {
      if (path === 'config.events' && k === 'httpHeaders') continue;
      yield* strings(v, path ? `${path}.${k}` : k);
    }
}

/** The environment variables a config refers to with `${VAR}`. */
export function referencedVars(config: Json, base = 'config'): { name: string; path: string }[] {
  const out: { name: string; path: string }[] = [];
  for (const [path, s] of strings(config, base))
    for (const m of s.matchAll(VAR)) out.push({ name: m[1]!, path });
  return out;
}

const hasRef = (s: string): boolean => new RegExp(VAR.source).test(s);

/**
 * Credentials written into a config. A value is fine when it is (or contains) a `${VAR}` reference; a literal under a
 * key named like a credential, or anything shaped like one, is not. Values are never echoed back in the message.
 */
export function secretValues(config: Json, base: string): PackIssue[] {
  const issues: PackIssue[] = [];
  const seen = new Set<string>();
  const add = (path: string, why: string) => {
    if (seen.has(path)) return;
    seen.add(path);
    issues.push(
      error(
        'secret_in_config',
        path,
        `${why}. Write a \${VAR} reference and bind the variable under \`secrets\`; a secret never goes in a pack.`,
      ),
    );
  };
  const walk = (v: Json, path: string, key?: string): void => {
    if (typeof v === 'string') {
      if (!v || hasRef(v)) return;
      if (key && SECRET_KEY.test(key)) return add(path, `"${key}" holds a literal value`);
      for (const s of SECRET_SHAPES)
        if (s.re.test(v)) return add(path, `This value looks like ${s.what}`);
    } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`, key));
    else if (isObject(v)) for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`, k);
  };
  walk(config, base);
  return issues;
}

export interface SkillLike {
  id?: unknown;
  name?: unknown;
  description?: unknown;
}

/** The skills an agent card advertises that a caller could be given as tools. */
export function cardSkills(config: Record<string, Json>): SkillLike[] {
  const card = config['agentCard'];
  const skills = isObject(card) ? card['skills'] : undefined;
  return Array.isArray(skills) ? skills.filter(isObject) : [];
}

/** Rules about a config's own sections that do not depend on the backend. */
export function sectionIssues(config: Record<string, Json>, base: string): PackIssue[] {
  const issues: PackIssue[] = [];
  const card = config['agentCard'];
  if (!isObject(card))
    issues.push(
      error(
        'missing_agent_card',
        `${base}.agentCard`,
        'The config needs an agentCard with a name and a description',
      ),
    );
  else
    for (const f of ['name', 'description'])
      if (typeof card[f] !== 'string' || !String(card[f]).trim())
        issues.push(
          error('missing_agent_card', `${base}.agentCard.${f}`, `The agent card needs a ${f}`),
        );
  const mcp = config['mcp'];
  if (isObject(mcp) && 'a2a-subagents' in mcp)
    issues.push(
      error(
        'reserved_mcp_key',
        `${base}.mcp.a2a-subagents`,
        'This key is reserved for the sub-agent bridge; the wrapper rejects it. Krama writes the bridge itself.',
      ),
    );
  const events = config['events'];
  if (isObject(events) && Object.keys(events).length > 0)
    issues.push(
      warning(
        'events_overridden',
        `${base}.events`,
        "Krama sets this agent's event reporting itself; this section is ignored.",
      ),
    );
  if ('subAgents' in config)
    issues.push(
      warning(
        'sub_agents_replaced',
        `${base}.subAgents`,
        "The pack's own `subAgents` list decides who this agent can call; the ones written in its config are replaced.",
      ),
    );
  return issues;
}
