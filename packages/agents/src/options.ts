import type { BackendDescriptor, BackendOption } from '@kramahq/contract';

export interface OptionIssue {
  path: string;
  code: 'unknown_option' | 'wrong_type' | 'bad_value' | 'missing_required' | 'secret_in_config';
  message: string;
}

const ENV_REF = /^\$\{[A-Z_][A-Z0-9_]*\}$/;

const typeOk = (o: BackendOption, v: unknown): boolean => {
  switch (o.type) {
    case 'string':
      return typeof v === 'string';
    case 'number':
      return typeof v === 'number' && Number.isFinite(v);
    case 'boolean':
      return typeof v === 'boolean';
    case 'enum':
      return typeof v === 'string';
    case 'string[]':
      return Array.isArray(v) && v.every((x) => typeof x === 'string');
    case 'object':
      return typeof v === 'object' && v !== null && !Array.isArray(v);
    default:
      return true;
  }
};

/** Flattens `{ provider: { type: 'x' } }` into `provider.type` paths, stopping at declared option keys. */
function flatten(
  value: Record<string, unknown>,
  declared: Set<string>,
  prefix = '',
): [string, unknown][] {
  const out: [string, unknown][] = [];
  for (const [k, v] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (
      !declared.has(path) &&
      v &&
      typeof v === 'object' &&
      !Array.isArray(v) &&
      [...declared].some((d) => d.startsWith(`${path}.`))
    )
      out.push(...flatten(v as Record<string, unknown>, declared, path));
    else out.push([path, v]);
  }
  return out;
}

/**
 * Checks provider-specific options against the backend descriptor: unknown keys, types, enum values,
 * required keys, and secrets that must not be written into a config file.
 */
export function validateOptions(
  descriptor: BackendDescriptor,
  options: Record<string, unknown> = {},
  opts: { workspaceProvided?: boolean } = {},
): OptionIssue[] {
  const byKey = new Map(descriptor.options.map((o) => [o.key, o]));
  const declared = new Set(byKey.keys());
  const issues: OptionIssue[] = [];
  const seen = new Set<string>();
  for (const [path, value] of flatten(options, declared)) {
    seen.add(path);
    const opt = byKey.get(path);
    if (!opt) {
      issues.push({
        path,
        code: 'unknown_option',
        message: `"${path}" is not an option of ${descriptor.id}. Known: ${[...declared].slice(0, 8).join(', ')}${declared.size > 8 ? ', …' : ''}`,
      });
      continue;
    }
    if (!typeOk(opt, value)) {
      issues.push({ path, code: 'wrong_type', message: `"${path}" must be ${opt.type}` });
      continue;
    }
    if (opt.type === 'enum' && opt.values?.length && !opt.values.includes(value as string)) {
      issues.push({
        path,
        code: 'bad_value',
        message: `"${path}" must be one of: ${opt.values.join(', ')}`,
      });
    }
    if (opt.secret && typeof value === 'string' && !ENV_REF.test(value)) {
      issues.push({
        path,
        code: 'secret_in_config',
        message: `"${path}" is a secret; bind it with backend.secrets instead of writing it here`,
      });
    }
  }
  for (const o of descriptor.options) {
    // The workspace key is filled by the engine, so it is never "missing".
    if (
      o.required &&
      !seen.has(o.key) &&
      o.key !== descriptor.mapping.workspace &&
      !opts.workspaceProvided
    ) {
      issues.push({ path: o.key, code: 'missing_required', message: `"${o.key}" is required` });
    }
  }
  return issues;
}
