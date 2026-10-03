import type { ActorRef, Artifact, Step, StepStatus, Usage } from '@kramahq/contract';
import { DomainError } from '../domain/errors.js';
import type { DomainEvent } from '../domain/events.js';
import { assertBackendAllowed, assertWithinBudget } from '../domain/invariants.js';
import type { AgentRef, GatewayEvent } from '../ports/index.js';
import type { BudgetService } from './budget-service.js';
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
  ) {}

  async delegate(input: DelegateInput): Promise<DelegateResult> {
    const { c } = this;
    const gateway = c.p.gateway;
    if (!gateway) throw new DomainError('not_found', 'No AgentGateway configured');
    const actor: ActorRef = { type: 'agent', id: input.agent.id, name: input.agent.role };

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

    try {
      for await (const e of gateway.send(input.agent, {
        text: input.text,
        ...(input.contextId ? { contextId: input.contextId } : {}),
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
        });
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
