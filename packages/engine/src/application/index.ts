import { BudgetService } from './budget-service.js';
import type { Ctx, Policy } from './context.js';
import { DecisionService } from './decision-service.js';
import { IngestService } from './ingest-service.js';
import { RunService } from './run-service.js';
import { StepService } from './step-service.js';
import type { Ports } from '../ports/index.js';

export * from './context.js';
export { RunService, type RunPatch } from './run-service.js';
export { DecisionService, type ResolveCommand } from './decision-service.js';
export { BudgetService, type UsageReport } from './budget-service.js';
export { IngestService, type IngestSubject } from './ingest-service.js';
export { StepService, type DelegateInput, type DelegateResult } from './step-service.js';

export interface Engine {
  runs: RunService;
  decisions: DecisionService;
  budget: BudgetService;
  steps: StepService;
  /** The one entry for agent activity and usage, from both the A2A stream and the HTTP event sink. */
  ingest: IngestService;
}

/** Builds the use cases over a set of ports. Adapters implement the ports; the server wires them. */
export function createEngine(ports: Ports, policy: Policy = {}): Engine {
  const ctx: Ctx = { p: ports, policy };
  const budget = new BudgetService(ctx);
  const decisions = new DecisionService(ctx);
  return {
    runs: new RunService(ctx),
    decisions,
    budget,
    steps: new StepService(ctx, budget, decisions),
    ingest: new IngestService(ctx, budget),
  };
}
export * from './audit-writer.js';
