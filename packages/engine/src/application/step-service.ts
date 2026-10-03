import type { ActorRef, Artifact, Step, StepStatus, Usage } from '@kramahq/contract';
import { DomainError } from '../domain/errors.js';
import type { DomainEvent } from '../domain/events.js';
import { assertBackendAllowed, assertWithinBudget } from '../domain/invariants.js';
import type { AgentRef, GatewayEvent } from '../ports/index.js';
import type { BudgetService } from './budget-service.js';
import type { DecisionService } from './decision-service.js';
import { findPhase, loadRun, nowIso, publish, runEvent, type Ctx } from './context.js';
import { aggregateUsage } from '../domain/cost.js';

export interface DelegateInput {
  runId: string;
  phaseId: string;
  agent: AgentRef;
  /** What the agent is asked to do. */
  text: string;
  /** Short label for the step; defaults to the start of `text`. */
  summary?: string;
  /** Resume a conversation (`Step.a2a.resumed` becomes true). */
  contextId?: string;
  /** Idempotency key: an already-completed step with the same key is returned instead of repeating the work. */
  key?: string;
  /** Per-call budget for long jobs. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface DelegateResult {
  step: Step;
  status: StepStatus;
  /** Text the agent answered with (artifacts named `response` or `message`). */
  answer: string;
  artifacts: Artifact[];
  /** Set when the agent needs input: the engine turns this into a Decision. */
  question?: string;
  /** Set when the delegation failed, timed out or could not reach the agent. */
  error?: string;
  usage: Usage[];
  /** True when an earlier completed step with the same key was returned and no agent was contacted. */
  cached?: boolean;
}

/** Payload sizes kept in events; the full content is in artifacts, not the activity feed. */
const MAX_TEXT = 4000;
const MAX_RAW = 2000;
const clip = (s: string | undefined, n: number) =>
  s && s.length > n ? `${s.slice(0, n)}… (${s.length - n} more)` : s;
const rawJson = (v: unknown): string | undefined => {
  if (v === undefined) return undefined;
  try {
    return clip(JSON.stringify(v), MAX_RAW);
  } catch {
    return undefined;
  }
};

/** Upper bound on consecutive access requests inside one delegation, so a misbehaving agent cannot loop forever. */
const MAX_ACCESS_ROUNDS = 10;
const ANSWER_NAMES = new Set(['response', 'message', 'answer', 'result']);
const typeOfArtifact = (name: string, mediaType: string): string =>
  ANSWER_NAMES.has(name) ? 'message' : mediaType === 'application/json' ? 'data' : name;

/**
 * Runs one delegation: creates the step, consumes the gateway stream, turns sideband into activity events,
 * stores artifacts, and accounts usage per step, phase, run and project. Cost is provider-reported or null.
 */
export class StepService {
  constructor(
    private readonly c: Ctx,
    private readonly budget: BudgetService,
    private readonly decisions: DecisionService,
  ) {}

  async delegate(input: DelegateInput): Promise<DelegateResult> {
    const { c } = this;
    const gateway = c.p.gateway;
    if (!gateway) throw new DomainError('not_found', 'No AgentGateway configured');
    const actor: ActorRef = { type: 'agent', id: input.agent.id, name: input.agent.role };

    if (input.key) {
      const done = (await c.p.store.steps.listByRun(input.runId)).find(
        (x) => x.key === input.key && x.status === 'completed',
      );
      if (done) {
        const arts = (await c.p.artifacts.listByRun(input.runId)).filter(
          (a) => a.stepId === done.id,
        );
        const texts: string[] = [];
        for (const a of arts) {
          if (!ANSWER_NAMES.has(a.name)) continue;
          const body = await c.p.artifacts.read(a.id);
          if (body) texts.push(new TextDecoder().decode(body.bytes));
        }
        return {
          step: done,
          status: 'completed',
          answer: texts.join(''),
          artifacts: arts,
          usage: done.usage ?? [],
          cached: true,
        };
      }
    }

    // Engine-enforced preconditions, regardless of what the orchestrator asked for.
    let step = await c.p.store.transaction(async (tx) => {
      const rec = (await loadRun(tx, input.runId)).value;
      const run = rec.run;
      if (run.status !== 'running')
        throw new DomainError(
          'invalid_transition',
          `Run ${run.id} is ${run.status}; delegation needs a running run`,
          { status: run.status },
        );
      const phase = findPhase(run, input.phaseId);
      if (phase.status !== 'active')
        throw new DomainError(
          'invalid_transition',
          `Phase ${phase.id} is ${phase.status}, not active`,
        );
      assertBackendAllowed(input.agent.backend, c.policy.allowedBackends);
      if (!rec.capWaived) assertWithinBudget(run.budget);
      const s: Step = {
        id: c.p.ids.next('step'),
        runId: run.id,
        phaseId: phase.id,
        agent: {
          id: input.agent.id as Step['agent']['id'],
          role: input.agent.role,
          backend: input.agent.backend,
        },
        summary: input.summary ?? clip(input.text.replace(/\s+/g, ' ').trim(), 120) ?? '',
        ...(input.key ? { key: input.key } : {}),
        status: 'working',
        a2a: {
          resumed: Boolean(input.contextId),
          ...(input.contextId ? { contextId: input.contextId } : {}),
        },
        startedAt: nowIso(c),
      };
      await tx.steps.put(s);
      return s;
    });
    await publish(
      c,
      [
        {
          type: 'step.started',
          subject: { type: 'step', id: step.id },
          runId: input.runId,
          data: {
            stepId: step.id,
            phaseId: step.phaseId,
            agent: step.agent,
            resumed: step.a2a.resumed,
          },
        },
      ],
      actor,
    );

    const artifacts: Artifact[] = [];
    const answer: string[] = [];
    const usage: Usage[][] = [];
    let question: string | undefined;
    let error: string | undefined;
    let status = 'working' as StepStatus;
    const dec = new TextDecoder();

    const saveStep = async (patch: Partial<Step>) => {
      step = { ...step, ...patch };
      const cur = await c.p.store.steps.get(step.id);
      await c.p.store.steps.put(step, cur?.version);
    };
    const emit = (events: DomainEvent[]) => publish(c, events, actor);
    const activity = (type: DomainEvent['type'], data: Record<string, unknown>): DomainEvent => ({
      type,
      subject: { type: 'step', id: step.id },
      runId: input.runId,
      data: {
        stepId: step.id,
        phaseId: step.phaseId,
        agent: { id: step.agent.id, role: step.agent.role, backend: step.agent.backend },
        ...data,
      },
    });

    let text = input.text;
    let contextId = input.contextId;
    let accessRequest: { path: string; mode?: 'read' | 'write' } | undefined;
    try {
      for (let round = 0; ; round++) {
        accessRequest = undefined;
        for await (const e of gateway.send(input.agent, {
          text,
          ...(contextId ? { contextId } : {}),
          ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
          ...(input.signal ? { signal: input.signal } : {}),
        })) {
          await this.handle(e, {
            step: () => step,
            saveStep,
            emit,
            activity,
            actor,
            input,
            artifacts,
            answer,
            usage,
            dec,
            setQuestion: (q) => (question = q),
            setStatus: (s) => (status = s),
            setError: (m) => (error = m),
            setAccess: (r) => (accessRequest = r),
          });
        }
        // An agent asking to touch a path outside its workspace is not a question for the orchestrator: the
        // platform asks a person, then lets the same delegation carry on with the answer.
        const req = accessRequest as { path: string; mode?: 'read' | 'write' } | undefined;
        if (status !== 'input_required' || !req || round >= MAX_ACCESS_ROUNDS) break;
        const verdict = await this.askAccess(input, req, saveStep);
        if (verdict === 'canceled') {
          status = 'canceled';
          error = 'The run ended while access was being decided';
          break;
        }
        question = undefined;
        status = 'working';
        contextId = step.a2a.contextId ?? contextId;
        text =
          verdict === 'denied'
            ? `Access to ${req.path} was denied. Continue without it, or say what you need instead.`
            : `Access to ${req.path} was granted${verdict === 'project' ? ' for this project' : ' once'}. Continue.`;
        await saveStep({ status: 'working' });
      }
    } catch (e) {
      status = 'failed';
      error = (e as Error).message;
    }

    // A stream that ended while the step was still `working` and produced no final state counts as failed.
    if (status === 'working') {
      status = 'failed';
      error ??= 'The agent finished without reporting a final state';
    }
    const endedAt = nowIso(c);
    await saveStep({ status, endedAt });
    const stepEvent: DomainEvent['type'] =
      status === 'completed' || status === 'input_required' ? 'step.completed' : 'step.failed';
    await emit([
      {
        type: stepEvent,
        subject: { type: 'step', id: step.id },
        runId: input.runId,
        data: {
          stepId: step.id,
          phaseId: step.phaseId,
          status,
          ...(error ? { error: clip(error, MAX_TEXT) } : {}),
          ...(question ? { question: clip(question, MAX_TEXT) } : {}),
        },
      },
    ]);

    // Track which artifacts and steps belong to the phase.
    await c.p.store.transaction(async (tx) => {
      const cur = await loadRun(tx, input.runId);
      const rec = structuredClone(cur.value);
      const phase = findPhase(rec.run, input.phaseId);
      phase.stepIds = [...new Set([...(phase.stepIds ?? []), step.id])];
      phase.artifactIds = [
        ...new Set([...(phase.artifactIds ?? []), ...artifacts.map((a) => a.id)]),
      ];
      rec.run.updatedAt = endedAt;
      await tx.runs.put(rec, cur.version);
    });

    return {
      step,
      status,
      answer: answer.join(''),
      artifacts,
      ...(question ? { question } : {}),
      ...(error ? { error } : {}),
      usage: aggregateUsage(usage),
    };
  }

  /**
   * Raises an `access` Decision for a path outside the workspace and waits for it. A project-level grant that a person
   * made earlier answers without asking again. Resolves to how it went; `canceled` when the run ended first.
   */
  private async askAccess(
    input: DelegateInput,
    req: { path: string; mode?: 'read' | 'write' },
    saveStep: (p: Partial<Step>) => Promise<void>,
  ): Promise<'once' | 'project' | 'denied' | 'canceled'> {
    const { c } = this;
    const run = (await c.p.store.runs.get(input.runId))?.value.run;
    if (run?.projectId && (await this.projectGrant(run.projectId, req.path))) return 'project';

    // Subscribe before asking so a fast answer cannot be missed.
    let decisionId = '';
    let off = () => {};
    const settled = new Promise<'resolved' | 'canceled'>((resolve) => {
      off = c.p.events.subscribe(
        (e) => {
          if (e.type === 'run.stopped' || e.type === 'run.failed') resolve('canceled');
          if (
            e.subject.id === decisionId &&
            (e.type === 'decision.resolved' || e.type === 'decision.expired')
          )
            resolve(e.type === 'decision.resolved' ? 'resolved' : 'canceled');
        },
        [`run:${input.runId}`],
      );
    });
    await saveStep({ status: 'input_required' });
    const d = await this.decisions.request({
      decision: {
        id: c.p.ids.next('dec'),
        kind: 'access',
        runId: input.runId as Step['runId'],
        phaseId: input.phaseId,
        title: `${input.agent.role} asks to ${req.mode ?? 'read'} ${req.path}`,
        question: `Agent **${input.agent.role}** wants to ${req.mode ?? 'read'} a path outside its workspace:\n\n\`${req.path}\``,
        access: {
          path: req.path,
          agent: input.agent.role,
          ...(req.mode ? { mode: req.mode } : {}),
        },
        options: [
          {
            id: 'allow_once',
            label: 'Allow once',
            style: 'primary',
            effect: 'Grants this one request',
          },
          {
            id: 'allow_project',
            label: 'Allow for project',
            style: 'neutral',
            effect: 'Remembered for this project',
          },
          { id: 'deny', label: 'Deny', style: 'danger', effect: 'The agent continues without it' },
        ],
        createdAt: nowIso(c),
        links: {},
      },
    });
    decisionId = d.id;
    // It may already have been settled between asking and subscribing to the id.
    const now = (await c.p.store.decisions.get(d.id))?.value.decision.status;
    const how =
      now && now !== 'pending' ? (now === 'resolved' ? 'resolved' : 'canceled') : await settled;
    off();
    if (how === 'canceled') return 'canceled';
    const rec = await c.p.store.decisions.get(d.id);
    const effect = rec?.value.effects[rec.value.decision.resolution?.optionId ?? ''];
    return effect === 'grant_project' ? 'project' : effect === 'grant_once' ? 'once' : 'denied';
  }

  private async projectGrant(projectId: string, path: string): Promise<boolean> {
    const { items } = await this.c.p.store.audit.list({ action: 'access.granted', limit: 200 });
    return items.some(
      (e) =>
        e.detail?.scope === 'project' &&
        e.detail.projectId === projectId &&
        typeof e.detail.path === 'string' &&
        (path === e.detail.path || path.startsWith(`${e.detail.path.replace(/[\\/]$/, '')}/`)),
    );
  }

  /** After a crash: steps still `working` or `queued` have no live agent behind them. Mark them failed so they can be retried. */
  async failOrphaned(runId: string, reason = 'Interrupted by a restart'): Promise<string[]> {
    const { c } = this;
    const ids: string[] = [];
    for (const s of await c.p.store.steps.listByRun(runId)) {
      if (s.status !== 'working' && s.status !== 'queued') continue;
      const cur = await c.p.store.steps.get(s.id);
      await c.p.store.steps.put({ ...s, status: 'failed', endedAt: nowIso(c) }, cur?.version);
      await publish(c, [
        {
          type: 'step.failed',
          subject: { type: 'step', id: s.id },
          runId,
          data: { stepId: s.id, phaseId: s.phaseId, status: 'failed', error: reason },
        },
      ]);
      ids.push(s.id);
    }
    return ids;
  }

  private async handle(
    e: GatewayEvent,
    k: {
      step: () => Step;
      saveStep: (p: Partial<Step>) => Promise<void>;
      emit: (ev: DomainEvent[]) => Promise<unknown>;
      activity: (t: DomainEvent['type'], d: Record<string, unknown>) => DomainEvent;
      actor: ActorRef;
      input: DelegateInput;
      artifacts: Artifact[];
      answer: string[];
      usage: Usage[][];
      dec: { decode(b: Uint8Array): string };
      setQuestion: (q: string) => void;
      setStatus: (s: StepStatus) => void;
      setError: (m: string) => void;
      setAccess: (r: { path: string; mode?: 'read' | 'write' }) => void;
    },
  ): Promise<void> {
    const { c } = this;
    switch (e.kind) {
      case 'state': {
        const a2a = {
          ...k.step().a2a,
          taskId: e.taskId,
          ...(e.contextId ? { contextId: e.contextId } : {}),
        };
        const mapped: StepStatus =
          e.state === 'input_required'
            ? 'input_required'
            : e.state === 'working'
              ? 'working'
              : e.state;
        k.setStatus(mapped);
        await k.saveStep({ a2a, status: mapped });
        if (mapped === 'input_required' && e.text) k.setQuestion(e.text);
        if (mapped === 'input_required' && e.request)
          k.setAccess({
            path: e.request.path,
            ...(e.request.mode ? { mode: e.request.mode } : {}),
          });
        if ((mapped === 'failed' || mapped === 'timed_out' || mapped === 'canceled') && e.text)
          k.setError(e.text);
        break;
      }
      case 'sideband': {
        const type =
          e.type === 'tool_call'
            ? 'activity.tool_call'
            : e.type === 'tool_result'
              ? 'activity.tool_result'
              : e.type === 'message'
                ? 'activity.message'
                : 'activity.status';
        await k.emit([
          k.activity(type, {
            kind: e.type,
            ...(e.toolName ? { toolName: e.toolName } : {}),
            ...(e.isError !== undefined ? { isError: e.isError } : {}),
            ...(e.durationMs !== undefined ? { durationMs: e.durationMs } : {}),
            ...(e.text ? { text: clip(e.text, MAX_TEXT) } : {}),
            ...(rawJson(e.raw) ? { raw: rawJson(e.raw) } : {}),
          }),
        ]);
        break;
      }
      case 'artifact': {
        const bytes =
          e.bytes ??
          (e.data !== undefined ? new TextEncoder().encode(JSON.stringify(e.data)) : undefined);
        if (!bytes) break;
        const art = await c.p.artifacts.put({
          runId: k.input.runId,
          phaseId: k.input.phaseId,
          stepId: k.step().id,
          name: e.name,
          type: typeOfArtifact(e.name, e.mediaType),
          mediaType: e.mediaType,
          producer: k.actor,
          bytes,
        });
        k.artifacts.push(art);
        if (ANSWER_NAMES.has(e.name) && e.bytes) k.answer.push(k.dec.decode(e.bytes));
        await k.emit([
          {
            type: 'artifact.created',
            subject: { type: 'artifact', id: art.id },
            runId: k.input.runId,
            data: {
              artifactId: art.id,
              type: art.type,
              mediaType: art.mediaType,
              name: art.name,
              stepId: k.step().id,
            },
          },
        ]);
        break;
      }
      case 'usage': {
        k.usage.push(e.usage);
        await this.budget.record(
          {
            runId: k.input.runId,
            phaseId: k.input.phaseId,
            stepId: k.step().id,
            cost: e.cost,
            usage: e.usage,
          },
          k.actor,
        );
        const cur = await c.p.store.steps.get(k.step().id);
        if (cur) await k.saveStep({ cost: cur.value.cost ?? null, usage: cur.value.usage ?? [] });
        break;
      }
    }
  }
}

export { runEvent };
