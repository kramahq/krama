import type { EventType, Usage } from '@kramahq/contract';
import type { GatewayEvent } from '../ports/index.js';

/**
 * What an agent reports about its own work, in one shape. Both channels end up here: the A2A stream the gateway reads
 * (`trace.*` artifacts and the final `x-usage`) and the HTTP event sink (`AgentEvent`). Everything downstream, the
 * event log, the activity feed and cost, only ever sees these.
 */
export type Sideband = Extract<GatewayEvent, { kind: 'sideband' }>;
export type UsageSignal = Extract<GatewayEvent, { kind: 'usage' }>;
export type AgentSignal = Sideband | UsageSignal;

/** Payload sizes kept in events; the full content is in artifacts, not the activity feed. */
export const MAX_TEXT = 4000;
const MAX_RAW = 2000;
export const clip = (s: string | undefined, n: number): string | undefined =>
  s && s.length > n ? `${s.slice(0, n)}… (${s.length - n} more)` : s;
export const rawJson = (v: unknown): string | undefined => {
  if (v === undefined) return undefined;
  try {
    return clip(JSON.stringify(v), MAX_RAW);
  } catch {
    return undefined;
  }
};

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : undefined;
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

/** The activity event type and payload for a sideband signal. The one mapping for every channel. */
export function sidebandActivity(e: Sideband): { type: EventType; data: Record<string, unknown> } {
  const type: EventType =
    e.type === 'tool_call'
      ? 'activity.tool_call'
      : e.type === 'tool_result'
        ? 'activity.tool_result'
        : e.type === 'message'
          ? 'activity.message'
          : 'activity.status';
  return {
    type,
    data: {
      kind: e.type,
      ...(e.toolName ? { toolName: e.toolName } : {}),
      ...(e.isError !== undefined ? { isError: e.isError } : {}),
      ...(e.durationMs !== undefined ? { durationMs: e.durationMs } : {}),
      ...(e.text ? { text: clip(e.text, MAX_TEXT) } : {}),
      ...(rawJson(e.raw) ? { raw: rawJson(e.raw) } : {}),
    },
  };
}

/**
 * A wrapper's token and billing summary (`metadata["x-usage"]`, or the usage of an `agent_finished` event) as contract
 * units. `cost` is a provider billing weight, never USD.
 */
export function mapUsageSummary(x: unknown): { usage: Usage[] } | undefined {
  const u = obj(x);
  if (!u) return undefined;
  const usage: Usage[] = [];
  const add = (unit: Usage['unit'], v: unknown) => {
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) usage.push({ unit, quantity: v });
  };
  add(
    'tokens',
    (Number(u.inputTokens) || 0) + (Number(u.outputTokens) || 0) + (Number(u.reasoningTokens) || 0),
  );
  add('calls', u.llmCalls);
  add('credits', u.cost);
  return { usage };
}

/** The envelope the wrapper POSTs to its event sink. Fields are optional because a sink must tolerate any wrapper version. */
export interface AgentEventWire {
  eventId?: string;
  eventType?: string;
  agentId?: string;
  agentName?: string;
  traceId?: string;
  parentAgentId?: string | null;
  timestamp?: string;
  data?: unknown;
  /** The caller's correlation context, once the wrapper stamps it (a2a-wrapper#49). */
  propagated_metadata?: unknown;
}

/** The run a wrapper says an event belongs to, from the caller's correlation context. Provisional until the wrapper fixes the field. */
export function correlationRunId(w: AgentEventWire): string | undefined {
  const meta = obj(w.propagated_metadata) ?? obj(obj(w.data)?.propagated_metadata);
  return str(meta?.run_id) ?? str(meta?.runId);
}

/**
 * One wrapper event as agent signals. Known types map to the same sideband kinds the A2A channel produces; a type this
 * version does not know is kept as a status event with its raw data, never dropped.
 */
export function signalsOfAgentEvent(w: AgentEventWire): AgentSignal[] {
  const data = obj(w.data) ?? {};
  const type = str(w.eventType) ?? 'unknown';
  const tool = str(data.toolName) ?? str(data.name);
  switch (type) {
    case 'tool_call_start':
      return [
        {
          kind: 'sideband',
          type: 'tool_call',
          ...(tool ? { toolName: tool } : {}),
          text: tool ?? 'tool call',
          raw: data,
        },
      ];
    case 'tool_call_end':
      return [
        {
          kind: 'sideband',
          type: 'tool_result',
          ...(tool ? { toolName: tool } : {}),
          ...(typeof data.isError === 'boolean' ? { isError: data.isError } : {}),
          ...(num(data.durationMs) !== undefined ? { durationMs: num(data.durationMs)! } : {}),
          text: tool ?? 'tool result',
          raw: data,
        },
      ];
    case 'thinking':
      return [
        {
          kind: 'sideband',
          type: 'thinking',
          text: str(data.text) ?? str(data.thought) ?? str(data.content) ?? '',
          raw: data,
        },
      ];
    case 'agent_finished': {
      const out: AgentSignal[] = [
        {
          kind: 'sideband',
          type: 'status',
          text: 'agent finished',
          raw: { eventType: type, ...data },
        },
      ];
      // Cost is a provider-reported billing weight (`credits`); USD stays "not reported".
      const used = mapUsageSummary(data.usage ?? (data.cost !== undefined ? data : undefined));
      if (used && used.usage.length > 0) out.push({ kind: 'usage', usage: used.usage, cost: null });
      return out;
    }
    case 'agent_error':
      return [
        {
          kind: 'sideband',
          type: 'status',
          text: str(data.message) ?? str(data.error) ?? 'agent error',
          isError: true,
          raw: { eventType: type, ...data },
        },
      ];
    default:
      return [
        {
          kind: 'sideband',
          type: 'status',
          text: type.replace(/_/g, ' '),
          raw: { eventType: type, ...data },
        },
      ];
  }
}
