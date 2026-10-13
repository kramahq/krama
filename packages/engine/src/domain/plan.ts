import type { Phase } from '@kramahq/contract';
import { DomainError } from './errors.js';

/** The one phase a run has when its pack declares none and the orchestrator has not planned: the whole run. */
export const IMPLICIT_PHASE_ID = 'run';

export const PHASE_ID = /^[a-z][a-z0-9-]{0,39}$/;
export const MAX_PLAN_PHASES = 20;

/** One phase of the plan an orchestrator declares with `set_plan`. */
export interface PlanPhase {
  id: string;
  label: string;
  dependsOn?: readonly string[] | undefined;
}

/** A fresh, unstarted phase. */
export const newPhase = (p: PlanPhase): Phase => ({
  id: p.id,
  label: p.label,
  agentRoles: [],
  dependsOn: [...(p.dependsOn ?? [])],
  status: 'pending',
  iteration: 0,
});

/** The phase of a run that has no plan yet. */
export const implicitPhase = (): Phase => newPhase({ id: IMPLICIT_PHASE_ID, label: 'Run' });

const bad = (message: string, field = 'phases'): DomainError =>
  new DomainError('invalid_option', message, { errors: [{ field, message }] });

/** Shape rules for a plan: ids, labels, dependencies that exist, and no cycles. Throws `invalid_option` with the field. */
export function validatePlan(plan: readonly PlanPhase[]): void {
  if (plan.length === 0) throw bad('A plan needs at least one phase');
  if (plan.length > MAX_PLAN_PHASES) throw bad(`A plan has at most ${MAX_PLAN_PHASES} phases`);
  const ids = new Set<string>();
  plan.forEach((p, i) => {
    const at = `phases.${i}`;
    if (!PHASE_ID.test(p.id))
      throw bad(
        `"${p.id}" is not a phase id: use lowercase letters, digits and hyphens`,
        `${at}.id`,
      );
    if (ids.has(p.id)) throw bad(`Phase "${p.id}" appears twice`, `${at}.id`);
    ids.add(p.id);
    if (!p.label.trim() || p.label.length > 80)
      throw bad('A phase label is 1 to 80 characters', `${at}.label`);
  });
  plan.forEach((p, i) => {
    for (const dep of p.dependsOn ?? []) {
      if (dep === p.id)
        throw bad(`Phase "${p.id}" cannot depend on itself`, `phases.${i}.dependsOn`);
      if (!ids.has(dep))
        throw bad(
          `Phase "${p.id}" depends on "${dep}", which is not in the plan`,
          `phases.${i}.dependsOn`,
        );
    }
  });
  // A cycle would leave phases that can never start.
  const deps = new Map(plan.map((p) => [p.id, p.dependsOn ?? []]));
  const state = new Map<string, 1 | 2>();
  const visit = (id: string): void => {
    if (state.get(id) === 2) return;
    if (state.get(id) === 1) throw bad(`The plan has a dependency cycle through "${id}"`);
    state.set(id, 1);
    for (const d of deps.get(id) ?? []) visit(d);
    state.set(id, 2);
  };
  for (const id of ids) visit(id);
}

/** A phase a plan may drop or redefine: one that has not started, or the implicit one that only stood in for a plan. */
const replaceable = (p: Phase): boolean =>
  p.status === 'pending' ||
  (p.id === IMPLICIT_PHASE_ID && !['completed', 'skipped', 'failed'].includes(p.status));

/**
 * Merges a new plan into the phases a run has. A phase that has started or finished is history: it must stay in the plan
 * with the same dependencies (only its label may change), so a re-plan cannot rewrite what already happened.
 */
export function applyPlan(current: readonly Phase[], plan: readonly PlanPhase[]): Phase[] {
  const byId = new Map(current.map((p) => [p.id, p]));
  const inPlan = new Set(plan.map((p) => p.id));
  for (const p of current)
    if (!replaceable(p) && !inPlan.has(p.id))
      throw bad(`Phase "${p.id}" is already ${p.status} and must stay in the plan`);
  return plan.map((p) => {
    const have = byId.get(p.id);
    if (!have || replaceable(have)) return newPhase(p);
    const want = p.dependsOn ?? [];
    if (have.dependsOn.length !== want.length || !have.dependsOn.every((d) => want.includes(d)))
      throw bad(`Phase "${p.id}" has already started, so its dependencies cannot change`);
    return { ...have, label: p.label };
  });
}
