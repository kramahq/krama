import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Run } from '@kramahq/contract';
import type { AgentRef, Engine, Ports, ResolvedRole } from '@kramahq/engine';
import { toToolError } from './errors.js';
import {
  KRAMA_MODE_ONLY_TOOLS,
  TOOLS,
  type AgentDirectory,
  type SharedState,
  type ToolCtx,
} from './tools.js';
import { ensureWorker } from './workers.js';
import { TokenRegistry, type Scope } from './tokens.js';

export interface OrchestratorMcpOptions {
  engine: Engine;
  ports: Ports;
  directory: AgentDirectory;
  tokens?: TokenRegistry;
  /** Log sink for unexpected failures (never receives tokens). */
  onError?: (e: unknown, tool: string) => void;
}

const MAX_BODY = 1024 * 1024;

/**
 * MCP server (Streamable HTTP) that exposes the orchestration verbs to an orchestrator agent.
 * Each request is authenticated by a scoped token and served by a server instance bound to that run,
 * so the caller can only ever act on its own run, and every call goes through the engine's invariants.
 */
export class OrchestratorMcp {
  readonly tokens: TokenRegistry;
  private readonly state: SharedState = {
    inflight: new Map(),
    agents: new Map(),
    contexts: new Map(),
  };
  private http: Server | undefined;

  constructor(private readonly o: OrchestratorMcpOptions) {
    this.tokens = o.tokens ?? new TokenRegistry();
  }

  /** An MCP server whose tools act as `scope`'s run. Exposed for in-process use and tests. */
  buildServer(scope: Scope): McpServer {
    const server = new McpServer({ name: 'krama-orchestrator', version: '0.0.0' });
    const ctx: ToolCtx = {
      scope,
      engine: this.o.engine,
      ports: this.o.ports,
      directory: this.o.directory,
      state: this.state,
    };
    // The SDK types handlers per input shape; our tools are heterogeneous, so register through a loose signature.
    const register = server.registerTool.bind(server) as unknown as (
      name: string,
      cfg: unknown,
      cb: (args: unknown) => Promise<unknown>,
    ) => void;
    for (const t of TOOLS) {
      if (scope.delegation === 'native' && KRAMA_MODE_ONLY_TOOLS.has(t.name)) continue;
      register(
        t.name,
        { title: t.title, description: t.description, inputSchema: t.input },
        async (args: unknown) => {
          try {
            const result = await (t.run as (c: ToolCtx, a: unknown) => Promise<unknown>)(ctx, args);
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(result) }],
              structuredContent: result as Record<string, unknown>,
            };
          } catch (e) {
            const body = toToolError(e);
            if (body.code === 'internal') this.o.onError?.(e, t.name);
            return {
              isError: true,
              content: [{ type: 'text' as const, text: JSON.stringify({ error: body }) }],
              structuredContent: { error: body },
            };
          }
        },
      );
    }
    return server;
  }

  /** Starts (or finds) the worker for a role and records it against the run, so `releaseRun` stops it with the run. */
  ensureWorker(run: Run, resolved: ResolvedRole): Promise<AgentRef> {
    return ensureWorker(
      { ports: this.o.ports, directory: this.o.directory, state: this.state },
      run,
      resolved,
    );
  }

  /** Ends a run's session state: returns the worker agent ids spawned for it and forgets conversations and in-flight calls. */
  releaseRun(runId: string): string[] {
    const ids: string[] = [];
    for (const [slot, id] of [...this.state.agents]) {
      if (slot.startsWith(`${runId}:`)) {
        ids.push(id);
        this.state.agents.delete(slot);
      }
    }
    for (const slot of [...this.state.contexts.keys()])
      if (slot.startsWith(`${runId}:`)) this.state.contexts.delete(slot);
    this.tokens.revokeRun(runId);
    return ids;
  }

  /** Starts the HTTP endpoint on loopback. Returns the base URL (add `/mcp`). */
  async listen(port = 0, host = '127.0.0.1'): Promise<string> {
    this.http = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.http!.listen(port, host, resolve));
    const addr = this.http.address() as { port: number };
    return `http://${host}:${addr.port}`;
  }

  async close(): Promise<void> {
    const s = this.http;
    this.http = undefined;
    if (s) {
      s.closeAllConnections();
      await new Promise<void>((r) => s.close(() => r()));
    }
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const json = (code: number, body: unknown, headers: Record<string, string> = {}) => {
      res
        .writeHead(code, { 'content-type': 'application/json', ...headers })
        .end(JSON.stringify(body));
    };
    try {
      if (req.url?.split('?')[0] !== '/mcp') return json(404, { error: 'not found' });
      // DNS-rebinding guard: only loopback hosts.
      const host = String(req.headers.host ?? '').replace(/:\d+$/, '');
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(host))
        return json(403, { error: 'forbidden host' });
      const auth = String(req.headers.authorization ?? '');
      const scope = this.tokens.verify(
        auth.startsWith('Bearer ') ? auth.slice(7).trim() : undefined,
      );
      if (!scope)
        return json(401, { error: 'invalid or expired token' }, { 'www-authenticate': 'Bearer' });
      if (req.method !== 'POST')
        return json(405, { error: 'method not allowed' }, { allow: 'POST' });

      let raw = '';
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > MAX_BODY) return json(413, { error: 'request too large' });
      }
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        return json(400, { error: 'invalid JSON' });
      }

      const server = this.buildServer(scope);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      this.o.onError?.(e, 'http');
      if (!res.headersSent) json(500, { error: 'internal error' });
    }
  }
}
