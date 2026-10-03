import type { ActorRef, Decision, DecisionKind, DecisionOption } from '@kramahq/contract';
import { DomainError } from './errors.js';

/** What the engine does when an option is chosen. Options may only offer effects the engine implements. */
export type EffectKind =
  | 'advance'
  | 'advance_autopilot'
  | 'loop_back'
  | 'halt'
  | 'answer'
  | 'raise_cap'
  | 'continue_capped'
  | 'grant_once'
  | 'grant_project'
  | 'deny'
  | 'accept_memory'
  | 'reject_memory'
  | 'proceed'
  | 'decline';

/** Effects that approve something and therefore count towards `need`. */
const POSITIVE: readonly EffectKind[] = [
  'advance',
  'advance_autopilot',
  'accept_memory',
  'proceed',
];
export const isPositive = (e: EffectKind): boolean => POSITIVE.includes(e);

/** Conventional option ids per decision kind and the effect each implements. */
export const DEFAULT_EFFECTS: Record<DecisionKind, Record<string, EffectKind>> = {
  approval: { approve: 'advance', reject: 'halt', hold: 'halt' },
  review: {
    approve: 'advance',
    autopilot: 'advance_autopilot',
    changes: 'loop_back',
    answer: 'loop_back',
    reject: 'halt',
  },
  input: {},
  budget: { raise: 'raise_cap', cap: 'continue_capped', stop: 'halt' },
  access: { allow_once: 'grant_once', allow_project: 'grant_project', deny: 'deny' },
  consent: { review: 'proceed', approve: 'proceed', decline: 'decline' },
  memory: { accept: 'accept_memory', reject: 'reject_memory' },
  publish: { approve: 'proceed', reject: 'decline' },
};

/** A decision plus the engine's private map of option id → effect. */
export interface DecisionRecord {
  decision: Decision;
  effects: Record<string, EffectKind>;
}

export interface OpenDecision {
  decision: Omit<Decision, 'status' | 'need' | 'approvals' | 'resolution' | 'resolvedAt'> & {
    need?: number;
  };
  /** Explicit effects for custom option ids. `input` decisions map every option to `answer` by default. */
  effects?: Record<string, EffectKind>;
}

/** Opens a decision. Every option must map to an effect the engine implements. */
export function openDecision({ decision, effects: custom = {} }: OpenDecision): DecisionRecord {
  const defaults = DEFAULT_EFFECTS[decision.kind];
  const effects: Record<string, EffectKind> = {};
  for (const o of decision.options) {
    const e = custom[o.id] ?? defaults[o.id] ?? (decision.kind === 'input' ? 'answer' : undefined);
    if (!e)
      throw new DomainError('invalid_option', `Option "${o.id}" has no engine effect`, {
        optionId: o.id,
        kind: decision.kind,
      });
    effects[o.id] = e;
  }
  if (decision.options.length === 0)
    throw new DomainError('invalid_option', 'A decision needs at least one option');
  return {
    decision: { ...decision, status: 'pending', need: Math.max(decision.need ?? 1, 1) },
    effects,
  };
}

export type Resolution =
  /** Enough approvals: the effect applies. */
  | { settled: true; effect: EffectKind; record: DecisionRecord }
  /** Approval recorded but more approvers are needed. */
  | { settled: false; remaining: number; record: DecisionRecord };

export interface ResolveInput {
  optionId: string;
  input?: string;
  by: ActorRef;
  at: string;
}

/**
 * Resolves a decision. Final once settled (first resolve wins). Positive options need `need`
 * distinct approvers; any negative option settles immediately.
 */
export function resolve(record: DecisionRecord, r: ResolveInput): Resolution {
  const d = record.decision;
  if (d.status !== 'pending')
    throw new DomainError('decision_resolved', `Decision ${d.id} is already ${d.status}`, {
      status: d.status,
    });
  const option: DecisionOption | undefined = d.options.find((o) => o.id === r.optionId);
  const effect = record.effects[r.optionId];
  if (!option || !effect)
    throw new DomainError('invalid_option', `Unknown option "${r.optionId}"`, {
      optionId: r.optionId,
    });
  if (option.input?.required && !r.input?.trim())
    throw new DomainError('input_required', `${option.input.label} is required`, {
      field: 'input',
    });

  if (isPositive(effect) && d.need > 1) {
    const approvals = d.approvals ?? [];
    if (approvals.some((a) => a.by.id === r.by.id))
      throw new DomainError('already_approved', `${r.by.id} already approved`, { by: r.by.id });
    const next = [...approvals, { optionId: r.optionId, by: r.by, at: r.at }];
    if (next.length < d.need) {
      return {
        settled: false,
        remaining: d.need - next.length,
        record: { ...record, decision: { ...d, approvals: next } },
      };
    }
    return settle(record, { ...d, approvals: next }, r, effect);
  }
  return settle(record, d, r, effect);
}

const settle = (
  record: DecisionRecord,
  d: Decision,
  r: ResolveInput,
  effect: EffectKind,
): Resolution => ({
  settled: true,
  effect,
  record: {
    ...record,
    decision: {
      ...d,
      status: 'resolved',
      resolvedAt: r.at,
      resolution: {
        optionId: r.optionId,
        ...(r.input ? { input: r.input } : {}),
        by: r.by,
        at: r.at,
      },
    },
  },
});

const close = (
  record: DecisionRecord,
  status: 'expired' | 'canceled',
  at: string,
): DecisionRecord => {
  if (record.decision.status !== 'pending')
    throw new DomainError(
      'decision_resolved',
      `Decision ${record.decision.id} is already ${record.decision.status}`,
    );
  return { ...record, decision: { ...record.decision, status, resolvedAt: at } };
};
export const expire = (record: DecisionRecord, at: string): DecisionRecord =>
  close(record, 'expired', at);
export const cancel = (record: DecisionRecord, at: string): DecisionRecord =>
  close(record, 'canceled', at);
