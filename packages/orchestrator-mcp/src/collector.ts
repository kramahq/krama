import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  correlationRunId,
  signalsOfAgentEvent,
  type AgentEventWire,
  type Engine,
  type Ports,
} from '@kramahq/engine';

/** What an event sink token says about the agent that holds it. Exact for per-run instances. */
export interface EventClaims {
  runId: string;
  /** The running instance (`Agent.id`). */
  instanceId: string;
  /** The agent's id in the pack's graph. */
  agent: string;
  role: string;
  backend: string;
}

const hash = (t: string) => createHash('sha256').update(t).digest();

/** Bearer tokens for the event sink. Like the MCP tokens: only hashes are kept, a token belongs to one run and is revoked with it. */
export class EventTokens {
  private readonly byHash = new Map<string, EventClaims & { expiresAt: number }>();
  constructor(private readonly now: () => number = Date.now) {}

  issue(claims: EventClaims, ttlMs = 6 * 60 * 60_000): string {
    const token = `krm_evt_${randomBytes(32).toString('base64url')}`;
    this.byHash.set(hash(token).toString('hex'), { ...claims, expiresAt: this.now() + ttlMs });
    return token;
  }

  verify(token: string | undefined): EventClaims | undefined {
    if (!token) return undefined;
    const key = hash(token).toString('hex');
    const c = this.byHash.get(key);
    if (!c) return undefined;
    if (!timingSafeEqual(Buffer.from(key, 'hex'), hash(token))) return undefined;
    if (c.expiresAt <= this.now()) {
      this.byHash.delete(key);
      return undefined;
    }
    return {
      runId: c.runId,
      instanceId: c.instanceId,
      agent: c.agent,
      role: c.role,
      backend: c.backend,
    };
  }

  revokeRun(runId: string): number {
    let n = 0;
    for (const [k, c] of this.byHash)
      if (c.runId === runId) {
        this.byHash.delete(k);
        n++;
      }
    return n;
  }

  get size(): number {
    return this.byHash.size;
  }
}

export type ReceiveResult = 'accepted' | 'duplicate' | 'parked';

export interface CollectorStats {
  accepted: number;
  duplicate: number;
  parked: number;
}

export interface Parked {
  eventType: string;
  agent: string;
  reason: string;
}

export interface CollectorOptions {
  engine: Engine;
  ports: Ports;
  tokens?: EventTokens;
  /** Largest request body accepted. Default 256 KiB (the wrapper truncates tool output at 10,000 characters). */
  maxBodyBytes?: number;
  onError?: (e: unknown) => void;
}

const SEEN_EVENT_IDS = 5000;
const PARKED_KEPT = 100;

/**
 * The one endpoint that every managed agent of every run reports to (`POST /agent-events`). Attribution never comes
 * from the URL: an agent process can serve many contexts, so the event's own correlation context decides first, and
 * the token's claims (exact for a per-run instance) otherwise. An event that cannot be attributed, or whose context
 * contradicts its token, is counted and parked, never guessed. What is accepted goes through the same ingest flow as
 * the A2A stream, so both channels look the same downstream.
 */
export class AgentEventCollector {
  readonly tokens: EventTokens;
  readonly stats: CollectorStats = { accepted: 0, duplicate: 0, parked: 0 };
  /** The most recent events that could not be attributed, without their payloads. */
  readonly parked: Parked[] = [];
  private readonly seen = new Set<string>();
  private http: Server | undefined;
  private base: string | undefined;

  constructor(private readonly o: CollectorOptions) {
    this.tokens = o.tokens ?? new EventTokens();
  }

  /** Base URL once listening; agents post to `<url>/agent-events`. */
  get url(): string {
    if (!this.base) throw new Error('The event collector is not listening');
    return this.base;
  }

  /** Attributes one event reported by the agent that holds `claims`, and ingests it. */
  async receive(wire: AgentEventWire, claims: EventClaims): Promise<ReceiveResult> {
    const eventType = wire.eventType ?? 'unknown';
    const park = (reason: string): ReceiveResult => {
      this.stats.parked++;
      this.parked.push({ eventType, agent: claims.agent, reason });
      if (this.parked.length > PARKED_KEPT) this.parked.shift();
      return 'parked';
    };

    // A retried POST must not count twice: usage is accounted from these.
    if (wire.eventId) {
      if (this.seen.has(wire.eventId)) {
        this.stats.duplicate++;
        return 'duplicate';
      }
      this.seen.add(wire.eventId);
      if (this.seen.size > SEEN_EVENT_IDS) this.seen.delete(this.seen.values().next().value!);
    }

    const said = correlationRunId(wire);
    if (said !== undefined && said !== claims.runId)
      return park(`the event names run ${said} but its token belongs to ${claims.runId}`);
    if (!(await this.o.ports.store.runs.get(claims.runId))) return park('the run does not exist');

    await this.o.engine.ingest.ingest(
      {
        runId: claims.runId,
        agent: { id: claims.instanceId, role: claims.role, backend: claims.backend },
        channel: 'http',
      },
      signalsOfAgentEvent(wire),
    );
    this.stats.accepted++;
    return 'accepted';
  }

  /** Handles `POST /agent-events`. Exposed so the server can mount the same handler on its own route. */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const json = (code: number, body: unknown, headers: Record<string, string> = {}) => {
      res
        .writeHead(code, { 'content-type': 'application/json', ...headers })
        .end(JSON.stringify(body));
    };
    try {
      if (req.url?.split('?')[0] !== '/agent-events') return json(404, { error: 'not found' });
      // DNS-rebinding guard: only loopback hosts.
      const host = String(req.headers.host ?? '').replace(/:\d+$/, '');
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(host))
        return json(403, { error: 'forbidden host' });
      if (req.method !== 'POST')
        return json(405, { error: 'method not allowed' }, { allow: 'POST' });
      const auth = String(req.headers.authorization ?? '');
      const claims = this.tokens.verify(
        auth.startsWith('Bearer ') ? auth.slice(7).trim() : undefined,
      );
      if (!claims)
        return json(401, { error: 'invalid or expired token' }, { 'www-authenticate': 'Bearer' });

      const max = this.o.maxBodyBytes ?? 256 * 1024;
      let size = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > max) return json(413, { error: 'request too large' });
        chunks.push(chunk as Buffer);
      }
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return json(400, { error: 'invalid JSON' });
      }
      if (!body || typeof body !== 'object' || Array.isArray(body))
        return json(400, { error: 'expected one event object' });
      return json(202, { status: await this.receive(body as AgentEventWire, claims) });
    } catch (e) {
      this.o.onError?.(e);
      if (!res.headersSent) json(500, { error: 'internal error' });
    }
  }

  /** Starts the endpoint on loopback and returns its base URL. */
  async listen(port = 0, host = '127.0.0.1'): Promise<string> {
    this.http = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.http!.listen(port, host, resolve));
    const addr = this.http.address() as { port: number };
    this.base = `http://${host}:${addr.port}`;
    return this.base;
  }

  async close(): Promise<void> {
    const s = this.http;
    this.http = undefined;
    if (s) {
      s.closeAllConnections();
      await new Promise<void>((r) => s.close(() => r()));
    }
  }
}
