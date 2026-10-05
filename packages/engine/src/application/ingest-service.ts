import { sidebandActivity, type AgentSignal } from '../domain/signals.js';
import type { BudgetService } from './budget-service.js';
import { publish, type Ctx } from './context.js';

/** Who reported, and over which channel. */
export interface IngestSubject {
  runId: string;
  agent: { id: string; role: string; backend: string };
  phaseId?: string;
  stepId?: string;
  channel: 'a2a' | 'http';
}

/**
 * The one place agent signals enter the platform. The A2A stream and the HTTP event sink both end here, so an
 * agent's activity looks the same whichever way it was reported: `activity.*` events on the run and usage accounted
 * against the run (per step and phase when known). Cost is provider-reported or `null`.
 */
export class IngestService {
  constructor(
    private readonly c: Ctx,
    private readonly budget: BudgetService,
  ) {}

  async ingest(subject: IngestSubject, signals: readonly AgentSignal[]): Promise<void> {
    for (const s of signals) {
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
