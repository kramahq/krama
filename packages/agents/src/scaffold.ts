import type { BackendOption } from '@kramahq/contract';

type Json = Record<string, unknown>;

const firstSentence = (s: unknown): string =>
  String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(/(?<=[.!?])\s/)[0] ?? '';

/** Resolves `$ref` and flattens `allOf` for the small subset of JSON Schema the wrappers use. */
function resolve(node: Json, defs: Record<string, Json>): Json {
  let cur = node;
  for (let i = 0; i < 8 && typeof cur.$ref === 'string'; i++)
    cur = defs[(cur.$ref as string).split('/').pop()!] ?? {};
  return cur;
}

function typeOf(node: Json): Pick<BackendOption, 'type' | 'values'> {
  const alts = ((node.anyOf ?? node.oneOf) as Json[] | undefined) ?? [];
  const enums = [
    ...((node.enum as unknown[] | undefined) ?? []),
    ...alts.flatMap(
      (a) => (a.enum as unknown[] | undefined) ?? (a.const !== undefined ? [a.const] : []),
    ),
  ].filter((v): v is string => typeof v === 'string');
  if (enums.length > 0 && (node.type === 'string' || node.type === undefined || alts.length > 0))
    return { type: 'enum', values: [...new Set(enums)] };
  switch (node.type) {
    case 'string':
      return { type: 'string' };
    case 'number':
    case 'integer':
      return { type: 'number' };
    case 'boolean':
      return { type: 'boolean' };
    case 'array':
      return (node.items as Json | undefined)?.type === 'string'
        ? { type: 'string[]' }
        : { type: 'any' };
    case 'object':
      return { type: 'object' };
    default:
      return { type: 'any' };
  }
}

/** Keys whose values widen the agent's powers; flagged so consent screens can warn. */
const RISKY =
  /^(dangerously|bypass|networkAccess|sandboxMode|approvalPolicy|permissionMode|autoApprove|githubToken)/i;
const SECRET = /(token|apikey|secret|password)/i;

/**
 * Reads the provider section of a wrapper's `agent-config.schema.json` and returns descriptor options.
 * This is how a new provider's option list is scaffolded and how it is kept in sync with wrapper releases.
 */
export function extractOptions(schema: Json, providerKey: string): BackendOption[] {
  const defs = ((schema.definitions ?? schema.$defs) as Record<string, Json> | undefined) ?? {};
  const root = resolve(schema, defs);
  const section = resolve(
    ((root.properties as Record<string, Json> | undefined) ?? {})[providerKey] ?? {},
    defs,
  );
  const props = (section.properties as Record<string, Json> | undefined) ?? {};
  const required = new Set((section.required as string[] | undefined) ?? []);
  const out: BackendOption[] = [];
  for (const [key, raw] of Object.entries(props)) {
    const node = resolve(raw, defs);
    const opt: BackendOption = {
      key,
      ...typeOf(node),
      description: firstSentence(raw.description ?? node.description) || key,
    };
    if (node.default !== undefined) opt.default = node.default;
    if (required.has(key)) opt.required = true;
    if (RISKY.test(key)) opt.risk = 'high';
    if (SECRET.test(key)) opt.secret = true;
    out.push(opt);
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}
