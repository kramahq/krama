import type { ActorRef, Artifact, Step, StepStatus, Usage } from '@kramahq/contract';
import { DomainError } from '../domain/errors.js';
import type { DomainEvent } from '../domain/events.js';
import { assertBackendAllowed, assertWithinBudget } from '../domain/invariants.js';
import { createHash } from 'node:crypto';
import type { AgentRef, DispatchAware, GatewayEvent, TaskSnapshot } from '../ports/index.js';
import type { BudgetService } from './budget-service.js';
import type { DecisionService } from './decision-service.js';
import { findPhase, loadRun, nowIso, publish, runEvent, transcribe, type Ctx } from './context.js';
import { recordSignal, type IngestSubject } from './ingest-service.js';
import { aggregateUsage } from '../domain/cost.js';
import { MAX_TEXT, clip, sidebandActivity } from '../domain/signals.js';

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
  /** True when an earlier step with the same key was returned and no agent was contacted. */
  cached?: boolean;
  /**
   * Set when the message may or may not have reached the agent. It was not sent again and will not be: check the agent
   * (or the step's task) before deciding to ask again.
   */
  uncertain?: boolean;
}

export interface DeliveryPolicy {
  /** Tries after the first when nothing had left yet (an address that did not answer). Default 3. */
  retries: number;
  /** First wait before such a retry, doubled each time. Default 250 ms. */
  backoffMs: number;
  /** Times a dropped stream is followed again with `SubscribeToTask`. Default 3. */
  reattach: number;
  sleep: (ms: number) => Promise<void>;
}

const DEFAULT_DELIVERY: DeliveryPolicy = {
  retries: 3,
  backoffMs: 250,
  reattach: 3,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

const TERMINAL = new Set<StepStatus>(['completed', 'failed', 'canceled', 'timed_out']);

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
    delivery: Partial<DeliveryPolicy> = {},
  ) {
    this.delivery = { ...DEFAULT_DELIVERY, ...delivery };
  }

  private readonly delivery: DeliveryPolicy;

  async delegate(input: DelegateInput): Promise<DelegateResult> {
    const { c } = this;
    const gateway = c.p.gateway;
    if (!gateway) throw new DomainError('not_found', 'No AgentGateway configured');
    const actor: ActorRef = { type: 'agent', id: input.agent.id, name: input.agent.role };

    if (input.key) {
      const same = (await c.p.store.steps.listByRun(input.runId)).filter(
        (x) => x.key === input.key,
      );
      // A send whose outcome is unknown is reported again, never repeated: the agent may already be doing the work.
      const unsure = same.find((x) => x.a2a.delivery === 'uncertain');
      if (unsure)
        return {
          step: unsure,
          status: unsure.status,
          answer: '',
          artifacts: [],
          error: uncertainText(unsure.agent.role),
          usage: unsure.usage ?? [],
          cached: true,
          uncertain: true,
        };
      const done = same.find((x) => x.status === 'completed');
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
    // What the orchestrator asked of the agent goes on record before the agent is told.
    c.p.transcript?.noteActivity(input.runId, input.agent.id);
    await transcribe(c, {
      runId: input.runId,
      actor: { type: 'orchestrator', id: 'orchestrator' },
      kind: 'message.delegation',
      source: 'mcp',
      sourceEventId: `step:${step.id}:task`,
      phaseId: input.phaseId,
      stepId: step.id,
      payload: {
        to: { id: input.agent.id, role: input.agent.role, backend: input.agent.backend },
        text: input.text,
        ...(input.summary ? { summary: input.summary } : {}),
        ...(input.contextId ? { contextId: input.contextId } : {}),
      },
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
    const seen = new Set<string>();
    let question: string | undefined;
    let error: string | undefined;
    let uncertain = false;
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
    const k = {
      step: () => step,
      saveStep,
      emit,
      activity,
      actor,
      input,
      artifacts,
      answer,
      usage,
      seen,
      dec,
      setQuestion: (q: string) => (question = q),
      setStatus: (s: StepStatus) => (status = s),
      setError: (m: string) => (error = m),
      setAccess: (r: { path: string; mode?: 'read' | 'write' }) => (accessRequest = r),
    };

    let text = input.text;
    let contextId = input.contextId;
    let accessRequest: { path: string; mode?: 'read' | 'write' } | undefined;
    try {
      for (let round = 0; ; round++) {
        accessRequest = undefined;
        // The message gets its id, and the step records it, before anything is sent. If the process dies after this
        // point the step says "pending", which a restart reads as "may have left" and so never sends again.
        const messageId = `msg_${step.id}_${round}`;
        await saveStep({ a2a: { ...step.a2a, messageId, delivery: 'pending' } });
        await transcribe(c, {
          runId: input.runId,
          actor: { type: 'orchestrator', id: 'orchestrator' },
          kind: 'message.dispatch',
          source: 'system',
          phaseId: input.phaseId,
          stepId: step.id,
          sourceEventId: `step:${step.id}:dispatch:${round}`,
          payload: { messageId, to: { id: input.agent.id, role: input.agent.role } },
        });
        const outcome = await this.converse(k, { text, contextId, messageId });
        if (outcome === 'uncertain') {
          uncertain = true;
          break;
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
    if (uncertain) {
      status = 'failed';
      error = uncertainText(step.agent.role);
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
      ...(uncertain ? { uncertain: true } : {}),
      usage: aggregateUsage(usage),
    };
  }

  /**
   * One message to the agent and everything that comes back, through the one `handle` path. Returns `uncertain` when the
   * message may have left and nothing came back: that is recorded and never resent. A failure before anything left is
   * retried with backoff under the same `messageId`. A stream that drops after the agent answered is followed again
   * with `SubscribeToTask`, which only watches, and then checked with `GetTask`.
   */
  private async converse(
    k: Session,
    msg: { text: string; contextId: string | undefined; messageId: string },
  ): Promise<'done' | 'uncertain'> {
    const { c } = this;
    const gateway = c.p.gateway!;
    const { input } = k;
    const policy = this.delivery;
    let heard = false;
    for (let attempt = 0; ; attempt++) {
      try {
        for await (const e of gateway.send(input.agent, {
          text: msg.text,
          messageId: msg.messageId,
          ...(msg.contextId ? { contextId: msg.contextId } : {}),
          ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
          ...(input.signal ? { signal: input.signal } : {}),
          correlation: {
            runId: input.runId,
            ...(input.phaseId ? { phaseId: input.phaseId } : {}),
            stepId: k.step().id,
          },
        })) {
          if (!heard) {
            heard = true;
            await k.saveStep({ a2a: { ...k.step().a2a, delivery: 'sent' } });
          }
          await this.handle(e, k);
        }
        return 'done';
      } catch (err) {
        if (!heard) {
          const notSent = (err as DispatchAware).dispatched === false;
          if (notSent && isUnreachable(err) && attempt < policy.retries) {
            await policy.sleep(policy.backoffMs * 2 ** attempt);
            continue;
          }
          if (notSent) throw err;
          await this.markUncertain(k, msg.messageId, err);
          return 'uncertain';
        }
        // The agent answered and the stream then broke: watch the task again instead of sending anything.
        await this.follow(k, err);
        return 'done';
      }
    }
  }

  /** Records that the outcome of a send is unknown. The step is not retried; the reason stays on the transcript. */
  private async markUncertain(k: Session, messageId: string, err: unknown): Promise<void> {
    await k.saveStep({ a2a: { ...k.step().a2a, delivery: 'uncertain' } });
    await transcribe(this.c, {
      runId: k.input.runId,
      actor: { type: 'orchestrator', id: 'orchestrator' },
      kind: 'message.uncertain',
      source: 'system',
      phaseId: k.input.phaseId,
      stepId: k.step().id,
      sourceEventId: `step:${k.step().id}:uncertain:${messageId}`,
      payload: { messageId, reason: (err as Error).message ?? String(err) },
    });
  }

  /**
   * After a dropped stream: `SubscribeToTask` (observes, never sends), then `GetTask` to settle what the stream missed.
   * Gives up quietly; a step left `working` is failed by the caller with the usual message.
   */
  private async follow(k: Session, cause: unknown): Promise<void> {
    const { c } = this;
    const gateway = c.p.gateway!;
    const { input } = k;
    const policy = this.delivery;
    const settled = () => TERMINAL.has(k.step().status) || k.step().status === 'input_required';
    for (let attempt = 0; attempt < policy.reattach && !settled(); attempt++) {
      const taskId = k.step().a2a.taskId;
      if (!taskId) throw cause;
      await transcribe(c, {
        runId: input.runId,
        actor: { type: 'orchestrator', id: 'orchestrator' },
        kind: 'task.reattach',
        source: 'system',
        phaseId: input.phaseId,
        stepId: k.step().id,
        payload: { taskId, attempt: attempt + 1, reason: (cause as Error).message },
      });
      try {
        for await (const e of gateway.subscribe(input.agent, taskId, {
          ...(input.signal ? { signal: input.signal } : {}),
          ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
        }))
          await this.handle(e, k);
      } catch (err) {
        if ((err as { code?: string }).code === 'task_not_found') {
          k.setStatus('failed');
          k.setError('The agent no longer knows this task');
          await k.saveStep({ status: 'failed' });
          return;
        }
        await policy.sleep(policy.backoffMs * 2 ** attempt);
      }
      if (settled()) break;
      const snap = await gateway.getTask(input.agent, taskId).catch(() => undefined);
      if (snap) await this.adopt(k, snap);
    }
  }

  /** Applies what the agent says a task looks like now, through the same path as a live event. */
  private async adopt(k: Session, snap: TaskSnapshot): Promise<void> {
    for (const a of snap.artifacts) await this.handle(a, k);
    await this.handle(
      {
        kind: 'state',
        state: snap.state,
        taskId: snap.taskId,
        ...(snap.contextId ? { contextId: snap.contextId } : {}),
        ...(snap.text ? { text: snap.text } : {}),
      },
      k,
    );
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

  /**
   * After a crash: steps still `working` or `queued` have no live caller behind them. Each is settled from what is known,
   * and nothing is ever sent again:
   * - the message was never confirmed (`pending`, or no task id): it may have left, so the step is `uncertain`;
   * - the agent still knows the task (`GetTask`): a finished task is taken over (state and artifacts), one still running
   *   is canceled so it does not keep spending unattended, and the step is failed so it can be retried on purpose;
   * - the agent does not know the task, or cannot be reached: the step is failed.
   * A step that is already finished is left as it is.
   */
  async failOrphaned(runId: string, reason = 'Interrupted by a restart'): Promise<string[]> {
    const { c } = this;
    const ids: string[] = [];
    for (const s of await c.p.store.steps.listByRun(runId)) {
      if (s.status !== 'working' && s.status !== 'queued') continue;
      ids.push(s.id);
      const run = (await c.p.store.runs.get(runId))?.value.run;
      const ref = c.p.agents?.ref(s.agent.id);
      const gateway = c.p.gateway;
      let step = s;
      const save = async (patch: Partial<Step>) => {
        step = { ...step, ...patch };
        const cur = await c.p.store.steps.get(step.id);
        await c.p.store.steps.put(step, cur?.version);
      };
      const finish = async (status: StepStatus, error: string) => {
        await save({ status, endedAt: nowIso(c) });
        await publish(c, [
          {
            type: 'step.failed',
            subject: { type: 'step', id: s.id },
            runId,
            data: { stepId: s.id, phaseId: s.phaseId, status, error },
          },
        ]);
      };

      const taskId = s.a2a.taskId;
      if (s.a2a.delivery !== 'sent' || !taskId) {
        // Never confirmed: do not guess, and do not send again.
        await save({ a2a: { ...s.a2a, delivery: 'uncertain' } });
        await transcribe(c, {
          runId,
          actor: { type: 'system', id: 'engine' },
          kind: 'message.uncertain',
          source: 'system',
          phaseId: s.phaseId,
          stepId: s.id,
          sourceEventId: `step:${s.id}:uncertain:restart`,
          payload: { messageId: s.a2a.messageId, reason },
        });
        await finish('failed', uncertainText(s.agent.role));
        continue;
      }
      if (!gateway || !ref || !run) {
        await finish('failed', reason);
        continue;
      }
      let snap: TaskSnapshot | undefined;
      try {
        snap = await gateway.getTask(ref, taskId);
      } catch {
        await finish('failed', `${reason}; ${s.agent.role} could not be reached`);
        continue;
      }
      if (!snap) {
        await finish('failed', `${reason}; ${s.agent.role} no longer knows the task`);
        continue;
      }
      if (snap.state === 'working' || snap.state === 'input_required') {
        await gateway.cancel(ref, taskId).catch(() => undefined);
        await finish('failed', `${reason}; the task was still running and was canceled`);
        continue;
      }
      // The agent finished while Krama was away: take its answer over.
      const taken: Artifact[] = [];
      const actor: ActorRef = { type: 'agent', id: s.agent.id, name: s.agent.role };
      await this.adopt(
        {
          step: () => step,
          saveStep: save,
          emit: (ev) => publish(c, ev, actor),
          activity: (type, data) => ({
            type,
            subject: { type: 'step', id: s.id },
            runId,
            data: { stepId: s.id, phaseId: s.phaseId, ...data },
          }),
          actor,
          input: { runId, phaseId: s.phaseId, agent: ref, text: '' },
          artifacts: taken,
          answer: [],
          usage: [],
          seen: new Set(),
          dec: new TextDecoder(),
          setQuestion: () => undefined,
          setStatus: () => undefined,
          setError: () => undefined,
          setAccess: () => undefined,
        },
        snap,
      );
      await save({ endedAt: nowIso(c) });
      await publish(c, [
        {
          type: snap.state === 'completed' ? 'step.completed' : 'step.failed',
          subject: { type: 'step', id: s.id },
          runId,
          data: { stepId: s.id, phaseId: s.phaseId, status: step.status },
        },
      ]);
    }
    return ids;
  }

  private async handle(e: GatewayEvent, k: Session): Promise<void> {
    const { c } = this;
    switch (e.kind) {
      case 'state': {
        // A task that has finished stays finished: a late read, a replayed frame or a stale poll cannot reopen it.
        if (TERMINAL.has(k.step().status)) {
          await transcribe(c, {
            runId: k.input.runId,
            actor: { type: 'agent', id: k.step().agent.id, role: k.step().agent.role },
            kind: 'step.state.ignored',
            source: 'a2a-stream',
            phaseId: k.input.phaseId,
            stepId: k.step().id,
            payload: { state: e.state, taskId: e.taskId, kept: k.step().status },
          });
          break;
        }
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
        await transcribe(c, {
          runId: k.input.runId,
          actor: { type: 'agent', id: k.step().agent.id, role: k.step().agent.role },
          kind: 'step.state',
          source: 'a2a-stream',
          phaseId: k.input.phaseId,
          stepId: k.step().id,
          payload: {
            state: e.state,
            taskId: e.taskId,
            ...(e.contextId ? { contextId: e.contextId } : {}),
            ...(e.text !== undefined ? { text: e.text } : {}),
            ...(e.request ? { request: e.request } : {}),
          },
        });
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
        await recordSignal(c, relaySubject(k), e);
        const a = sidebandActivity(e);
        await k.emit([k.activity(a.type, a.data)]);
        break;
      }
      case 'artifact': {
        const bytes =
          e.bytes ??
          (e.data !== undefined ? new TextEncoder().encode(JSON.stringify(e.data)) : undefined);
        if (!bytes) break;
        // Following a task again can hand back what was already received; it is stored once.
        const digest = `${e.name}:${createHash('sha256').update(bytes).digest('hex')}`;
        if (k.seen.has(digest)) break;
        k.seen.add(digest);
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
        // The deliverable is on record with what it says (text and data in full) and where its bytes are kept.
        await transcribe(c, {
          runId: k.input.runId,
          actor: { type: 'agent', id: k.step().agent.id, role: k.step().agent.role },
          kind: 'artifact.created',
          source: 'a2a-stream',
          phaseId: k.input.phaseId,
          stepId: k.step().id,
          sourceEventId: `artifact:${art.id}`,
          payload: {
            artifactId: art.id,
            name: art.name,
            type: art.type,
            mediaType: art.mediaType,
            size: art.size,
            sha256: art.sha256,
            ...(/^(text\/|application\/(json|xml|yaml))/.test(art.mediaType)
              ? { content: k.dec.decode(bytes) }
              : {}),
          },
        });
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
        await recordSignal(c, relaySubject(k), e);
        await this.budget.record(
          {
            runId: k.input.runId,
            phaseId: k.input.phaseId,
            stepId: k.step().id,
            cost: e.cost,
            usage: e.usage,
            agent: {
              id: k.step().agent.id,
              role: k.step().agent.role,
              backend: k.step().agent.backend,
            },
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

/** Who reported, for a signal that reached the engine through a delegation Krama made itself. */
function relaySubject(k: { step: () => Step; input: DelegateInput }): IngestSubject {
  const s = k.step();
  return {
    runId: k.input.runId,
    agent: { id: s.agent.id, role: s.agent.role, backend: s.agent.backend },
    phaseId: k.input.phaseId,
    stepId: s.id,
    channel: 'a2a',
  };
}

/** Everything one delegation shares while its events are handled. */
interface Session {
  step: () => Step;
  saveStep: (p: Partial<Step>) => Promise<void>;
  emit: (ev: DomainEvent[]) => Promise<unknown>;
  activity: (t: DomainEvent['type'], d: Record<string, unknown>) => DomainEvent;
  actor: ActorRef;
  input: DelegateInput;
  artifacts: Artifact[];
  answer: string[];
  usage: Usage[][];
  /** Artifacts already stored for this step, by name and content hash. */
  seen: Set<string>;
  dec: { decode(b: Uint8Array): string };
  setQuestion: (q: string) => void;
  setStatus: (s: StepStatus) => void;
  setError: (m: string) => void;
  setAccess: (r: { path: string; mode?: 'read' | 'write' }) => void;
}

const uncertainText = (role: string): string =>
  `The message to ${role} may or may not have arrived, and it was not sent again. Check what ${role} is doing before asking again.`;

const isUnreachable = (e: unknown): boolean => (e as { code?: string }).code === 'unreachable';

export { runEvent };
