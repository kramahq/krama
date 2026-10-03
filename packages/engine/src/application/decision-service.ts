import type { ActorRef, Decision, Run } from '@kramahq/contract';
import {
  openDecision,
  resolve,
  type DecisionRecord,
  type EffectKind,
  type OpenDecision,
} from '../domain/decision.js';
import { DomainError } from '../domain/errors.js';
import type { DomainEvent } from '../domain/events.js';
import { assertCanAdvance } from '../domain/invariants.js';
import { transitionPhase } from '../domain/phase-machine.js';
import { transitionRun } from '../domain/run-machine.js';
import type { RunRecord, Store } from '../ports/index.js';
import { audit, findPhase, nowIso, phaseEvent, publish, runEvent, type Ctx } from './context.js';
import { completeIfDone, reopenForLoop, startReadyPhases } from './run-ops.js';

export interface ResolveCommand {
  optionId: string;
  input?: string;
  scope?: 'once' | 'project';
}

export class DecisionService {
  constructor(private readonly c: Ctx) {}

  /** Raises a decision (input, budget, access, …). If it blocks a running run, the run waits. */
  async request(input: OpenDecision): Promise<Decision> {
    const { c } = this;
    const { record, events } = await c.p.store.transaction(async (tx) => {
      const record = openDecision(input);
      const events: DomainEvent[] = [];
      const runId = record.decision.runId;
      if (runId) {
        const cur = await tx.runs.get(runId);
        if (!cur) throw new DomainError('not_found', `Run ${runId} not found`);
        const rec: RunRecord = structuredClone(cur.value);
        if (rec.run.status === 'running')
          rec.run.status = transitionRun(rec.run.status, 'await_decision');
        rec.run.pendingDecisions += 1;
        rec.run.updatedAt = nowIso(c);
        await tx.runs.put(rec, cur.version);
        events.push(runEvent(rec.run, 'run.updated'));
      }
      await tx.decisions.put(record);
      events.unshift({
        type: 'decision.requested',
        subject: { type: 'decision', id: record.decision.id },
        ...(runId ? { runId } : {}),
        data: { kind: record.decision.kind, title: record.decision.title },
      });
      return { record, events };
    });
    await publish(c, events);
    return record.decision;
  }

  /** Resolves a decision and applies its effect. First resolve wins; the executor is always told. */
  async resolve(decisionId: string, cmd: ResolveCommand, by: ActorRef): Promise<Decision> {
    const { c } = this;
    const out = await c.p.store.transaction(async (tx) => {
      const cur = await tx.decisions.get(decisionId);
      if (!cur)
        throw new DomainError('not_found', `Decision ${decisionId} not found`, { decisionId });
      const at = nowIso(c);
      const res = resolve(cur.value, {
        optionId: cmd.optionId,
        ...(cmd.input ? { input: cmd.input } : {}),
        by,
        at,
      });
      await tx.decisions.put(res.record, cur.version);
      const events: DomainEvent[] = [];
      const d = res.record.decision;
      if (!res.settled) {
        events.push({
          type: 'run.updated',
          subject: { type: 'decision', id: d.id },
          ...(d.runId ? { runId: d.runId } : {}),
          data: { approvals: d.approvals?.length ?? 0, need: d.need },
        });
        return { decision: d, events, effect: undefined as EffectKind | undefined };
      }
      await audit(
        c,
        tx,
        by,
        'decision.resolved',
        { type: 'decision', id: d.id },
        { optionId: cmd.optionId, effect: res.effect },
      );
      events.push({
        type: 'decision.resolved',
        subject: { type: 'decision', id: d.id },
        ...(d.runId ? { runId: d.runId } : {}),
        data: { kind: d.kind, optionId: cmd.optionId, title: d.title },
      });
      events.push(...(await this.applyEffect(tx, res.record, res.effect, cmd, by)));
      return { decision: d, events, effect: res.effect };
    });
    await publish(c, out.events, by);
    if (out.effect && out.decision.runId && c.p.executor) {
      await c.p.executor.onDecisionResolved({
        runId: out.decision.runId,
        decisionId: out.decision.id,
        effect: out.effect,
        optionId: cmd.optionId,
        ...(cmd.input ? { input: cmd.input } : {}),
      });
    }
    return out.decision;
  }

  /** Expires pending decisions past their deadline, honouring `onTimeout`. */
  async sweepExpired(): Promise<string[]> {
    const { c } = this;
    const now = nowIso(c);
    const { items } = await c.p.store.decisions.list({ status: ['pending'] });
    const done: string[] = [];
    for (const { value } of items) {
      const d = value.decision;
      if (!d.deadline || d.deadline > now) continue;
      const auto =
        d.onTimeout === 'auto_approve'
          ? d.options.find((o) => value.effects[o.id] === 'advance')
          : d.onTimeout === 'auto_reject'
            ? d.options.find((o) => value.effects[o.id] === 'halt')
            : undefined;
      if (auto)
        await this.resolve(
          d.id,
          { optionId: auto.id },
          { type: 'system', id: 'timeout', name: 'Timeout' },
        );
      else await this.expire(d.id);
      done.push(d.id);
    }
    return done;
  }

  async expire(decisionId: string): Promise<Decision> {
    const { c } = this;
    const out = await c.p.store.transaction(async (tx) => {
      const cur = await tx.decisions.get(decisionId);
      if (!cur) throw new DomainError('not_found', `Decision ${decisionId} not found`);
      if (cur.value.decision.status !== 'pending')
        throw new DomainError(
          'decision_resolved',
          `Decision ${decisionId} is already ${cur.value.decision.status}`,
        );
      const next: DecisionRecord = {
        ...cur.value,
        decision: { ...cur.value.decision, status: 'expired', resolvedAt: nowIso(c) },
      };
      await tx.decisions.put(next, cur.version);
      const d = next.decision;
      const events: DomainEvent[] = [
        {
          type: 'decision.expired',
          subject: { type: 'decision', id: d.id },
          ...(d.runId ? { runId: d.runId } : {}),
          data: { kind: d.kind },
        },
      ];
      if (d.runId) {
        const run = await tx.runs.get(d.runId);
        if (run && run.value.run.status === 'awaiting_decision') {
          const rec: RunRecord = structuredClone(run.value);
          rec.run.status = transitionRun(rec.run.status, 'block');
          rec.run.statusReason = `Decision expired: ${d.title}`;
          rec.run.pendingDecisions = Math.max(0, rec.run.pendingDecisions - 1);
          await tx.runs.put(rec, run.version);
          events.push(runEvent(rec.run, 'run.updated'));
        }
      }
      return { d, events };
    });
    await publish(c, out.events);
    return out.d;
  }

  // ---- effects -------------------------------------------------------------

  private async pendingFor(
    tx: Store,
    runId: string,
    exceptId: string,
    phaseId?: string,
  ): Promise<DecisionRecord[]> {
    const { items } = await tx.decisions.list({ runId, status: ['pending'] });
    return items
      .map((i) => i.value)
      .filter(
        (r) =>
          r.decision.id !== exceptId && (phaseId === undefined || r.decision.phaseId === phaseId),
      );
  }

  private async cancelOthers(
    tx: Store,
    runId: string,
    exceptId: string,
    phaseId?: string,
  ): Promise<number> {
    const others = await this.pendingFor(tx, runId, exceptId, phaseId);
    for (const o of others) {
      const cur = await tx.decisions.get(o.decision.id);
      await tx.decisions.put(
        { ...o, decision: { ...o.decision, status: 'canceled', resolvedAt: nowIso(this.c) } },
        cur?.version,
      );
    }
    return others.length;
  }

  private async applyEffect(
    tx: Store,
    rec: DecisionRecord,
    effect: EffectKind,
    cmd: ResolveCommand,
    by: ActorRef,
  ): Promise<DomainEvent[]> {
    const { c } = this;
    const d = rec.decision;

    if (effect === 'accept_memory' || effect === 'reject_memory') {
      const memId = d.subject?.id;
      const cur = memId ? await c.p.memory?.get(memId) : undefined;
      if (cur && c.p.memory) {
        const status = effect === 'accept_memory' ? 'active' : 'rejected';
        await c.p.memory.put(
          { ...cur.value, status, updatedAt: nowIso(c), version: cur.value.version + 1 },
          cur.version,
        );
        return [
          {
            type: status === 'active' ? 'memory.accepted' : 'memory.rejected',
            subject: { type: 'memory', id: cur.value.id },
            data: { recordId: cur.value.id, scope: cur.value.scope },
          },
        ];
      }
      return [];
    }
    if (!d.runId) return [];

    const cur = await tx.runs.get(d.runId);
    if (!cur) throw new DomainError('not_found', `Run ${d.runId} not found`);
    const r: RunRecord = structuredClone(cur.value);
    const run = r.run;
    const events: DomainEvent[] = [];
    const now = nowIso(c);
    const othersForRun = async () => (await this.pendingFor(tx, run.id, d.id)).length;
    const resume = async () => {
      run.pendingDecisions = await othersForRun();
      if (run.status === 'awaiting_decision' && run.pendingDecisions === 0) {
        run.status = transitionRun(run.status, 'decision_resolved');
        delete run.statusReason;
      }
    };
    const advance = async () => {
      const phase = d.phaseId ? findPhase(run, d.phaseId) : undefined;
      if (phase && phase.status === 'awaiting_decision') {
        const siblings = await this.pendingFor(tx, run.id, d.id, phase.id);
        if (siblings.length === 0) {
          const pack = await c.p.packs.get(run.pack.id);
          if (pack) {
            // Safety net: a required gate can never be skipped, whatever the orchestrator did.
            const resolved = (
              await tx.decisions.list({ runId: run.id, status: ['resolved'] })
            ).items.map((i) => i.value);
            const approved = new Map<string, boolean>();
            for (const x of [...resolved, rec])
              if (
                x.decision.phaseId === phase.id &&
                x.decision.resolution &&
                (x.effects[x.decision.resolution.optionId] === 'advance' ||
                  x.effects[x.decision.resolution.optionId] === 'advance_autopilot')
              )
                approved.set(x.decision.title, true);
            assertCanAdvance(pack.methodology, phase.id, { mode: run.mode }, approved);
          }
          phase.status = transitionPhase(phase.status, 'approve');
          phase.endedAt = now;
          events.push(phaseEvent(run, 'phase.completed', phase));
          await resume();
          if (run.status === 'running')
            events.push(...startReadyPhases(run, now), ...completeIfDone(run, now));
          return;
        }
      }
      await resume();
    };

    switch (effect) {
      case 'advance_autopilot':
        run.mode = 'autopilot';
        await advance();
        break;
      case 'advance':
        await advance();
        break;
      case 'loop_back': {
        const phase = d.phaseId ? findPhase(run, d.phaseId) : undefined;
        if (phase && phase.status === 'awaiting_decision') {
          await this.cancelOthers(tx, run.id, d.id, phase.id);
          phase.status = transitionPhase(phase.status, 'revise');
          phase.iteration += 1;
          delete phase.outcome;
          events.push(
            phaseEvent(run, 'phase.looped', phase, {
              from: phase.id,
              to: phase.id,
              human: true,
              ...(cmd.input ? { feedback: cmd.input } : {}),
            }),
          );
        } else if (phase) {
          events.push(...reopenForLoop(run, phase.id, phase.id, now));
        }
        await resume();
        break;
      }
      case 'halt': {
        await this.cancelOthers(tx, run.id, d.id);
        const phase = d.phaseId ? run.phases?.find((p) => p.id === d.phaseId) : undefined;
        if (phase && phase.status === 'awaiting_decision')
          phase.status = transitionPhase(phase.status, 'fail');
        run.status = transitionRun(
          run.status === 'awaiting_decision' ? 'awaiting_decision' : run.status,
          'stop',
        );
        run.statusReason = `Rejected: ${d.title}`;
        run.endedAt = now;
        run.pendingDecisions = 0;
        events.push(runEvent(run, 'run.stopped'));
        break;
      }
      case 'raise_cap': {
        const asNumber = Number(cmd.input);
        run.budget.max = {
          amount:
            Number.isFinite(asNumber) && asNumber > 0
              ? asNumber
              : Math.ceil(run.budget.max.amount * (c.policy.raiseFactor ?? 1.5)),
          currency: 'USD',
        };
        r.warned = false;
        await resume();
        break;
      }
      case 'continue_capped':
        r.capWaived = true;
        await resume();
        break;
      case 'grant_once':
      case 'grant_project':
      case 'deny':
        await audit(
          c,
          tx,
          by,
          effect === 'deny' ? 'access.denied' : 'access.granted',
          { type: 'decision', id: d.id },
          {
            ...(d.access ? { path: d.access.path, agent: d.access.agent } : {}),
            scope: effect === 'grant_project' ? 'project' : 'once',
          },
        );
        await resume();
        break;
      case 'answer':
        for (const s of await tx.steps.listByRun(run.id)) {
          if (s.status === 'input_required' && (!d.phaseId || s.phaseId === d.phaseId))
            await tx.steps.put({ ...s, status: 'working' }, (await tx.steps.get(s.id))?.version);
        }
        await resume();
        break;
      default:
        await resume();
    }

    run.updatedAt = now;
    await tx.runs.put(r, cur.version);
    events.push(runEvent(run, 'run.updated'));
    return events;
  }
}

export type { Run };
