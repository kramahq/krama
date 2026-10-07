import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

type Json = Record<string, unknown>;

export interface Call {
  /** The operation under its 0.3 name (`message/stream`, `tasks/cancel`), whichever wire version the fake speaks. */
  method: string;
  /** The method name exactly as it arrived (`SendStreamingMessage` on a 1.0 fake). */
  wireMethod: string;
  /** Params in the 0.3 shape (a 1.0 request is translated back, so one set of assertions serves both versions). */
  params: Json;
  headers: IncomingMessage['headers'];
}

export interface FakeOptions {
  /** Wire version the fake speaks: its card, method names and payload shapes. Default `1.0`. */
  version?: '1.0' | '0.3';
  /** Whether the card advertises streaming. A non-streaming agent answers `SendMessage` with one JSON body. */
  streaming?: boolean;
  /** Binding the 1.0 card advertises. `HTTP+JSON` serves `/a2a/rest/message:stream` and `/a2a/rest/tasks/{id}:cancel`. */
  binding?: 'JSONRPC' | 'HTTP+JSON';
  /** Advertise this interface URL instead of the fake's own (a card that points somewhere else). */
  interfaceUrl?: string;
  /** Answer the card request with a redirect to this location. */
  cardRedirect?: string;
  /** Pad the card with this many bytes, to exceed a size cap. */
  cardPadding?: number;
}

/** A scripted A2A JSON-RPC endpoint. Each `message/stream` replays the next queued script. */
export interface Script {
  /** Result objects to stream as SSE frames, in order. A string is written raw (for malformed frames). */
  frames?: (Json | string)[];
  /** Delay before each frame. */
  delayMs?: number;
  /** Keep the stream open after the last frame (until the client leaves). */
  hang?: boolean;
  /** Respond with this status instead of streaming. */
  status?: number;
  /** Respond with plain JSON (no SSE). */
  json?: Json;
  /** Never respond. */
  stall?: boolean;
  /** Answer with a redirect to this location. */
  redirect?: string;
  /** Stream one frame carrying this many bytes of text, to exceed a size cap. */
  bloat?: number;
}

export class FakeA2A {
  readonly calls: Call[] = [];
  /** Requests for the agent card, with their headers. */
  readonly cardRequests: IncomingMessage['headers'][] = [];
  readonly version: '1.0' | '0.3';
  private readonly streaming: boolean;
  private readonly o: FakeOptions;
  private scripts: Script[] = [];
  private server: Server;
  url = '';
  constructor(o: FakeOptions = {}) {
    this.o = o;
    this.version = o.version ?? '1.0';
    this.streaming = o.streaming ?? true;
    this.server = createServer((req, res) => void this.handle(req, res));
  }
  queue(...s: Script[]): this {
    this.scripts.push(...s);
    return this;
  }
  async start(): Promise<this> {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as { port: number }).port}`;
    return this;
  }
  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server.close(() => r()));
  }
  methods(): string[] {
    return this.calls.map((c) => c.method);
  }

  private card(): Json {
    const binding = this.o.binding ?? 'JSONRPC';
    const url =
      this.o.interfaceUrl ?? `${this.url}/a2a/${binding === 'JSONRPC' ? 'jsonrpc' : 'rest'}`;
    const common = {
      ...(this.o.cardPadding ? { padding: 'x'.repeat(this.o.cardPadding) } : {}),
      name: 'Fake agent',
      description: 'Scripted A2A agent for tests',
      version: '1.0.0',
      capabilities: { streaming: this.streaming },
      defaultInputModes: ['text/plain'],
      defaultOutputModes: ['text/plain'],
      skills: [{ id: 'echo', name: 'Echo', description: 'Echoes', tags: ['test'] }],
    };
    return this.version === '1.0'
      ? {
          ...common,
          supportedInterfaces: [
            { url, protocolBinding: binding, protocolVersion: '1.0', tenant: '' },
          ],
        }
      : { ...common, protocolVersion: '0.3.0', url, preferredTransport: 'JSONRPC' };
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === 'GET' && req.url === '/.well-known/agent-card.json') {
      this.cardRequests.push(req.headers);
      if (this.o.cardRedirect) {
        res.writeHead(302, { location: this.o.cardRedirect }).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(this.card()));
      return;
    }
    let raw = '';
    for await (const c of req) raw += c;
    if ((req.url ?? '').startsWith('/a2a/rest/')) return this.handleRest(req, res, raw);
    const body = JSON.parse(raw || '{}') as { id: number; method: string; params: Json };
    const v1 = this.version === '1.0';
    const method = v1 ? (V1_METHODS[body.method] ?? body.method) : body.method;
    const params = v1 ? requestToLegacy(body.params) : body.params;
    this.calls.push({ method, wireMethod: body.method, params, headers: req.headers });
    if (method === 'tasks/cancel') {
      const id = (body.params as { id: string }).id;
      const result = v1
        ? { id, contextId: 'ctx_1', status: { state: 'TASK_STATE_CANCELED' } }
        : { kind: 'task', id, contextId: 'ctx_1', status: { state: 'canceled' } };
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
      return;
    }
    const s = this.scripts.shift() ?? { frames: [] };
    if (s.stall) return;
    if (s.redirect) {
      res.writeHead(302, { location: s.redirect }).end();
      return;
    }
    if (s.status) {
      res.writeHead(s.status).end('nope');
      return;
    }
    if (s.bloat) s.frames = [status('working', { text: 'x'.repeat(s.bloat) })];
    if (s.json) {
      const env = s.json as { result?: Json };
      const out = v1 && env.result ? { ...env, result: oneShotToV1(env.result) } : s.json;
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    for (const f of s.frames ?? []) {
      if (s.delayMs) await new Promise((r) => setTimeout(r, s.delayMs));
      res.write(
        typeof f === 'string'
          ? f
          : `data: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: v1 ? frameToV1(f) : f })}\n\n`,
      );
    }
    if (!s.hang) res.end();
  }

  /** The 1.0 HTTP+JSON binding: the same scripts, with bare `StreamResponse` frames and no JSON-RPC envelope. */
  private handleRest(req: IncomingMessage, res: ServerResponse, raw: string): void {
    const url = req.url ?? '';
    const params = JSON.parse(raw || '{}') as Json;
    const cancel = /^\/a2a\/rest\/tasks\/([^/:]+):cancel$/.exec(url);
    const method = cancel
      ? 'tasks/cancel'
      : url.endsWith('/message:stream')
        ? 'message/stream'
        : 'message/send';
    this.calls.push({
      method,
      wireMethod: `${req.method} ${url}`,
      params: cancel ? { id: cancel[1]! } : requestToLegacy(params),
      headers: req.headers,
    });
    if (cancel) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          id: cancel[1],
          contextId: 'ctx_1',
          status: { state: 'TASK_STATE_CANCELED' },
        }),
      );
      return;
    }
    const s = this.scripts.shift() ?? { frames: [] };
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    for (const f of s.frames ?? [])
      res.write(`data: ${JSON.stringify(typeof f === 'string' ? f : frameToV1(f))}\n\n`);
    if (!s.hang) res.end();
  }
}

// ---- 1.0 wire translation: the scripts are written in the 0.3 shape and translated for a 1.0 fake ------------------
const V1_METHODS: Record<string, string> = {
  SendStreamingMessage: 'message/stream',
  SendMessage: 'message/send',
  CancelTask: 'tasks/cancel',
  SubscribeToTask: 'tasks/resubscribe',
  GetTask: 'tasks/get',
};

const STATES: Record<string, string> = {
  submitted: 'TASK_STATE_SUBMITTED',
  working: 'TASK_STATE_WORKING',
  completed: 'TASK_STATE_COMPLETED',
  failed: 'TASK_STATE_FAILED',
  canceled: 'TASK_STATE_CANCELED',
  'input-required': 'TASK_STATE_INPUT_REQUIRED',
  rejected: 'TASK_STATE_REJECTED',
  'auth-required': 'TASK_STATE_AUTH_REQUIRED',
};
const v1State = (s: unknown): unknown => STATES[String(s)] ?? s;

const v1Part = (p: Json): Json => {
  if (p.kind === 'data') return { data: p.data, mediaType: 'application/json' };
  if (p.kind === 'file') {
    const f = p.file as { bytes: string; mimeType?: string };
    return { raw: f.bytes, mediaType: f.mimeType ?? 'application/octet-stream' };
  }
  return { text: p.text, mediaType: 'text/plain' };
};
const v1Message = (m: Json): Json => ({
  messageId: m.messageId ?? 'm_agent',
  ...(m.contextId ? { contextId: m.contextId } : {}),
  role: 'ROLE_AGENT',
  parts: ((m.parts as Json[]) ?? []).map(v1Part),
  ...(m.metadata ? { metadata: m.metadata } : {}),
});
const v1Status = (s: Json): Json => ({
  state: v1State(s.state),
  ...(s.message ? { message: v1Message(s.message as Json) } : {}),
});
const v1Artifact = (a: Json): Json => ({
  artifactId: a.artifactId,
  name: a.name,
  parts: ((a.parts as Json[]) ?? []).map(v1Part),
});
const v1Task = (t: Json): Json => ({
  id: t.id,
  contextId: t.contextId,
  status: v1Status(t.status as Json),
  ...(t.artifacts ? { artifacts: (t.artifacts as Json[]).map(v1Artifact) } : {}),
  ...(t.metadata ? { metadata: t.metadata } : {}),
});

/** A 0.3-shaped stream frame as the 1.0 `StreamResponse`. */
export function frameToV1(f: Json): Json {
  switch (f.kind) {
    case 'task':
      return { task: v1Task(f) };
    case 'message':
      return { message: v1Message(f) };
    case 'status-update':
      return {
        statusUpdate: {
          taskId: f.taskId,
          contextId: f.contextId,
          status: v1Status(f.status as Json),
          ...(f.metadata ? { metadata: f.metadata } : {}),
        },
      };
    case 'artifact-update':
      return {
        artifactUpdate: {
          taskId: f.taskId,
          contextId: f.contextId,
          artifact: v1Artifact(f.artifact as Json),
          append: f.append ?? false,
          lastChunk: f.lastChunk ?? false,
        },
      };
    default:
      return f;
  }
}
const oneShotToV1 = (r: Json): Json =>
  r.kind === 'message' ? { message: v1Message(r) } : { task: v1Task(r) };

/** A 1.0 request's params in the 0.3 shape, so tests assert on one shape. */
function requestToLegacy(p: Json): Json {
  const m = p.message as Json | undefined;
  if (!m) return p;
  return {
    ...p,
    message: {
      ...m,
      role: m.role === 'ROLE_USER' ? 'user' : 'agent',
      parts: ((m.parts as Json[]) ?? []).map((x) => ({ kind: 'text', ...x })),
    },
  };
}

// ---- frame builders ---------------------------------------------------------
export const task = (state: string, extra: Json = {}): Json => ({
  kind: 'task',
  id: 'task_1',
  contextId: 'ctx_1',
  status: { state },
  ...extra,
});
export const status = (
  state: string,
  opts: { text?: string; final?: boolean; metadata?: Json } = {},
): Json => ({
  kind: 'status-update',
  taskId: 'task_1',
  contextId: 'ctx_1',
  final: opts.final ?? false,
  status: {
    state,
    ...(opts.text
      ? {
          message: {
            kind: 'message',
            messageId: 'm_status',
            role: 'agent',
            parts: [{ kind: 'text', text: opts.text }],
          },
        }
      : {}),
  },
  ...(opts.metadata ? { metadata: opts.metadata } : {}),
});
export const artifact = (
  name: string,
  parts: Json[],
  opts: { id?: string; append?: boolean; lastChunk?: boolean } = {},
): Json => ({
  kind: 'artifact-update',
  taskId: 'task_1',
  contextId: 'ctx_1',
  artifact: { artifactId: opts.id ?? `${name}-1`, name, parts },
  ...(opts.append !== undefined ? { append: opts.append } : {}),
  ...(opts.lastChunk !== undefined ? { lastChunk: opts.lastChunk } : {}),
});
export const text = (t: string): Json => ({ kind: 'text', text: t });
export const data = (d: Json): Json => ({ kind: 'data', data: d });
