import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

type Json = Record<string, unknown>;

export interface Call {
  method: string;
  params: Json;
  headers: IncomingMessage['headers'];
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
}

export class FakeA2A {
  readonly calls: Call[] = [];
  private scripts: Script[] = [];
  private server: Server;
  url = '';
  constructor() {
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

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let raw = '';
    for await (const c of req) raw += c;
    const body = JSON.parse(raw || '{}') as { id: number; method: string; params: Json };
    this.calls.push({ method: body.method, params: body.params, headers: req.headers });
    if (body.method === 'tasks/cancel') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result: { id: (body.params as { id: string }).id, status: { state: 'canceled' } },
        }),
      );
      return;
    }
    const s = this.scripts.shift() ?? { frames: [] };
    if (s.stall) return;
    if (s.status) {
      res.writeHead(s.status).end('nope');
      return;
    }
    if (s.json) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(s.json));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    for (const f of s.frames ?? []) {
      if (s.delayMs) await new Promise((r) => setTimeout(r, s.delayMs));
      res.write(
        typeof f === 'string'
          ? f
          : `data: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: f })}\n\n`,
      );
    }
    if (!s.hang) res.end();
  }
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
      ? { message: { role: 'agent', parts: [{ kind: 'text', text: opts.text }] } }
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
