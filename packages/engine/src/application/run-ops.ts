import type { Decision, DecisionKind, GateRule, Pack, Phase, Run } from '@kramahq/contract';
import { openDecision, type DecisionRecord } from '../domain/decision.js';
import type { DomainEvent } from '../domain/events.js';
import { nextIteration, transitionPhase } from '../domain/phase-machine.js';
import { transitionRun } from '../domain/run-machine.js';
import type { RunRecord, Store } from '../ports/index.js';
import { phaseEvent, runEvent, type Ctx } from './context.js';

const DONE = ['completed', 'skipped'] as const;
const isDone = (p: Phase) => (DONE as readonly string[]).includes(p.status);

/** Phases that transitively depend on `phaseId`. */
export function downstream(run: Run, phaseId: string): Phase[] {
  const out = new Set<string>();
  const visit = (id: string) => {
    for (const p of run.phases ?? [])
      if (p.dependsOn.includes(id) && !out.has(p.id)) {
        out.add(p.id);
        visit(p.id);
      }
  };
  visit(phaseId);
  return (run.phases ?? []).filter((p) => out.has(p.id));
}

/** Starts phases whose dependencies are all done (also restarts `looping` phases once their producer finished). */
export function startReadyPhases(run: Run, now: string): DomainEvent[] {
  const events: DomainEvent[] = [];
  for (const p of run.phases ?? []) {
    if (p.status !== 'pending' && p.status !== 'looping') continue;
    const deps = p.dependsOn.map((id) => run.phases?.find((x) => x.id === id));
    if (!deps.every((d) => d && isDone(d))) continue;
    const trigger = p.status === 'pending' ? 'start' : 'restart';
    p.iteration = nextIteration(p.status, trigger, p.iteration);
    p.status = transitionPhase(p.status, trigger);
    p.startedAt = p.startedAt ?? now;
    delete p.outcome;
    events.push(phaseEvent(run, 'phase.started', p));
  }
  run.currentPhaseIds = (run.phases ?? [])
    .filter((p) => ['active', 'awaiting_decision', 'looping'].includes(p.status))
    .map((p) => p.id);
  return events;
}

/** Completes the run when every phase is done. */
export function completeIfDone(run: Run, now: string): DomainEvent[] {
  if (!run.phases || !run.phases.every(isDone) || run.status !== 'running') return [];
  run.status = transitionRun(run.status, 'complete');
  run.endedAt = now;
  run.currentPhaseIds = [];
  return [runEvent(run, 'run.completed')];
}

/** In `review` mode a pack without a methodology (no gates of its own) needs one person's approval before a run completes. */
export const needsFinalApproval = (rec: RunRecord, pack: Pack | undefined): boolean =>
  !!pack && !pack.methodology && rec.run.mode === 'review' && !rec.finalApproved;

/** The decision raised when every phase is done and the run is waiting for its final approval. */
export function finalApprovalDecision(c: Ctx, run: Run): DecisionRecord {
  return openDecision({
    decision: {
      id: c.p.ids.next('dec'),
      kind: 'approval',
      runId: run.id,
      title: 'Final approval',
      question: `Every phase of **${run.title}** is done. Approve to complete the run, or reject to stop it (the artifacts are kept).`,
      context: { artifacts: [] },
      options: [
        {
          id: 'approve',
          label: 'Approve and complete',
          style: 'primary',
          effect: 'Completes the run',
        },
        {
          id: 'reject',
          label: 'Reject',
          style: 'danger',
          input: { required: false, label: 'Reason', kind: 'text' },
          effect: 'Stops the run; artifacts are kept',
        },
      ],
      createdAt: c.p.clock.now().toISOString(),
      links: {},
    },
    effects: { approve: 'finalize' },
  });
}

/**
 * The only way a run ends successfully. When every phase is done it completes the run, except in `review` mode for a pack
 * without a methodology: there it raises the final approval first and the run waits for a person (the `finalize` effect
 * completes it). A methodology's own gates already did this job for the packs that still have one.
 */
export async function finishRun(
  c: Ctx,
  rec: RunRecord,
  tx: Store,
  pack: Pack | undefined,
  now: string,
): Promise<DomainEvent[]> {
  const run = rec.run;
  if (!run.phases || !run.phases.every(isDone) || run.status !== 'running') return [];
  if (!needsFinalApproval(rec, pack)) return completeIfDone(run, now);
  const decision = finalApprovalDecision(c, run);
  await tx.decisions.put(decision);
  run.status = transitionRun(run.status, 'await_decision');
  run.pendingDecisions += 1;
  run.currentPhaseIds = [];
  return [
    {
      type: 'decision.requested',
      subject: { type: 'decision', id: decision.decision.id },
      runId: run.id,
      data: { kind: decision.decision.kind, title: decision.decision.title },
    },
    runEvent(run, 'run.updated'),
  ];
}

/** Evaluator in a later phase sent work back: reset the loop target and everything downstream of it. */
export function reopenForLoop(
  run: Run,
  fromId: string,
  targetId: string,
  now: string,
): DomainEvent[] {
  const events: DomainEvent[] = [];
  const target = run.phases?.find((p) => p.id === targetId);
  const from = run.phases?.find((p) => p.id === fromId);
  if (!target || !from) return events;
  if (target.id === from.id) {
    from.status = transitionPhase(from.status, 'loop');
    from.iteration = nextIteration(from.status, 'restart', from.iteration);
    from.status = transitionPhase(from.status, 'restart');
    return events;
  }
  from.status = transitionPhase(from.status, 'loop');
  for (const d of downstream(run, target.id)) {
    if (d.id === from.id) continue;
    if (d.status === 'completed' || d.status === 'active') {
      d.status = 'pending';
      delete d.outcome;
    }
  }
  if (target.status === 'completed') {
    target.iteration = nextIteration('completed', 'reopen', target.iteration);
    target.status = transitionPhase('completed', 'reopen');
    delete target.outcome;
    target.endedAt = undefined;
    events.push(phaseEvent(run, 'phase.started', target, { reopened: true }));
  }
  void now;
  return events;
}

const GATE_OPTIONS: Partial<Record<DecisionKind, Decision['options']>> = {
  review: [
    {
      id: 'approve',
      label: 'Approve and continue',
      style: 'primary',
      effect: 'Continues to the next phase',
    },
    {
      id: 'changes',
      label: 'Request changes',
      style: 'neutral',
      input: { required: true, label: 'What should change?', kind: 'text' },
      effect: 'Re-runs this phase with your notes',
    },
    { id: 'reject', label: 'Reject', style: 'danger', effect: 'Stops the run; artifacts are kept' },
  ],
  approval: [
    { id: 'approve', label: 'Approve', style: 'primary', effect: 'Continues' },
    {
      id: 'reject',
      label: 'Reject',
      style: 'danger',
      input: { required: false, label: 'Reason', kind: 'text' },
      effect: 'Stops the run',
    },
  ],
};

/** Builds the decision a methodology gate raises after a phase. */
export function gateDecision(c: Ctx, run: Run, phase: Phase, gate: GateRule): DecisionRecord {
  const base = GATE_OPTIONS[gate.kind] ?? GATE_OPTIONS.approval!;
  const options =
    gate.kind === 'review' && run.mode === 'review'
      ? [
          ...base,
          {
            id: 'autopilot',
            label: 'Approve and switch to autopilot',
            style: 'neutral' as const,
            effect: 'Remaining review gates auto-approve',
          },
        ]
      : base;
  return openDecision({
    decision: {
      id: c.p.ids.next('dec'),
      kind: gate.kind,
      runId: run.id,
      phaseId: phase.id,
      title: gate.label,
      question: `**${phase.label}** is complete (${phase.outcome?.reason ?? 'ready'}). ${gate.label} is required before continuing.`,
      context: {
        artifacts: phase.artifactIds ?? [],
        ...(phase.outcome?.findings ? { findings: phase.outcome.findings } : {}),
      },
      options,
      ...(gate.need ? { need: gate.need } : {}),
      createdAt: c.p.clock.now().toISOString(),
      links: {},
    },
  });
}
