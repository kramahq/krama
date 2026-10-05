import type { ActorRef, Spend, Usage } from '@kramahq/contract';
import { addSpend, aggregateUsage } from '../domain/cost.js';
import type { DomainEvent } from '../domain/events.js';
import { budgetAction } from '../domain/invariants.js';
import { openDecision } from '../domain/decision.js';
import { transitionRun } from '../domain/run-machine.js';
import { SYSTEM, loadRun, nowIso, publish, runEvent, type Ctx } from './context.js';

export interface UsageReport {
  runId: string;
  phaseId?: string;
  stepId?: string;
  /** Provider-reported cost; `null` when the backend does not report it. */
  cost: Spend;
  usage?: Usage[];
  /** Who reported it, carried on the `cost.updated` event so cost can be shown per agent. */
  agent?: { id: string; role: string; backend: string };
}

/** Accumulates provider-reported spend and enforces the budget cap in the engine, not in prompts. */
export class BudgetService {
  constructor(private readonly c: Ctx) {}

  async record(r: UsageReport, actor: ActorRef = SYSTEM): Promise<void> {
    const { c } = this;
    const events = await c.p.store.transaction(async (tx) => {
      const cur = await loadRun(tx, r.runId);
      const rec = structuredClone(cur.value);
      const run = rec.run;
      const at = nowIso(c);
      await tx.usage.append({
        runId: r.runId,
        ...(r.phaseId ? { phaseId: r.phaseId } : {}),
        ...(r.stepId ? { stepId: r.stepId } : {}),
        at,
        cost: r.cost,
        usage: r.usage ?? [],
      });

      if (r.stepId) {
        const s = await tx.steps.get(r.stepId);
        if (s)
          await tx.steps.put(
            {
              ...s.value,
              cost: addSpend(s.value.cost ?? null, r.cost),
              usage: aggregateUsage([s.value.usage ?? [], r.usage ?? []]),
            },
            s.version,
          );
      }
      const phase = r.phaseId ? run.phases?.find((p) => p.id === r.phaseId) : undefined;
      if (phase) phase.cost = addSpend(phase.cost ?? null, r.cost);
      run.budget.spent = addSpend(run.budget.spent, r.cost);
      // Project scope is the main accumulation point (multi-project): spend rolls up, null stays "not reported".
      if (run.projectId) {
        const proj = await tx.projects.get(run.projectId);
        if (proj?.value.budget) {
          await tx.projects.put(
            {
              ...proj.value,
              budget: {
                ...proj.value.budget,
                spent: addSpend(proj.value.budget.spent ?? null, r.cost),
              },
            },
            proj.version,
          );
        }
      }
      run.updatedAt = at;

      const pct =
        run.budget.spent && run.budget.max.amount > 0
          ? Math.round((run.budget.spent.amount / run.budget.max.amount) * 100)
          : null;
      const events: DomainEvent[] = [
        {
          type: 'cost.updated',
          subject: { type: 'run', id: run.id },
          runId: run.id,
          data: {
            spent: run.budget.spent,
            percentUsed: pct,
            usage: r.usage ?? [],
            ...(r.agent ? { agent: r.agent } : {}),
          },
        },
      ];

      const action = rec.capWaived ? 'none' : budgetAction(run.budget);
      if (action === 'warn' && !rec.warned) {
        rec.warned = true;
        events.push({
          type: 'budget.threshold',
          subject: { type: 'run', id: run.id },
          runId: run.id,
          data: { scope: 'run', pct },
        });
      } else if (
        (action === 'pause' || action === 'stop') &&
        ['running', 'planning'].includes(run.status)
      ) {
        events.push({
          type: 'budget.exceeded',
          subject: { type: 'run', id: run.id },
          runId: run.id,
          data: { scope: 'run', pct, action },
        });
        if (action === 'stop') {
          run.status = transitionRun(run.status, 'stop');
          run.statusReason = 'Budget cap reached';
          run.endedAt = at;
          events.push(runEvent(run, 'run.stopped'));
        } else {
          const dec = openDecision({
            decision: {
              id: c.p.ids.next('dec'),
              kind: 'budget',
              runId: run.id,
              title: `Budget cap reached: raise it?`,
              question: `Spend is **$${run.budget.spent?.amount.toFixed(2)}** against a **$${run.budget.max.amount.toFixed(2)}** cap.`,
              options: [
                {
                  id: 'raise',
                  label: 'Raise the cap',
                  style: 'primary',
                  input: { required: false, label: 'New cap (USD)', kind: 'text' },
                  effect: 'Run continues',
                },
                {
                  id: 'cap',
                  label: 'Continue without a cap',
                  style: 'neutral',
                  effect: 'Budget enforcement is waived for this run',
                },
                {
                  id: 'stop',
                  label: 'Stop the run',
                  style: 'danger',
                  effect: 'Delivers what exists',
                },
              ],
              createdAt: at,
              links: {},
            },
          });
          await tx.decisions.put(dec);
          run.status = transitionRun(
            run.status === 'planning' ? 'planning' : 'running',
            run.status === 'planning' ? 'pause' : 'await_decision',
          );
          run.pendingDecisions += 1;
          events.push(
            {
              type: 'decision.requested',
              subject: { type: 'decision', id: dec.decision.id },
              runId: run.id,
              data: { kind: 'budget', title: dec.decision.title },
            },
            runEvent(run, 'run.updated'),
          );
        }
      }
      await tx.runs.put(rec, cur.version);
      return events;
    });
    await publish(c, events, actor);
  }
}
