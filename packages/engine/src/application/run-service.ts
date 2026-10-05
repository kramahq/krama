import type { ActorRef, CreateRun, PhaseOutcome, Run } from '@kramahq/contract';
import { DomainError } from '../domain/errors.js';
import type { DomainEvent } from '../domain/events.js';
import { evaluate } from '../domain/evaluator-loop.js';
import { assertBackendAllowed, requiredGatesAfter } from '../domain/invariants.js';
import { transitionPhase } from '../domain/phase-machine.js';
import { transitionRun, type RunTrigger } from '../domain/run-machine.js';
import type { RunRecord } from '../ports/index.js';
import {
  SYSTEM,
  audit,
  findPhase,
  loadRun,
  nowIso,
  phaseEvent,
  publish,
  runEvent,
  type Ctx,
} from './context.js';
import {
  completeIfDone,
  gateDecision,
  reopenForLoop,
  downstream,
  startReadyPhases,
} from './run-ops.js';

const DEFAULT_MAX_LOOPS = 2;
const DEFAULT_DELEGATION = 'native' as const;

export class RunService {
  constructor(private readonly c: Ctx) {}

  /** Creates a run in `planning`. Idempotent per key. */
  async create(
    cmd: CreateRun,
    actor: ActorRef,
    opts: { idempotencyKey?: string } = {},
  ): Promise<Run> {
    const { c } = this;
    const pack = await c.p.packs.get(cmd.packId);
    if (!pack)
      throw new DomainError('not_found', `Pack ${cmd.packId} not found`, { packId: cmd.packId });
    const orch = {
      ...(c.policy.defaultOrchestrator ?? {
        definitionId: 'orchestrator/default',
        backend: 'a2a-claude',
      }),
      ...cmd.orchestrator,
      delegation: cmd.orchestrator?.delegation ?? c.policy.defaultDelegation ?? DEFAULT_DELEGATION,
    } as Run['orchestrator'];
    assertBackendAllowed(orch.backend, c.policy.allowedBackends);

    const created = await c.p.store.transaction(async (tx) => {
      if (opts.idempotencyKey) {
        const prior = await tx.runs.findByIdempotencyKey(opts.idempotencyKey);
        if (prior) return { run: prior.value.run, fresh: false };
      }
      const now = nowIso(c);
      const run: Run = {
        id: c.p.ids.next('run'),
        title: cmd.title ?? cmd.input.text?.slice(0, 80) ?? pack.name,
        input: cmd.input,
        pack: { id: pack.id, version: pack.version, sha: pack.source.sha },
        ...(cmd.projectId ? { projectId: cmd.projectId } : {}),
        ...(cmd.workItem ? { workItem: cmd.workItem } : {}),
        status: 'planning',
        mode: cmd.mode ?? 'review',
        orchestrator: orch,
        budget: {
          max: { amount: cmd.budget?.max ?? c.policy.defaultBudgetUsd ?? 40, currency: 'USD' },
          spent: null,
          warnAtPct: 80,
          onExceed: 'pause',
        },
        currentPhaseIds: [],
        pendingDecisions: 0,
        trigger: { type: 'manual' },
        labels: cmd.labels ?? [],
        createdBy: actor,
        createdAt: now,
        updatedAt: now,
        links: {},
        phases: pack.methodology.phases.map((t) => ({
          id: t.id,
          label: t.label,
          ...(t.kind ? { kind: t.kind } : {}),
          agentRoles: t.roles,
          dependsOn: t.dependsOn,
          ...(t.parallel ? { parallel: true } : {}),
          status: 'pending' as const,
          iteration: 0,
        })),
      };
      await tx.runs.put({
        run,
        loops: {},
        ...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
      });
      await audit(c, tx, actor, 'run.created', { type: 'run', id: run.id });
      return { run, fresh: true };
    });
    // After the commit: the event log may use its own connection, and a rolled-back run must not announce itself.
    if (created.fresh) await publish(c, [runEvent(created.run, 'run.created')], actor);
    return created.run;
  }

  /** `planning → running`; starts the phases that have no dependencies. */
  async plan(runId: string): Promise<Run> {
    const { c } = this;
    return this.mutate(runId, SYSTEM, (rec) => {
      const run = rec.run;
      run.status = transitionRun(run.status, 'plan_ok');
      run.startedAt = nowIso(c);
      const started = startReadyPhases(run, nowIso(c));
      return [
        runEvent(run, 'run.planned', { phases: (run.phases ?? []).map((p) => p.id) }),
        ...started,
      ];
    });
  }

  /** Parks a run that cannot continue without a person (e.g. the orchestrator gave up). Resumable. */
  block(runId: string, reason: string, actor: ActorRef = SYSTEM): Promise<Run> {
    return this.mutate(runId, actor, (rec) => {
      rec.run.status = transitionRun(rec.run.status, 'block');
      rec.run.statusReason = reason;
      return [runEvent(rec.run, 'run.updated')];
    });
  }

  /** Ends a run as failed (unrecoverable). */
  fail(runId: string, reason: string, actor: ActorRef = SYSTEM): Promise<Run> {
    return this.mutate(runId, actor, (rec) => {
      rec.run.status = transitionRun(rec.run.status, 'fail');
      rec.run.statusReason = reason;
      rec.run.endedAt = nowIso(this.c);
      return [runEvent(rec.run, 'run.failed')];
    });
  }

  pause(runId: string, actor: ActorRef): Promise<Run> {
    return this.control(runId, actor, 'pause', 'run.updated', 'Paused');
  }
  resume(runId: string, actor: ActorRef): Promise<Run> {
    return this.control(runId, actor, 'resume', 'run.updated');
  }
  async stop(runId: string, actor: ActorRef, reason?: string): Promise<Run> {
    return this.control(runId, actor, 'stop', 'run.stopped', reason ?? 'Stopped');
  }

  /** On engine start: runs left `running` are marked `interrupted` (durable state makes resuming safe). */
  async markInterrupted(): Promise<string[]> {
    const { c } = this;
    const { items } = await c.p.store.runs.list({ status: ['running', 'planning'] });
    const ids: string[] = [];
    for (const { value } of items) {
      await this.mutate(value.run.id, SYSTEM, (rec) => {
        rec.run.status = transitionRun(rec.run.status, 'interrupt');
        rec.run.statusReason = 'Engine restarted; resume to continue';
        return [runEvent(rec.run, 'run.updated')];
      });
      ids.push(value.run.id);
    }
    return ids;
  }

  /**
   * Records the evaluator/orchestrator's verdict for an active phase and applies it:
   * accept (gate or advance), revise (loop with an engine-enforced cap), skip downstream, or halt.
   */
  async recordPhaseOutcome(
    runId: string,
    phaseId: string,
    outcome: PhaseOutcome,
    opts: { human?: boolean } = {},
  ): Promise<Run> {
    const { c } = this;
    return this.mutate(runId, SYSTEM, async (rec, tx) => {
      const run = rec.run;
      const phase = findPhase(run, phaseId);
      if (phase.status !== 'active')
        throw new DomainError(
          'invalid_transition',
          `Phase ${phaseId} is ${phase.status}, not active`,
          { phaseId },
        );
      phase.outcome = outcome;
      const events: DomainEvent[] = [phaseEvent(run, 'phase.outcome', phase, { outcome })];

      const roles = new Map((run.phases ?? []).map((p) => [p.id, p.agentRoles]));
      const target = outcome.loopTarget ?? phaseId;
      const pack = await c.p.packs.get(run.pack.id);
      const rule = pack?.methodology.evaluators.find(
        (r) =>
          (roles.get(phaseId) ?? []).includes(r.evaluator) &&
          (roles.get(target) ?? []).includes(r.producer),
      );
      const step = evaluate(new Map(Object.entries(rec.loops)), {
        phaseId,
        outcome,
        maxLoops: rule?.maxLoops ?? c.policy.defaultMaxLoops ?? DEFAULT_MAX_LOOPS,
        ...(opts.human ? { human: true } : {}),
      });
      rec.loops = Object.fromEntries(step.counts);

      const v = step.verdict;
      switch (v.action) {
        case 'accept':
          events.push(...(await this.completeOrGate(rec, phaseId, tx)));
          break;
        case 'revise':
          events.push(...reopenForLoop(run, phaseId, v.target, nowIso(c)));
          events.push(
            phaseEvent(run, 'phase.looped', findPhase(run, phaseId), {
              from: phaseId,
              to: v.target,
              iteration: v.iteration,
              ...(outcome.findings ? { findings: outcome.findings } : {}),
            }),
          );
          events.push(...startReadyPhases(run, nowIso(c)));
          break;
        case 'skip_downstream':
          for (const d of downstream(run, phaseId))
            if (d.status === 'pending') d.status = transitionPhase('pending', 'skip');
          events.push(...(await this.completeOrGate(rec, phaseId, tx)));
          break;
        case 'halt': {
          phase.status = transitionPhase(phase.status, 'fail');
          phase.endedAt = nowIso(c);
          run.status = transitionRun(run.status, 'block');
          run.statusReason = v.reason;
          events.push(
            phaseEvent(run, 'phase.failed', phase, { reason: v.reason }),
            runEvent(run, 'run.updated'),
          );
          break;
        }
      }
      return events;
    });
  }

  /** After an accepted phase: raise the methodology's required gates, or complete and move on. */
  private async completeOrGate(
    rec: RunRecord,
    phaseId: string,
    tx: import('../ports/index.js').Store,
  ): Promise<DomainEvent[]> {
    const { c } = this;
    const run = rec.run;
    const phase = findPhase(run, phaseId);
    const pack = await c.p.packs.get(run.pack.id);
    const gates = pack ? requiredGatesAfter(pack.methodology, phaseId, { mode: run.mode }) : [];
    const events: DomainEvent[] = [];
    if (gates.length > 0) {
      phase.status = transitionPhase(phase.status, 'await_decision');
      run.status = transitionRun(run.status, 'await_decision');
      for (const g of gates) {
        const rec2 = gateDecision(c, run, phase, g);
        await tx.decisions.put(rec2);
        events.push({
          type: 'decision.requested',
          subject: { type: 'decision', id: rec2.decision.id },
          runId: run.id,
          data: { kind: rec2.decision.kind, title: rec2.decision.title },
        });
      }
      run.pendingDecisions += gates.length;
      events.push(
        phaseEvent(run, 'phase.outcome', phase, { awaiting: gates.map((g) => g.label) }),
        runEvent(run, 'run.updated'),
      );
      return events;
    }
    phase.status = transitionPhase(phase.status, 'complete');
    phase.endedAt = nowIso(c);
    events.push(phaseEvent(run, 'phase.completed', phase));
    events.push(...startReadyPhases(run, nowIso(c)), ...completeIfDone(run, nowIso(c)));
    return events;
  }

  private control(
    runId: string,
    actor: ActorRef,
    trigger: RunTrigger,
    type: 'run.updated' | 'run.stopped',
    reason?: string,
  ): Promise<Run> {
    return this.mutate(runId, actor, async (rec, tx) => {
      const run = rec.run;
      run.status = transitionRun(run.status, trigger);
      if (trigger === 'resume') delete run.statusReason;
      else if (reason) run.statusReason = reason;
      const events: DomainEvent[] = [];
      if (trigger === 'stop') {
        run.endedAt = nowIso(this.c);
        for (const { value } of (await tx.decisions.list({ runId, status: ['pending'] })).items) {
          await tx.decisions.put(
            {
              ...value,
              decision: { ...value.decision, status: 'canceled', resolvedAt: nowIso(this.c) },
            },
            (await tx.decisions.get(value.decision.id))?.version,
          );
        }
        run.pendingDecisions = 0;
      }
      events.push(runEvent(run, type));
      await audit(this.c, tx, actor, `run.${trigger}`, { type: 'run', id: runId });
      return events;
    });
  }

  /** Loads, mutates, bumps `updatedAt`, saves with the optimistic version, then publishes the events. */
  async mutate(
    runId: string,
    actor: ActorRef,
    fn: (
      rec: RunRecord,
      tx: import('../ports/index.js').Store,
    ) => DomainEvent[] | Promise<DomainEvent[]>,
  ): Promise<Run> {
    const { c } = this;
    const { run, events } = await c.p.store.transaction(async (tx) => {
      const cur = await loadRun(tx, runId);
      const rec: RunRecord = structuredClone(cur.value);
      const evs = await fn(rec, tx);
      rec.run.updatedAt = nowIso(c);
      await tx.runs.put(rec, cur.version);
      return { run: rec.run, events: evs };
    });
    await publish(c, events, actor);
    return run;
  }
}
