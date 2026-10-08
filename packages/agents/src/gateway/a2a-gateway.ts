import {
  AgentCard,
  CancelTaskRequest,
  GetTaskRequest,
  ListTasksRequest,
  SendMessageRequest,
  SubscribeToTaskRequest,
  TaskState as WireTaskState,
} from '@a2a-js/sdk';
import {
  ClientFactory,
  DefaultAgentCardResolver,
  JsonRpcTransportFactory,
  RestTransportFactory,
  type Client,
} from '@a2a-js/sdk/client';
import type {
  AgentGateway,
  AgentRef,
  GatewayEvent,
  GatewayTap,
  SendMessage,
  TaskListQuery,
  TaskSnapshot,
} from '@kramahq/engine';
import { OAuthTokenProvider, TokenError, type AgentAuth } from './auth.js';
import {
  CardSignatureError,
  checkCard,
  type CardTrust,
  type SignatureStatus,
} from './card-trust.js';
import { reportCard, type CardReport } from './card-report.js';
import { ArtifactAssembler, decodeEvent, isTerminal, type DecodeState } from './codec.js';
import {
  EXTERNAL_EGRESS,
  EgressError,
  MANAGED_EGRESS,
  createSafeFetch,
  redact,
  type EgressPolicy,
  type ProxyConfig,
  type RequestAuth,
  type TlsMaterial,
} from './egress.js';
import { dropMalformedSseFrames } from './sse.js';
import { streamToWire, taskToWire } from './wire.js';

export class GatewayError extends Error {
  constructor(
    readonly code:
      | 'unreachable'
      | 'http_error'
      | 'rpc_error'
      | 'bad_response'
      | 'blocked'
      | 'too_large'
      | 'unauthenticated'
      | 'untrusted_card'
      | 'task_not_found',
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'GatewayError';
  }
}

export interface GatewayOptions {
  /** Total time one delegation may take. Long media jobs pass a larger `timeoutMs` per call. Default 30 min. */
  defaultTimeoutMs?: number;
  /** Abort when the agent goes silent this long (any event resets it). Default 15 min. */
  inactivityMs?: number;
  /** Outbound policy for agents Krama started (loopback allowed). */
  managed?: Partial<EgressPolicy>;
  /** Outbound policy for `external` agents (public addresses only, no redirects, size-capped). */
  external?: Partial<EgressPolicy>;
  /**
   * Request headers per destination origin, for example `{ 'https://agent.example.com': { authorization: 'Bearer …' } }`.
   * Sent only to that origin, and removed from any error text.
   */
  credentials?: Record<string, Record<string, string>>;
  /**
   * How Krama authenticates to an agent origin: an OAuth 2.0 client-credentials grant (the token is fetched, cached and
   * renewed, and retried once on a 401) or a fixed bearer token. Sent only to that origin. Secrets are masked in errors.
   */
  auth?: Record<string, AgentAuth>;
  /** TLS material per destination origin: a client certificate and key for mutual TLS, and/or a private CA. PEM text. */
  tls?: Record<string, TlsMaterial>;
  /**
   * Proxy for `external` agents. Default `env`: `HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY` are honoured. Agents Krama
   * started are always reached directly. Through a proxy the connect-time address check cannot run (the proxy resolves the
   * name), so the proxy becomes the control point; see ADR-0029.
   */
  proxy?: ProxyConfig;
  /** Signed agent cards (external agents): which keys to trust and whether a signature is required. */
  cards?: CardTrust;
  /** How long a fetched agent card is trusted before it is read again. Default 5 min. */
  cardTtlMs?: number;
  /** Budget for the calls that are not a delegation: reading a card, cancelling. Default 10 s. */
  requestTimeoutMs?: number;
  /** Sees every request and stream frame, for the run's transcript. A tap that throws is ignored. */
  tap?: GatewayTap;
}

const newMessageId = () => crypto.randomUUID();

/**
 * The caller's correlation context in the wrapper's own names (`trace_id`, `parent_agent_id`, `propagated_metadata`), so an
 * agent can stamp it on its events and pass it on to the agents it calls. An agent that ignores it is unaffected.
 */
export function correlationMetadata(
  c: NonNullable<SendMessage['correlation']>,
): Record<string, unknown> {
  return {
    ...(c.traceId ? { trace_id: c.traceId } : {}),
    ...(c.parentAgentId ? { parent_agent_id: c.parentAgentId } : {}),
    propagated_metadata: {
      run_id: c.runId,
      ...(c.phaseId ? { phase_id: c.phaseId } : {}),
      ...(c.stepId ? { step_id: c.stepId } : {}),
    },
  };
}

export class A2AGateway implements AgentGateway {
  private readonly clients = new Map<
    string,
    { client: Client; card: AgentCard; at: number; signature: SignatureStatus }
  >();
  private readonly providers = new Map<string, OAuthTokenProvider>();
  private readonly secrets: string[];

  constructor(private readonly o: GatewayOptions = {}) {
    this.secrets = Object.values(o.credentials ?? {}).flatMap((h) => Object.values(h));
  }

  private policy(agent: AgentRef): EgressPolicy {
    return agent.external
      ? { ...EXTERNAL_EGRESS, ...this.o.external }
      : { ...MANAGED_EGRESS, ...this.o.managed };
  }

  private credentialsFor = (origin: string) => this.o.credentials?.[origin];

  private proxyFor(agent: AgentRef): ProxyConfig {
    return agent.external ? (this.o.proxy ?? 'env') : 'none';
  }

  /** The renewable credential for an origin, if one is configured. One provider per origin, shared by every call. */
  private authFor(
    policy: EgressPolicy,
    proxy: ProxyConfig,
  ): (origin: string) => RequestAuth | undefined {
    return (origin) => {
      const cfg = this.o.auth?.[origin];
      if (!cfg) return undefined;
      if (cfg.type === 'bearer')
        return {
          headers: async () => ({ authorization: `Bearer ${cfg.token}` }),
          rejected: () => undefined,
        };
      const hit = this.providers.get(origin);
      if (hit) return hit;
      // The token endpoint is reached under the same rules as the agent, with its own origin allowed.
      const tokenOrigin = safeOrigin(cfg.tokenUrl);
      const tokenPolicy: EgressPolicy = {
        ...policy,
        ...(policy.allowedOrigins
          ? { allowedOrigins: [...policy.allowedOrigins, tokenOrigin] }
          : {}),
      };
      const provider = new OAuthTokenProvider(
        cfg,
        this.guardedFetch(
          createSafeFetch({ policy: tokenPolicy, proxy, tlsFor: (o) => this.o.tls?.[o] }),
        ),
      );
      this.providers.set(origin, provider);
      return provider;
    };
  }

  /** Everything that must be masked in text we return or log. */
  private secretValues(): string[] {
    const proxyEnv = [
      process.env['HTTPS_PROXY'],
      process.env['https_proxy'],
      process.env['HTTP_PROXY'],
      process.env['http_proxy'],
      typeof this.o.proxy === 'object' ? this.o.proxy.url : undefined,
    ];
    const proxySecrets = proxyEnv.flatMap((u) => {
      try {
        return u ? [decodeURIComponent(new URL(u).password)].filter(Boolean) : [];
      } catch {
        return [];
      }
    });
    const auth = Object.values(this.o.auth ?? {}).flatMap((a) =>
      a.type === 'bearer' ? [a.token] : [a.clientSecret],
    );
    const tokens = [...this.providers.values()].flatMap((p) => p.secrets());
    const tls = Object.values(this.o.tls ?? {}).flatMap((t) => [t.key, t.passphrase]);
    return [...this.secrets, ...proxySecrets, ...auth, ...tokens, ...tls].filter(
      (s): s is string => !!s,
    );
  }

  /** The SDK client for an agent, built from its card (`supportedInterfaces`) and cached for a while. */
  private async clientFor(
    agent: AgentRef,
  ): Promise<{ client: Client; card: AgentCard; signature: SignatureStatus }> {
    const key = `${agent.external ? 'x' : 'm'}|${agent.url}`;
    const hit = this.clients.get(key);
    if (hit && Date.now() - hit.at < (this.o.cardTtlMs ?? 5 * 60_000)) return hit;

    const policy = this.policy(agent);
    const proxy = this.proxyFor(agent);
    const fetchImpl = this.guardedFetch(
      createSafeFetch({
        policy,
        proxy,
        credentialsFor: this.credentialsFor,
        authFor: this.authFor(policy, proxy),
        tlsFor: (o) => this.o.tls?.[o],
      }),
      agent,
    );
    const resolver = new DefaultAgentCardResolver({ fetchImpl, legacyCompat: { enabled: true } });
    const factory = new ClientFactory({
      transports: [
        new JsonRpcTransportFactory({ fetchImpl, legacyCompat: { enabled: true } }),
        new RestTransportFactory({ fetchImpl, legacyCompat: { enabled: true } }),
      ],
      preferredTransports: ['JSONRPC', 'HTTP+JSON'],
      cardResolver: resolver,
    });
    let card: AgentCard;
    try {
      const timeout = AbortSignal.timeout(this.o.requestTimeoutMs ?? 10_000);
      card = await withSignal(resolver.resolve(agent.url), timeout);
    } catch (e) {
      throw this.fail(e, agent, 'reading the agent card');
    }
    // A card may not send traffic (and credentials) to a host other than the one it was fetched from, unless that host
    // is on the allow-list. gRPC is not used.
    const origin = new URL(agent.url).origin;
    const allowed = new Set([origin, ...(policy.allowedOrigins ?? [])]);
    // A signature is checked before anything in the card is believed, including where it says to connect.
    let signature: SignatureStatus = 'unsigned';
    if (agent.external) {
      try {
        signature = await checkCard(card, this.o.cards, { fetchImpl, allowedOrigins: allowed });
      } catch (e) {
        throw e instanceof CardSignatureError
          ? new GatewayError('untrusted_card', this.clean(`${agent.role}: ${e.message}`))
          : this.fail(e, agent, 'verifying the agent card');
      }
    }
    const usable = card.supportedInterfaces.filter(
      (i) => i.protocolBinding.toUpperCase() !== 'GRPC' && allowed.has(safeOrigin(i.url)),
    );
    if (!usable.length)
      throw new GatewayError(
        'bad_response',
        `${agent.role} advertises no JSON-RPC or HTTP+JSON interface on ${origin}`,
      );
    card = { ...card, supportedInterfaces: usable };
    let client: Client;
    try {
      client = await factory.createFromAgentCard(card);
    } catch (e) {
      throw this.fail(e, agent, 'preparing the client');
    }
    const entry = { client, card, at: Date.now(), signature };
    this.clients.set(key, entry);
    return entry;
  }

  /** Network failures from the safe fetch become typed errors before the SDK can wrap them. */
  private guardedFetch(inner: typeof fetch, agent?: AgentRef): typeof fetch {
    return async (input, init) => {
      try {
        const res = await inner(input, init);
        // The SDK reports a 401 as an unrelated protocol error, so the status is named here.
        if (agent && (res.status === 401 || res.status === 403)) {
          await res.body?.cancel().catch(() => undefined);
          throw new GatewayError(
            'unauthenticated',
            `${agent.role} answered HTTP ${res.status}: the credentials were missing or rejected`,
          );
        }
        return (res.headers.get('content-type') ?? '').includes('text/event-stream') && res.body
          ? new Response(res.body.pipeThrough(dropMalformedSseFrames()), {
              status: res.status,
              headers: res.headers,
            })
          : res;
      } catch (e) {
        if (init?.signal?.aborted) throw e;
        // undici wraps an error thrown while connecting (a refused address) as `fetch failed` with the cause attached.
        for (let c: unknown = e, n = 0; c && n < 6; c = (c as { cause?: unknown }).cause, n++)
          if (c instanceof EgressError || c instanceof TokenError || c instanceof GatewayError)
            throw c;
        throw new GatewayError('unreachable', (e as Error).message, { cause: e });
      }
    };
  }

  /** Describes an agent's card: what it advertises, which interface is used, what would get in the way. Advisory. */
  async inspect(agent: AgentRef): Promise<CardReport> {
    const { card, client, signature } = await this.clientFor(agent);
    const url = (client.transport as unknown as { endpoint?: string }).endpoint;
    return reportCard(card, url, signature);
  }

  async *send(agent: AgentRef, message: SendMessage): AsyncGenerator<GatewayEvent> {
    const total = message.timeoutMs ?? this.o.defaultTimeoutMs ?? 30 * 60_000;
    const idle = this.o.inactivityMs ?? 15 * 60_000;
    const ctl = new AbortController();
    let why: 'timeout' | 'idle' | 'caller' | undefined;
    const abort = (r: typeof why) => {
      why ??= r;
      ctl.abort();
    };
    const totalTimer = setTimeout(() => abort('timeout'), total);
    let idleTimer = setTimeout(() => abort('idle'), idle);
    const bump = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => abort('idle'), idle);
    };
    const onCaller = () => abort('caller');
    message.signal?.addEventListener('abort', onCaller, { once: true });
    if (message.signal?.aborted) abort('caller');

    const st: DecodeState = { assembler: new ArtifactAssembler() };
    let sawTerminal = false;
    const callId = newMessageId();
    let tapIndex = 0;
    const tap = (
      direction: 'out' | 'in',
      kind: 'request' | 'frame' | 'error' | 'cancel',
      body: unknown,
    ) => {
      if (!this.o.tap) return;
      try {
        this.o.tap({
          direction,
          kind,
          agent,
          ...(message.correlation ? { correlation: message.correlation } : {}),
          callId,
          index: tapIndex++,
          body,
        });
      } catch {
        /* a tap must never break a delegation */
      }
    };
    try {
      const { client } = await this.clientFor(agent);
      const request = SendMessageRequest.fromJSON({
        message: {
          messageId: callId,
          role: 'ROLE_USER',
          parts: [{ text: message.text, mediaType: 'text/plain' }],
          ...(message.contextId ? { contextId: message.contextId } : {}),
          ...(message.correlation ? { metadata: correlationMetadata(message.correlation) } : {}),
        },
        configuration: { returnImmediately: false },
      });
      tap('out', 'request', SendMessageRequest.toJSON(request));
      try {
        for await (const sr of client.sendMessageStream(request, { signal: ctl.signal })) {
          bump();
          const wire = streamToWire(sr);
          if (!wire) continue;
          tap('in', 'frame', wire);
          for (const g of decodeEvent(wire, st)) {
            if (g.kind === 'state' && isTerminal(g.state)) sawTerminal = true;
            yield g;
          }
        }
      } catch (e) {
        if (ctl.signal.aborted) throw e;
        const failure = this.fail(e, agent, 'the delegation');
        tap('in', 'error', { code: failure.code, message: failure.message });
        throw failure;
      }
      for (const g of st.assembler.flush()) yield g;
      if (!sawTerminal && st.lastState !== 'input_required' && st.taskId) {
        yield {
          kind: 'state',
          state: 'failed',
          taskId: st.taskId,
          ...(st.contextId ? { contextId: st.contextId } : {}),
          text: 'The agent closed the stream without a final state',
        };
      }
    } catch (e) {
      if (ctl.signal.aborted && why) {
        // Stop the remote task too, so it does not keep running (and spending) unattended.
        if (st.taskId) {
          tap('out', 'cancel', { taskId: st.taskId, reason: why });
          await this.cancel(agent, st.taskId).catch(() => undefined);
        }
        const state = why === 'caller' ? 'canceled' : 'timed_out';
        yield {
          kind: 'state',
          state,
          taskId: st.taskId ?? 'unknown',
          ...(st.contextId ? { contextId: st.contextId } : {}),
          text:
            why === 'caller'
              ? 'Canceled'
              : why === 'idle'
                ? `No activity for ${Math.round(idle / 1000)}s`
                : `Exceeded ${Math.round(total / 1000)}s`,
        };
        return;
      }
      throw e;
    } finally {
      clearTimeout(totalTimer);
      clearTimeout(idleTimer);
      message.signal?.removeEventListener('abort', onCaller);
    }
  }

  async cancel(agent: AgentRef, taskId: string): Promise<void> {
    const { client } = await this.clientFor(agent);
    try {
      await client.cancelTask(CancelTaskRequest.fromJSON({ id: taskId }), {
        signal: AbortSignal.timeout(this.o.requestTimeoutMs ?? 10_000),
      });
    } catch (e) {
      throw this.fail(e, agent, 'cancelling the task');
    }
  }

  async getTask(agent: AgentRef, taskId: string): Promise<TaskSnapshot | undefined> {
    const { client } = await this.clientFor(agent);
    try {
      const t = await client.getTask(GetTaskRequest.fromJSON({ id: taskId }), {
        signal: AbortSignal.timeout(this.o.requestTimeoutMs ?? 10_000),
      });
      return snapshot(taskToWire(t));
    } catch (e) {
      if (isTaskNotFound(e)) return undefined;
      throw this.fail(e, agent, 'reading the task');
    }
  }

  async listTasks(
    agent: AgentRef,
    query: TaskListQuery = {},
  ): Promise<{ tasks: TaskSnapshot[]; nextPageToken?: string }> {
    const { client } = await this.clientFor(agent);
    try {
      const res = await client.listTasks(
        ListTasksRequest.fromJSON({
          ...(query.contextId ? { contextId: query.contextId } : {}),
          ...(query.state ? { status: WIRE_STATE[query.state] } : {}),
          ...(query.pageSize ? { pageSize: query.pageSize } : {}),
          ...(query.pageToken ? { pageToken: query.pageToken } : {}),
          includeArtifacts: true,
        }),
        { signal: AbortSignal.timeout(this.o.requestTimeoutMs ?? 10_000) },
      );
      return {
        tasks: res.tasks.map((t) => snapshot(taskToWire(t))),
        ...(res.nextPageToken ? { nextPageToken: res.nextPageToken } : {}),
      };
    } catch (e) {
      throw this.fail(e, agent, 'listing tasks');
    }
  }

  async *subscribe(
    agent: AgentRef,
    taskId: string,
    opts: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): AsyncGenerator<GatewayEvent> {
    const total = opts.timeoutMs ?? this.o.defaultTimeoutMs ?? 30 * 60_000;
    const idle = this.o.inactivityMs ?? 15 * 60_000;
    const ctl = new AbortController();
    const stop = () => ctl.abort();
    let idleTimer = setTimeout(stop, idle);
    const totalTimer = setTimeout(stop, total);
    opts.signal?.addEventListener('abort', stop, { once: true });
    if (opts.signal?.aborted) stop();
    const st: DecodeState = { assembler: new ArtifactAssembler() };
    try {
      const { client } = await this.clientFor(agent);
      try {
        for await (const sr of client.resubscribeTask(
          SubscribeToTaskRequest.fromJSON({ id: taskId }),
          {
            signal: ctl.signal,
          },
        )) {
          clearTimeout(idleTimer);
          idleTimer = setTimeout(stop, idle);
          const wire = streamToWire(sr);
          if (wire) yield* decodeEvent(wire, st);
        }
      } catch (e) {
        // Our own stop (caller left, or a timer) ends the generator quietly; the caller reconciles with `getTask`.
        if (ctl.signal.aborted) return;
        if (isTaskNotFound(e))
          throw new GatewayError('task_not_found', `${agent.role} does not know task ${taskId}`);
        // A finished task cannot be subscribed to (A2A UnsupportedOperation); its final state is read instead.
        if (isUnsupportedOperation(e)) {
          const done = await this.getTask(agent, taskId);
          if (!done)
            throw new GatewayError('task_not_found', `${agent.role} does not know task ${taskId}`);
          yield* done.artifacts;
          yield {
            kind: 'state',
            state: done.state,
            taskId,
            ...(done.contextId ? { contextId: done.contextId } : {}),
            ...(done.text ? { text: done.text } : {}),
          };
          return;
        }
        throw this.fail(e, agent, 'following the task');
      }
      yield* st.assembler.flush();
    } finally {
      clearTimeout(totalTimer);
      clearTimeout(idleTimer);
      opts.signal?.removeEventListener('abort', stop);
    }
  }

  private clean(text: string): string {
    return redact(text, this.secretValues());
  }

  /** Turns whatever the SDK or the network threw into a `GatewayError`, with secrets removed from the text. */
  private fail(e: unknown, agent: AgentRef, doing: string): GatewayError {
    const chain: unknown[] = [];
    for (let c = e; c && chain.length < 6; c = (c as { cause?: unknown }).cause) chain.push(c);
    const clean = (t: string) => this.clean(t);
    const gw = chain.find((c): c is GatewayError => c instanceof GatewayError);
    if (gw && gw.code === 'unreachable')
      return new GatewayError(
        'unreachable',
        clean(`Cannot reach ${agent.role} at ${agent.url}: ${gw.message}`),
      );
    if (gw) return gw;
    const eg = chain.find((c): c is EgressError => c instanceof EgressError);
    if (eg)
      return new GatewayError(
        eg.code === 'too_large' ? 'too_large' : 'blocked',
        clean(`${agent.role}: ${eg.message}`),
        { reason: eg.code },
      );
    const tokenErr = chain.find((c): c is TokenError => c instanceof TokenError);
    if (tokenErr)
      return new GatewayError('unauthenticated', clean(`${agent.role}: ${tokenErr.message}`));
    const msg = e instanceof Error ? e.message : String(e);
    const http = /HTTP error[^:]*: (\d{3})/.exec(msg) ?? /Status: (\d{3})/.exec(msg);
    if (http)
      return new GatewayError(
        'http_error',
        clean(`${agent.role} answered HTTP ${http[1]}`),
        clean(msg),
      );
    const inStream = /\(Code: (-?\d+)\)/.exec(msg);
    if (inStream)
      return new GatewayError('rpc_error', clean(`${agent.role}: ${msg}`), {
        code: Number(inStream[1]),
        message: clean(msg),
      });
    const rpc = e as { code?: unknown; name?: string };
    if (typeof rpc.code === 'number' || /A2A|JsonRpc|Rest.*Error/.test(rpc.name ?? ''))
      return new GatewayError(
        'rpc_error',
        clean(`${agent.role}: ${msg}`),
        typeof rpc.code === 'number' ? { code: rpc.code, message: clean(msg) } : undefined,
      );
    if (/fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|socket|terminated|network/i.test(msg))
      return new GatewayError(
        'unreachable',
        clean(`Cannot reach ${agent.role} at ${agent.url}: ${msg}`),
      );
    return new GatewayError(
      'bad_response',
      clean(`${agent.role} returned an unreadable response during ${doing}: ${msg}`),
    );
  }
}

const WIRE_STATE: Record<string, WireTaskState | string> = {
  working: 'TASK_STATE_WORKING',
  completed: 'TASK_STATE_COMPLETED',
  failed: 'TASK_STATE_FAILED',
  canceled: 'TASK_STATE_CANCELED',
  input_required: 'TASK_STATE_INPUT_REQUIRED',
};

/** A task snapshot in the codec's plain shape → the port's `TaskSnapshot`. */
function snapshot(wire: Record<string, unknown>): TaskSnapshot {
  const st: DecodeState = { assembler: new ArtifactAssembler() };
  const events = decodeEvent(wire, st);
  const state = events.findLast((e) => e.kind === 'state');
  return {
    taskId: st.taskId ?? String(wire['id'] ?? ''),
    ...(st.contextId ? { contextId: st.contextId } : {}),
    state: state?.kind === 'state' ? state.state : 'working',
    ...(state?.kind === 'state' && state.text ? { text: state.text } : {}),
    artifacts: events.filter(
      (e): e is Extract<GatewayEvent, { kind: 'artifact' }> => e.kind === 'artifact',
    ),
  };
}

/** A2A `TaskNotFoundError` (-32001), however the transport reports it. */
function isTaskNotFound(e: unknown): boolean {
  const x = e as { code?: unknown; name?: string; message?: string };
  return (
    x?.code === -32001 ||
    /TaskNotFound/i.test(x?.name ?? '') ||
    /task not found|\(Code: -32001\)/i.test(x?.message ?? '')
  );
}

/** A2A `UnsupportedOperationError` (-32004): for `SubscribeToTask`, the task has already finished. */
function isUnsupportedOperation(e: unknown): boolean {
  const x = e as { code?: unknown; name?: string; message?: string };
  return (
    x?.code === -32004 ||
    /UnsupportedOperation/i.test(x?.name ?? '') ||
    /cannot be subscribed|\(Code: -32004\)/i.test(x?.message ?? '')
  );
}

const safeOrigin = (u: string): string => {
  try {
    return new URL(u).origin;
  } catch {
    return '';
  }
};

/** Rejects when `signal` aborts, so a slow card read cannot outlive its budget. */
function withSignal<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const on = () => reject(signal.reason);
    signal.addEventListener('abort', on, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener('abort', on));
  });
}
