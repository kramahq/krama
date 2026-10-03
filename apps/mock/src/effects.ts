import type { Decision, ResolveDecision, Run } from '@kramahq/contract';
import type { EventBus } from './bus.js';
import { ProblemError } from './problems.js';
import type { MockState } from './state.js';

const ME = { type: 'user' as const, id: 'u_priya', name: 'Priya' };
const nowIso = () => new Date().toISOString();

const pendingFor = (s: MockState, runId: string) =>
  s.decisions.filter((d) => d.runId === runId && d.status === 'pending').length;

export function touchRun(
  s: MockState,
  bus: EventBus,
  run: Run,
  type = 'run.updated',
  data: Record<string, unknown> = {},
): void {
  run.updatedAt = nowIso();
  run.pendingDecisions = pendingFor(s, run.id);
  bus.emit(
    type,
    { type: 'run', id: run.id },
    { status: run.status, statusReason: run.statusReason, ...data },
    run.id,
  );
}

const advance = (s: MockState, bus: EventBus, run: Run): void => {
  const phases = run.phases ?? [];
  const i = phases.findIndex((p) => ['awaiting_decision', 'active', 'looping'].includes(p.status));
  if (i >= 0) {
    const p = phases[i]!;
    p.status = 'completed';
    p.outcome = { status: 'success', reason: `${p.label} validated`, gating: 'continue' };
    bus.emit(
      'phase.completed',
      { type: 'phase', id: p.id },
      { phaseId: p.id, iteration: p.iteration },
      run.id,
    );
    const next = phases[i + 1];
    if (next) {
      next.status = 'active';
      next.iteration = 1;
      run.currentPhaseIds = [next.id];
      run.status = 'running';
      delete run.statusReason;
      bus.emit(
        'phase.started',
        { type: 'phase', id: next.id },
        { phaseId: next.id, iteration: 1 },
        run.id,
      );
      touchRun(s, bus, run);
      return;
    }
  }
  run.status = 'completed';
  run.currentPhaseIds = [];
  run.endedAt = nowIso();
  touchRun(s, bus, run, 'run.completed');
};

const loopBack = (s: MockState, bus: EventBus, run: Run, feedback?: string): void => {
  const p = (run.phases ?? []).find((x) =>
    ['awaiting_decision', 'active', 'looping'].includes(x.status),
  );
  if (p) {
    p.status = 'active';
    p.iteration += 1;
    delete p.outcome;
    bus.emit(
      'phase.looped',
      { type: 'phase', id: p.id },
      { from: p.id, to: p.id, iteration: p.iteration, ...(feedback ? { feedback } : {}) },
      run.id,
    );
  }
  run.status = 'running';
  delete run.statusReason;
  touchRun(s, bus, run);
};

/** Applies a decision resolution and its effect on the run, memory and events. First resolve wins. */
export function resolveDecision(
  s: MockState,
  bus: EventBus,
  d: Decision,
  body: ResolveDecision,
): Decision {
  if (d.status !== 'pending')
    throw new ProblemError(
      'decision_resolved',
      'Decision already resolved',
      `Decision ${d.id} is ${d.status}`,
    );
  const option = d.options.find((o) => o.id === body.optionId);
  if (!option)
    throw new ProblemError('validation_failed', 'Unknown option', undefined, [
      { field: 'optionId', message: `Expected one of ${d.options.map((o) => o.id).join(', ')}` },
    ]);
  if (option.input?.required && !body.input?.trim()) {
    throw new ProblemError('validation_failed', 'Input required', undefined, [
      { field: 'input', message: `${option.input.label} is required` },
    ]);
  }

  const approving = d.kind === 'approval' || d.kind === 'review';
  const positive = ['approve', 'autopilot'].includes(option.id);
  if (approving && positive && d.need > 1) {
    d.approvals = [...(d.approvals ?? []), { optionId: option.id, by: ME, at: nowIso() }];
    if (d.approvals.length < d.need) {
      const run = s.runs.find((r) => r.id === d.runId);
      bus.emit(
        'run.updated',
        { type: 'decision', id: d.id },
        { approvals: d.approvals.length, need: d.need },
        run?.id,
        ME,
      );
      return d;
    }
  }

  d.status = 'resolved';
  d.resolvedAt = nowIso();
  d.resolution = {
    optionId: option.id,
    ...(body.input ? { input: body.input } : {}),
    by: ME,
    at: d.resolvedAt,
  };
  bus.emit(
    'decision.resolved',
    { type: 'decision', id: d.id },
    { kind: d.kind, optionId: option.id, title: d.title },
    d.runId,
    ME,
  );
  s.audit.unshift({
    id: `aud_${s.seq}`,
    at: d.resolvedAt,
    actor: ME,
    action: 'decision.resolved',
    subject: { type: 'decision', id: d.id },
  });

  const run = s.runs.find((r) => r.id === d.runId);
  switch (d.kind) {
    case 'memory': {
      const rec = s.memory.find((m) => m.id === d.subject?.id);
      if (rec) {
        rec.status = option.id === 'accept' ? 'active' : 'rejected';
        bus.emit(
          option.id === 'accept' ? 'memory.accepted' : 'memory.rejected',
          { type: 'memory', id: rec.id },
          { recordId: rec.id, scope: rec.scope },
        );
      }
      if (run) touchRun(s, bus, run);
      break;
    }
    case 'consent':
      break;
    case 'budget':
      if (run) {
        if (option.id === 'raise') {
          run.budget.max = { amount: 40, currency: 'USD' };
          run.status = 'running';
          touchRun(s, bus, run);
        } else if (option.id === 'stop') {
          run.status = 'stopped';
          run.statusReason = 'Stopped at budget decision';
          run.endedAt = nowIso();
          touchRun(s, bus, run, 'run.stopped');
        } else {
          run.status = 'running';
          touchRun(s, bus, run);
        }
      }
      break;
    case 'input':
    case 'access':
      if (run) {
        run.status = 'running';
        delete run.statusReason;
        const st = s.steps.find((x) => x.runId === run.id && x.status === 'input_required');
        if (st) st.status = 'working';
        touchRun(s, bus, run);
      }
      break;
    default:
      if (run) {
        if (option.id === 'autopilot') run.mode = 'autopilot';
        if (positive) advance(s, bus, run);
        else if (['reject', 'stop'].includes(option.id)) {
          run.status = 'stopped';
          run.statusReason = 'Rejected at gate';
          run.endedAt = nowIso();
          touchRun(s, bus, run, 'run.stopped');
        } else loopBack(s, bus, run, body.input);
      }
  }
  return d;
}

export function controlRun(
  s: MockState,
  bus: EventBus,
  run: Run,
  action: 'pause' | 'resume' | 'stop',
  reason?: string,
): Run {
  const from = run.status;
  const bad = (msg: string) => new ProblemError('conflict', msg, `Run ${run.id} is ${from}`);
  if (action === 'pause') {
    if (!['running', 'awaiting_decision', 'planning'].includes(from))
      throw bad('Run cannot be paused');
    run.status = 'paused';
    run.statusReason = 'Paused by you';
  } else if (action === 'resume') {
    if (!['paused', 'interrupted', 'blocked'].includes(from)) throw bad('Run cannot be resumed');
    run.status = 'running';
    delete run.statusReason;
  } else {
    if (['completed', 'failed', 'stopped'].includes(from)) throw bad('Run already ended');
    run.status = 'stopped';
    run.statusReason = reason ?? 'Stopped by you';
    run.endedAt = nowIso();
  }
  touchRun(s, bus, run, action === 'stop' ? 'run.stopped' : 'run.updated');
  return run;
}
