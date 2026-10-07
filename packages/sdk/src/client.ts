import type {
  Capabilities,
  CreateRun,
  Decision,
  EventEnvelope,
  Me,
  Pack,
  Problem,
  Project,
  ResolveDecision,
  Run,
} from '@kramahq/contract';
import { ApiError } from './errors.js';
import { connectEvents, type EventStream, type EventStreamOptions } from './events.js';

export interface Page<T> {
  items: T[];
  nextCursor?: string;
  total?: number;
}

export interface ClientOptions {
  /** Where the API lives, e.g. `http://127.0.0.1:4010/api/v1` or `/api/v1`. */
  baseUrl: string;
  token?: string | undefined;
  fetch?: typeof fetch;
}

type Query = Record<string, string | number | boolean | readonly string[] | undefined>;

export interface RunQuery extends Query {
  status?: readonly string[];
  project?: string;
  pack?: string;
  q?: string;
  limit?: number;
  cursor?: string;
  sort?: string;
}
export interface DecisionQuery extends Query {
  status?: readonly string[];
  kind?: readonly string[];
  runId?: string;
  q?: string;
  limit?: number;
  cursor?: string;
}

/** An activity item as the feed shows it. */
export interface ActivityItem {
  id: string;
  at: string;
  type: 'tool_call' | 'tool_result' | 'thinking' | 'status' | 'message' | 'artifact' | 'decision';
  runId: string;
  phaseId?: string;
  agent?: { id: string; role: string; backend: string };
  text?: string;
  toolName?: string;
  isError?: boolean;
  durationMs?: number;
  [k: string]: unknown;
}

export function createClient(o: ClientOptions) {
  const doFetch = o.fetch ?? fetch;
  const base = o.baseUrl.replace(/\/$/, '');
  const authHeaders = (): Record<string, string> =>
    o.token ? { authorization: `Bearer ${o.token}` } : {};

  const qs = (q: Query = {}): string => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) {
      if (v === undefined || (Array.isArray(v) && v.length === 0)) continue;
      p.set(k, Array.isArray(v) ? v.join(',') : String(v));
    }
    const s = p.toString();
    return s ? `?${s}` : '';
  };

  async function request<T>(
    method: string,
    path: string,
    opts: { query?: Query; body?: unknown; signal?: AbortSignal } = {},
  ): Promise<T> {
    let res: Response;
    try {
      res = await doFetch(`${base}${path}${qs(opts.query)}`, {
        method,
        headers: {
          accept: 'application/json',
          ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...authHeaders(),
        },
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw e;
      throw new ApiError(`Cannot reach the Krama server at ${base}`, 0);
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = undefined;
    }
    if (!res.ok) {
      const problem = body as Problem | undefined;
      throw new ApiError(
        problem?.detail ?? problem?.title ?? `HTTP ${res.status}`,
        res.status,
        problem,
      );
    }
    return body as T;
  }

  const get = <T>(path: string, query?: Query, signal?: AbortSignal) =>
    request<T>('GET', path, { ...(query ? { query } : {}), ...(signal ? { signal } : {}) });
  const post = <T>(path: string, body?: unknown) =>
    request<T>('POST', path, body === undefined ? {} : { body });

  return {
    capabilities: () => get<Capabilities>('/capabilities'),
    me: () => get<Me>('/me'),
    health: () => get<{ status: string }>('/health'),

    /** Which backends the platform lets runs use. Capabilities lists what exists; this lists what is allowed. */
    allowedBackends: () =>
      get<{ items: { wrapper: string; allowed: boolean }[] }>('/allowed-backends'),

    projects: {
      list: () => get<Page<Project>>('/projects'),
      get: (id: string) => get<Project>(`/projects/${id}`),
    },
    packs: {
      list: (q?: Query) => get<Page<Pack>>('/packs', q),
      get: (id: string) => get<Pack>(`/packs/${id}`),
    },
    runs: {
      list: (q?: RunQuery, signal?: AbortSignal) => get<Page<Run>>('/runs', q, signal),
      get: (id: string, expand?: readonly string[]) =>
        get<Run>(`/runs/${id}`, expand ? { expand } : undefined),
      create: (body: CreateRun) => post<Run>('/runs', body),
      pause: (id: string) => post<Run>(`/runs/${id}/pause`),
      resume: (id: string) => post<Run>(`/runs/${id}/resume`),
      stop: (id: string) => post<Run>(`/runs/${id}/stop`),
      activity: (id: string, q?: Query) => get<Page<ActivityItem>>(`/runs/${id}/activity`, q),
      /** All of a run's activity, oldest first, following the cursor (the API caps a page at 200). */
      async allActivity(id: string, maxPages = 5): Promise<Page<ActivityItem>> {
        const items: ActivityItem[] = [];
        let cursor: string | undefined;
        for (let i = 0; i < maxPages; i++) {
          const page: Page<ActivityItem> = await get<Page<ActivityItem>>(`/runs/${id}/activity`, {
            limit: 200,
            ...(cursor ? { cursor } : {}),
          });
          items.push(...page.items);
          cursor = page.nextCursor;
          if (!cursor) break;
        }
        return { items, ...(cursor ? { nextCursor: cursor } : {}) };
      },
      decisions: (id: string, q?: Query) => get<Page<Decision>>(`/runs/${id}/decisions`, q),
    },
    decisions: {
      list: (q?: DecisionQuery, signal?: AbortSignal) =>
        get<Page<Decision>>('/decisions', q, signal),
      get: (id: string) => get<Decision>(`/decisions/${id}`),
      resolve: (id: string, body: ResolveDecision) =>
        post<Decision>(`/decisions/${id}/resolve`, body),
    },

    /**
     * The live event stream, kept open and resumed after a drop (see `connectEvents`). With a token the stream is opened
     * with the bearer header, so no ticket is needed.
     */
    events(
      o2: Omit<EventStreamOptions, 'url' | 'headers' | 'fetch'> & {
        headers?: Record<string, string>;
      },
    ): EventStream {
      return connectEvents({
        ...o2,
        url: `${base}/events`,
        headers: { ...authHeaders(), ...(o2.headers ?? {}) },
        fetch: doFetch,
      });
    },
  };
}

export type Client = ReturnType<typeof createClient>;
export type { EventEnvelope };
