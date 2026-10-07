import type {
  ActorRef,
  AuditActor,
  DelegationMode,
  EventEnvelope,
  Phase,
  Run,
} from '@kramahq/contract';
import { DomainError } from '../domain/errors.js';
import type { DomainEvent } from '../domain/events.js';
import type { Ports, RunRecord, Store, TranscriptWrite, Versioned } from '../ports/index.js';

/** Platform policy the engine enforces regardless of orchestrator quality. */
export interface Policy {
  /** Empty or undefined = no restriction. */
  allowedBackends?: readonly string[];
  /** Cap for automated evaluator loops when the pack names none (legacy default: 2). */
  defaultMaxLoops?: number;
  defaultBudgetUsd?: number;
  defaultOrchestrator?: { definitionId: string; backend: string; model?: string };
  /** How orchestrators reach their workers when the run does not say. Default `native`. */
  defaultDelegation?: DelegationMode;
  /** Budget raise multiplier when a person raises the cap without giving a number. */
  raiseFactor?: number;
}

export const SYSTEM: ActorRef = { type: 'system', id: 'engine', name: 'Engine' };

export interface Ctx {
  p: Ports;
  policy: Policy;
}

export const nowIso = (c: Ctx): string => c.p.clock.now().toISOString();

/** Appends domain events to the log and notifies; call after the transaction commits. */
export async function publish(
  c: Ctx,
  events: DomainEvent[],
  actor?: ActorRef,
): Promise<EventEnvelope[]> {
  const out: EventEnvelope[] = [];
  for (const e of events) {
    // A question put to a person (a gate, a budget cap, the orchestrator's own) is on record, in full, before anyone can see
    // it. The id is the same whichever path opened it, so a request already recorded by its caller is not recorded twice.
    if (e.type === 'decision.requested' && e.runId && c.p.transcript) {
      const d = await c.p.store.decisions.get(e.subject.id);
      if (d)
        await transcribe(c, {
          runId: e.runId,
          actor: actor ? auditActorOf(actor) : { type: 'system', id: 'engine' },
          kind: 'decision.requested',
          source: 'system',
          sourceEventId: `decision.requested:${e.subject.id}`,
          decisionId: e.subject.id,
          ...(d.value.decision.phaseId ? { phaseId: d.value.decision.phaseId } : {}),
          payload: { decision: d.value.decision },
        });
    }
    const env = await c.p.events.append({
      type: e.type,
      subject: e.subject,
      ...(e.runId ? { runId: e.runId as EventEnvelope['runId'] } : {}),
      ...(actor ? { actor } : {}),
      data: e.data,
    });
    out.push(env);
    if (e.type === 'decision.requested' || e.type === 'budget.exceeded')
      await c.p.notifier.notify(env);
  }
  return out;
}

export async function audit(
  c: Ctx,
  tx: Store,
  actor: ActorRef,
  action: string,
  subject: { type: string; id: string },
  detail?: Record<string, unknown>,
): Promise<void> {
  await tx.audit.append({
    id: c.p.ids.next('aud'),
    at: nowIso(c),
    actor,
    action,
    subject,
    ...(detail ? { detail } : {}),
  });
}

export async function loadRun(tx: Store, id: string): Promise<Versioned<RunRecord>> {
  const r = await tx.runs.get(id);
  if (!r) throw new DomainError('not_found', `Run ${id} not found`, { id });
  return r;
}

export const findPhase = (run: Run, phaseId: string): Phase => {
  const p = run.phases?.find((x) => x.id === phaseId);
  if (!p)
    throw new DomainError('unknown_phase', `Phase ${phaseId} not found in run ${run.id}`, {
      phaseId,
    });
  return p;
};

export const phaseEvent = (
  run: Run,
  type: DomainEvent['type'],
  phase: Phase,
  extra: Record<string, unknown> = {},
): DomainEvent => ({
  type,
  subject: { type: 'phase', id: phase.id },
  runId: run.id,
  data: { phaseId: phase.id, iteration: phase.iteration, ...extra },
});

export const runEvent = (
  run: Run,
  type: DomainEvent['type'],
  extra: Record<string, unknown> = {},
): DomainEvent => ({
  type,
  subject: { type: 'run', id: run.id },
  runId: run.id,
  data: {
    status: run.status,
    ...(run.statusReason ? { statusReason: run.statusReason } : {}),
    ...extra,
  },
});

/** A contract actor as the audit record names it. A schedule acts as the system. */
export const auditActorOf = (a: ActorRef): AuditActor => ({
  type: a.type === 'schedule' ? 'system' : a.type,
  id: a.id,
});

/**
 * Writes an entry of a run's transcript, if a transcript is configured. Call it **before** the thing it records is
 * published or acted on, so what a person sees is never ahead of what is on record. It does not throw (the recorder
 * counts a failure and the run goes on) unless the recorder was made strict.
 */
export async function transcribe(c: Ctx, w: TranscriptWrite): Promise<void> {
  await c.p.transcript?.record(w);
}
