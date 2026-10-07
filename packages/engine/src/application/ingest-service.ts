import type { AuditActor } from '@kramahq/contract';
import { sidebandActivity, type AgentSignal } from '../domain/signals.js';
import type { BudgetService } from './budget-service.js';
import { publish, transcribe, type Ctx } from './context.js';

/** Who reported, and over which channel. */
export interface IngestSubject {
  runId: string;
  agent: { id: string; role: string; backend: string };
  phaseId?: string;
  stepId?: string;
  channel: 'a2a' | 'http';
}

/** What came with the signals, kept in the transcript as it arrived. */
export interface IngestMeta {
  /** The sender's own id for the event; a second delivery with the same one is recorded once. */
  eventId?: string;
  /** When the sender says it happened. */
  at?: string;
  traceId?: string;
  /** The event exactly as it was received, with its envelope. */
  wire?: unknown;
}

const KIND: Record<string, string> = {
  tool_call: 'tool.call',
  tool_result: 'tool.result',
  thinking: 'thinking',
  message: 'message.agent',
  status: 'status',
};

const LIFECYCLE: Record<string, 'started' | 'finished' | 'error'> = {
  agent_started: 'started',
  agent_finished: 'finished',
  agent_error: 'error',
};

/**
 * Writes one agent signal to the run's transcript in full: the text and the raw payload as the agent sent them, not the
 * shortened form the activity feed shows. Used by every path an agent's activity can take into the platform.
 */
export async function recordSignal(
  c: Ctx,
  subject: IngestSubject,
  s: AgentSignal,
  meta: IngestMeta = {},
): Promise<void> {
  if (!c.p.transcript) return;
  const actor: AuditActor = {
    type: subject.agent.role === 'orchestrator' ? 'orchestrator' : 'agent',
    id: subject.agent.id,
    instanceId: subject.agent.id,
    role: subject.agent.role,
  };
  const wireType = (meta.wire as { eventType?: unknown } | undefined)?.eventType;
  const lifecycle = typeof wireType === 'string' ? LIFECYCLE[wireType] : undefined;
  const common = {
    runId: subject.runId,
    actor,
    source: subject.channel === 'http' ? ('http-sink' as const) : ('a2a-stream' as const),
    ...(meta.eventId ? { sourceEventId: `evt:${meta.eventId}` } : {}),
    ...(meta.at ? { at: meta.at } : {}),
    ...(subject.phaseId ? { phaseId: subject.phaseId } : {}),
    ...(subject.stepId ? { stepId: subject.stepId } : {}),
    observe: {
      agentId: subject.agent.id,
      role: subject.agent.role,
      channel: subject.channel === 'http' ? ('sink' as const) : ('stream' as const),
      ...(meta.traceId ? { traceId: meta.traceId } : {}),
      ...(lifecycle ? { lifecycle } : {}),
    },
  };
  if (s.kind === 'usage') {
    await transcribe(c, {
      ...common,
      kind: 'usage',
      payload: {
        usage: s.usage,
        cost: s.cost,
        ...(meta.wire !== undefined ? { wire: meta.wire } : {}),
      },
    });
    return;
  }
  await transcribe(c, {
    ...common,
    kind: KIND[s.type] ?? 'status',
    payload: {
      type: s.type,
      ...(s.toolName ? { toolName: s.toolName } : {}),
      ...(s.isError !== undefined ? { isError: s.isError } : {}),
      ...(s.durationMs !== undefined ? { durationMs: s.durationMs } : {}),
      ...(s.text !== undefined ? { text: s.text } : {}),
      ...(s.raw !== undefined ? { raw: s.raw } : {}),
      ...(meta.wire !== undefined ? { wire: meta.wire } : {}),
    },
  });
}

/**
 * The one place agent signals enter the platform. The A2A stream and the HTTP event sink both end here, so an
 * agent's activity looks the same whichever way it was reported: `activity.*` events on the run and usage accounted
 * against the run (per step and phase when known). Cost is provider-reported or `null`. Every signal is written to the
 * run's transcript first, in full (write-ahead), and only then shown or counted.
 */
export class IngestService {
  constructor(
    private readonly c: Ctx,
    private readonly budget: BudgetService,
  ) {}

  async ingest(
    subject: IngestSubject,
    signals: readonly AgentSignal[],
    meta: IngestMeta = {},
  ): Promise<void> {
    // One wire event can become several signals (a finish with its usage): each keeps the event id, told apart by position.
    let i = 0;
    for (const s of signals) {
      const n = i++;
      await recordSignal(this.c, subject, s, {
        ...meta,
        ...(meta.eventId && signals.length > 1 ? { eventId: `${meta.eventId}#${n}` } : {}),
      });
      if (s.kind === 'usage') {
        await this.budget.record({
          runId: subject.runId,
          ...(subject.phaseId ? { phaseId: subject.phaseId } : {}),
          ...(subject.stepId ? { stepId: subject.stepId } : {}),
          cost: s.cost,
          usage: s.usage,
          agent: subject.agent,
        });
        continue;
      }
      const a = sidebandActivity(s);
      await publish(this.c, [
        {
          type: a.type,
          subject: { type: 'agent', id: subject.agent.id },
          runId: subject.runId,
          data: {
            ...(subject.stepId ? { stepId: subject.stepId } : {}),
            ...(subject.phaseId ? { phaseId: subject.phaseId } : {}),
            agent: subject.agent,
            channel: subject.channel,
            ...a.data,
          },
        },
      ]);
    }
  }
}
