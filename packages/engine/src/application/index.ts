import { BudgetService } from './budget-service.js';
import type { Ctx, Policy } from './context.js';
import { DecisionService } from './decision-service.js';
import { RunService } from './run-service.js';
import { StepService } from './step-service.js';
import type { Ports } from '../ports/index.js';

export * from './context.js';
export { RunService } from './run-service.js';
export { DecisionService, type ResolveCommand } from './decision-service.js';
export { BudgetService, type UsageReport } from './budget-service.js';
export { StepService, type DelegateInput, type DelegateResult } from './step-service.js';

export interface Engine {
  runs: RunService;
  decisions: DecisionService;
  budget: BudgetService;
  steps: StepService;
}

/** Builds the use cases over a set of ports. Adapters implement the ports; the server wires them. */
export function createEngine(ports: Ports, policy: Policy = {}): Engine {
  const ctx: Ctx = { p: ports, policy };
  const budget = new BudgetService(ctx);
  return {
    runs: new RunService(ctx),
    decisions: new DecisionService(ctx),
    budget,
    steps: new StepService(ctx, budget),
  };
}
