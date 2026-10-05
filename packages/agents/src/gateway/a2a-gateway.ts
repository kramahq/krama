import type { AgentGateway, AgentRef, GatewayEvent, SendMessage } from '@kramahq/engine';
import {
  ArtifactAssembler,
  decodeEvent,
  isTerminal,
  sseResults,
  type DecodeState,
} from './codec.js';

export class GatewayError extends Error {
  constructor(
    readonly code: 'unreachable' | 'http_error' | 'rpc_error' | 'bad_response',
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'GatewayError';
  }
}

export interface GatewayOptions {
  fetch?: typeof fetch;
  /** Total time one delegation may take. Long media jobs pass a larger `timeoutMs` per call. Default 30 min. */
  defaultTimeoutMs?: number;
  /** Abort when the agent goes silent this long (any event resets it). Default 15 min. */
  inactivityMs?: number;
  /** Path of the JSON-RPC endpoint. Wrappers mount it at `/a2a/jsonrpc`. */
  jsonRpcPath?: string;
}

let rpcId = 0;
const newMessageId = () =>
  `msg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

/**
 * `AgentGateway` over A2A JSON-RPC (`message/stream`, falling back to `message/send`). Speaks the 0.3 method
 * names, which every wrapper still serves next to 1.0 (decision D8; the 1.0 binding is W7 behind this class).
 */
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
  private readonly doFetch: typeof fetch;
  private readonly path: string;
  constructor(private readonly o: GatewayOptions = {}) {
    this.doFetch = o.fetch ?? fetch;
    this.path = o.jsonRpcPath ?? '/a2a/jsonrpc';
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
    const params = {
      message: {
        messageId: newMessageId(),
        role: 'user',
        parts: [{ kind: 'text', text: message.text }],
        ...(message.contextId ? { contextId: message.contextId } : {}),
        ...(message.correlation ? { metadata: correlationMetadata(message.correlation) } : {}),
      },
      // Older wrappers read the context from here; harmless for the rest.
      configuration: { ...(message.contextId ? { contextId: message.contextId } : {}) },
    };
    let rpcError: { code?: number; message: string } | undefined;
    let sawTerminal = false;
    try {
      let res: Response;
      try {
        res = await this.post(agent, 'message/stream', params, ctl.signal, true);
      } catch (e) {
        if (ctl.signal.aborted) throw e;
        throw new GatewayError(
          'unreachable',
          `Cannot reach ${agent.role} at ${agent.url}: ${(e as Error).message}`,
        );
      }
      if (!res.ok)
        throw new GatewayError(
          'http_error',
          `${agent.role} answered HTTP ${res.status}`,
          await res.text().catch(() => ''),
        );

      if ((res.headers.get('content-type') ?? '').includes('text/event-stream') && res.body) {
        for await (const ev of sseResults(res.body, (e) => (rpcError = e))) {
          bump();
          for (const g of decodeEvent(ev, st)) {
            if (g.kind === 'state' && isTerminal(g.state)) sawTerminal = true;
            yield g;
          }
        }
      } else {
        // The agent answered with plain JSON (no streaming): treat the body as a final task or message.
        const body = (await res.json().catch(() => undefined)) as
          Record<string, unknown> | undefined;
        const err = body?.error as { code?: number; message?: string } | undefined;
        if (err)
          rpcError = {
            ...(err.code !== undefined ? { code: err.code } : {}),
            message: err.message ?? 'A2A error',
          };
        else if (body?.result && typeof body.result === 'object') {
          for (const g of decodeEvent(body.result as Record<string, unknown>, st)) {
            if (g.kind === 'state' && isTerminal(g.state)) sawTerminal = true;
            yield g;
          }
        } else
          throw new GatewayError('bad_response', `${agent.role} returned an unreadable response`);
      }
      if (rpcError)
        throw new GatewayError('rpc_error', `${agent.role}: ${rpcError.message}`, rpcError);
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
    const res = await this.post(
      agent,
      'tasks/cancel',
      { id: taskId },
      AbortSignal.timeout(10_000),
      false,
    );
    await res.text().catch(() => undefined);
  }

  private post(
    agent: AgentRef,
    method: string,
    params: unknown,
    signal: AbortSignal,
    sse: boolean,
  ): Promise<Response> {
    return this.doFetch(`${agent.url}${this.path}`, {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        ...(sse ? { accept: 'text/event-stream' } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
    });
  }
}
