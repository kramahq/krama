import { AgentCard, CancelTaskRequest, SendMessageRequest } from '@a2a-js/sdk';
import {
  ClientFactory,
  DefaultAgentCardResolver,
  JsonRpcTransportFactory,
  RestTransportFactory,
  type Client,
} from '@a2a-js/sdk/client';
import type { AgentGateway, AgentRef, GatewayEvent, SendMessage } from '@kramahq/engine';
import { reportCard, type CardReport } from './card-report.js';
import { ArtifactAssembler, decodeEvent, isTerminal, type DecodeState } from './codec.js';
import {
  EXTERNAL_EGRESS,
  EgressError,
  MANAGED_EGRESS,
  createSafeFetch,
  redact,
  type EgressPolicy,
} from './egress.js';
import { dropMalformedSseFrames } from './sse.js';
import { streamToWire } from './wire.js';

export class GatewayError extends Error {
  constructor(
    readonly code:
      'unreachable' | 'http_error' | 'rpc_error' | 'bad_response' | 'blocked' | 'too_large',
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
  /** How long a fetched agent card is trusted before it is read again. Default 5 min. */
  cardTtlMs?: number;
  /** Budget for the calls that are not a delegation: reading a card, cancelling. Default 10 s. */
  requestTimeoutMs?: number;
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
  private readonly clients = new Map<string, { client: Client; card: AgentCard; at: number }>();
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

  /** The SDK client for an agent, built from its card (`supportedInterfaces`) and cached for a while. */
  private async clientFor(agent: AgentRef): Promise<{ client: Client; card: AgentCard }> {
    const key = `${agent.external ? 'x' : 'm'}|${agent.url}`;
    const hit = this.clients.get(key);
    if (hit && Date.now() - hit.at < (this.o.cardTtlMs ?? 5 * 60_000)) return hit;

    const policy = this.policy(agent);
    const fetchImpl = this.guardedFetch(
      createSafeFetch({ policy, credentialsFor: this.credentialsFor }),
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
    const entry = { client, card, at: Date.now() };
    this.clients.set(key, entry);
    return entry;
  }

  /** Network failures from the safe fetch become typed errors before the SDK can wrap them. */
  private guardedFetch(inner: typeof fetch): typeof fetch {
    return async (input, init) => {
      try {
        const res = await inner(input, init);
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
          if (c instanceof EgressError) throw c;
        throw new GatewayError('unreachable', (e as Error).message, { cause: e });
      }
    };
  }

  /** Describes an agent's card: what it advertises, which interface is used, what would get in the way. Advisory. */
  async inspect(agent: AgentRef): Promise<CardReport> {
    const { card, client } = await this.clientFor(agent);
    const url = (client.transport as unknown as { endpoint?: string }).endpoint;
    return reportCard(card, url);
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
    try {
      const { client } = await this.clientFor(agent);
      const request = SendMessageRequest.fromJSON({
        message: {
          messageId: newMessageId(),
          role: 'ROLE_USER',
          parts: [{ text: message.text, mediaType: 'text/plain' }],
          ...(message.contextId ? { contextId: message.contextId } : {}),
          ...(message.correlation ? { metadata: correlationMetadata(message.correlation) } : {}),
        },
        configuration: { returnImmediately: false },
      });
      try {
        for await (const sr of client.sendMessageStream(request, { signal: ctl.signal })) {
          bump();
          const wire = streamToWire(sr);
          if (!wire) continue;
          for (const g of decodeEvent(wire, st)) {
            if (g.kind === 'state' && isTerminal(g.state)) sawTerminal = true;
            yield g;
          }
        }
      } catch (e) {
        if (ctl.signal.aborted) throw e;
        throw this.fail(e, agent, 'the delegation');
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
        if (st.taskId) await this.cancel(agent, st.taskId).catch(() => undefined);
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

  /** Turns whatever the SDK or the network threw into a `GatewayError`, with secrets removed from the text. */
  private fail(e: unknown, agent: AgentRef, doing: string): GatewayError {
    const chain: unknown[] = [];
    for (let c = e; c && chain.length < 6; c = (c as { cause?: unknown }).cause) chain.push(c);
    const clean = (t: string) => redact(t, this.secrets);
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
