import { ApiProblem } from './problems.js';

// ---- Pagination ------------------------------------------------------------

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

export interface PageQuery {
  limit?: number | undefined;
  cursor?: string | undefined;
}

export interface Paged<T> {
  items: T[];
  nextCursor?: string;
  total?: number;
}

/** Cursors are opaque to clients: a position in a stable ordering. */
const encodeCursor = (offset: number) => Buffer.from(`o:${offset}`).toString('base64url');
export function decodeCursor(cursor: string | undefined): number {
  if (cursor === undefined || cursor === '') return 0;
  const m = /^o:(\d+)$/.exec(Buffer.from(cursor, 'base64url').toString('utf8'));
  if (!m)
    throw new ApiProblem('validation_failed', 'The cursor is not valid', {
      errors: [{ field: 'cursor', message: 'unknown cursor' }],
    });
  return Number(m[1]);
}

export const clampLimit = (limit: number | undefined): number =>
  Math.min(Math.max(limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);

/** Pages an already-ordered list. Adapters that page in the database use `encodePageCursor` themselves. */
export function paginate<T>(items: readonly T[], q: PageQuery): Paged<T> {
  const limit = clampLimit(q.limit);
  const start = decodeCursor(q.cursor);
  const slice = items.slice(start, start + limit);
  const next = start + limit;
  return {
    items: slice,
    ...(next < items.length ? { nextCursor: encodeCursor(next) } : {}),
    total: items.length,
  };
}
export const encodePageCursor = encodeCursor;

// ---- Filters, sorting, expansion, field selection --------------------------

/** `status=running,paused` -> `['running','paused']`; absent -> `undefined`. */
export const csvParam = (v: string | undefined): string[] | undefined => {
  if (v === undefined) return undefined;
  const parts = v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length ? parts : undefined;
};

export interface SortKey {
  field: string;
  desc: boolean;
}

/** `sort=-createdAt,title`, restricted to the fields a collection can order by. */
export function parseSort(
  v: string | undefined,
  allowed: readonly string[],
  fallback: SortKey,
): SortKey[] {
  const parts = csvParam(v);
  if (!parts) return [fallback];
  return parts.map((p) => {
    const desc = p.startsWith('-');
    const field = desc ? p.slice(1) : p;
    if (!allowed.includes(field))
      throw new ApiProblem('validation_failed', `Cannot sort by ${field}`, {
        errors: [{ field: 'sort', message: `allowed: ${allowed.join(', ')}` }],
      });
    return { field, desc };
  });
}

export function sortBy<T>(items: readonly T[], keys: readonly SortKey[]): T[] {
  return [...items].sort((a, b) => {
    for (const { field, desc } of keys) {
      const x = (a as Record<string, unknown>)[field] as string | number | undefined;
      const y = (b as Record<string, unknown>)[field] as string | number | undefined;
      if (x === y) continue;
      if (x === undefined) return 1;
      if (y === undefined) return -1;
      return (x < y ? -1 : 1) * (desc ? -1 : 1);
    }
    return 0;
  });
}

/** `expand=phases,cost`, each name checked against what the resource can inline. */
export function parseExpand<K extends string>(
  v: string | undefined,
  allowed: readonly K[],
): Set<K> {
  const out = new Set<K>();
  for (const name of csvParam(v) ?? []) {
    if (!(allowed as readonly string[]).includes(name))
      throw new ApiProblem('validation_failed', `Cannot expand ${name}`, {
        errors: [{ field: 'expand', message: `allowed: ${allowed.join(', ')}` }],
      });
    out.add(name as K);
  }
  return out;
}

/** `fields=id,title` trims top-level properties; `id` is always kept. */
export function pickFields<T extends object>(value: T, fields: string | undefined): Partial<T> {
  const wanted = csvParam(fields);
  if (!wanted) return value;
  const keep = new Set(['id', ...wanted]);
  return Object.fromEntries(Object.entries(value).filter(([k]) => keep.has(k))) as Partial<T>;
}

export function pickFieldsPage<T extends object>(
  page: Paged<T>,
  fields: string | undefined,
): Paged<Partial<T>> {
  return csvParam(fields) ? { ...page, items: page.items.map((i) => pickFields(i, fields)) } : page;
}

// ---- Versions as ETags -----------------------------------------------------

/** A body together with the store version that backs its `ETag`. */
export class Versioned<T> {
  constructor(
    readonly body: T,
    readonly version: number,
  ) {}
}

export const etagOf = (version: number): string => `"v${version}"`;

/** Parses `If-Match` into a version. Missing is 428 when required; a malformed or `*` value never matches. */
export function parseIfMatch(header: string | undefined, required: boolean): number | undefined {
  if (header === undefined || header === '') {
    if (required)
      throw new ApiProblem(
        'precondition_required',
        'This change needs an If-Match header with the current ETag',
      );
    return undefined;
  }
  const m = /^(?:W\/)?"v(\d+)"$/.exec(header.trim());
  if (!m)
    throw new ApiProblem(
      'precondition_failed',
      'The If-Match value does not match the current version',
    );
  return Number(m[1]);
}

/** Whether `If-None-Match` already holds the current version (answer 304). */
export function notModified(header: string | undefined, version: number): boolean {
  if (!header) return false;
  return header.split(',').some((t) => t.trim().replace(/^W\//, '') === etagOf(version));
}
