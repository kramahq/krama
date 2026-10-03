import type { DecisionKind, GateRule, Methodology, Money, Run, Spend } from '@kramahq/contract';
import { DomainError } from './errors.js';

// ---- Budget ----------------------------------------------------------------

export type BudgetStatus = 'ok' | 'warn' | 'exceeded' | 'unknown';

/** `unknown` when spend is not reported: the platform cannot enforce what it cannot measure. */
export function budgetStatus(max: Money, spent: Spend, warnAtPct: number): BudgetStatus {
  if (spent === null) return 'unknown';
  if (spent.amount >= max.amount) return 'exceeded';
  return max.amount > 0 && (spent.amount / max.amount) * 100 >= warnAtPct ? 'warn' : 'ok';
}

export type BudgetAction = 'none' | 'warn' | 'pause' | 'stop';

/** What the engine must do after spend changes. Independent of the orchestrator. */
export function budgetAction(budget: Run['budget']): BudgetAction {
  switch (budgetStatus(budget.max, budget.spent, budget.warnAtPct)) {
    case 'exceeded':
      return budget.onExceed;
    case 'warn':
      return 'warn';
    default:
      return 'none';
  }
}

export function assertWithinBudget(budget: Run['budget']): void {
  if (budgetStatus(budget.max, budget.spent, budget.warnAtPct) === 'exceeded') {
    throw new DomainError('budget_exceeded', 'Run budget cap reached', {
      max: budget.max.amount,
      spent: budget.spent?.amount,
    });
  }
}

// ---- Allowed backends ------------------------------------------------------

/** `undefined` or empty list means no restriction. */
export function assertBackendAllowed(
  backend: string,
  allowed: readonly string[] | undefined,
): void {
  if (allowed && allowed.length > 0 && !allowed.includes(backend)) {
    throw new DomainError('backend_not_allowed', `Backend ${backend} is not allowed`, {
      backend,
      allowed: [...allowed],
    });
  }
}

// ---- Gates -----------------------------------------------------------------

/** In autopilot, review gates are auto-approved; approvals, budget, access and consent still need a human. */
const AUTOPILOT_SKIPS: readonly DecisionKind[] = ['review'];

export interface GateContext {
  mode: Run['mode'];
  /** For `conditional` gates: whether the condition currently holds. Unknown is treated as required. */
  conditionMet?: (rule: GateRule) => boolean;
}

export function gateRequired(rule: GateRule, ctx: GateContext): boolean {
  if (rule.policy === 'auto') return false;
  if (ctx.mode === 'autopilot' && AUTOPILOT_SKIPS.includes(rule.kind)) return false;
  if (rule.policy === 'conditional') return ctx.conditionMet ? ctx.conditionMet(rule) : true;
  return true;
}

export const requiredGatesAfter = (m: Methodology, phaseId: string, ctx: GateContext): GateRule[] =>
  m.gates.filter((g) => g.afterPhase === phaseId && gateRequired(g, ctx));

/** A phase's resolved gate decisions, keyed by gate label, saying whether each was approved. */
export type GateApprovals = ReadonlyMap<string, boolean>;

/** A required gate can never be skipped: advancing past a phase needs every required gate approved. */
export function assertCanAdvance(
  m: Methodology,
  phaseId: string,
  ctx: GateContext,
  approved: GateApprovals,
): void {
  const missing = requiredGatesAfter(m, phaseId, ctx).filter((g) => approved.get(g.label) !== true);
  if (missing.length > 0) {
    throw new DomainError(
      'gate_required',
      `Gate required after ${phaseId}: ${missing.map((g) => g.label).join(', ')}`,
      { phaseId, gates: missing.map((g) => g.label) },
    );
  }
}
