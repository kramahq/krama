import { createHash } from 'node:crypto';
import type { AgentDefinition, Pack, Run } from '@kramahq/contract';
import {
  aggregateUsage,
  budgetStatus,
  matchDefinitions,
  resolveRoster,
  DomainError,
  type EffectKind,
  type Engine,
  type Ports,
  type RosterResolution,
} from '@kramahq/engine';
import { z } from 'zod';
import { ScopeError, type ToolErrorBody } from './errors.js';
import type { Scope } from './tokens.js';

/** What the server wiring supplies about agents beyond the engine's ports. */
export interface AgentDirectory {
  definitions(): AgentDefinition[];
  /** Persona text for a definition (contents of `prompt.md`). */
  systemPrompt(definitionId: string): string;
  backendUsable(backend: string): boolean;
  /** MCP servers and environment to inject for a spawned agent (e.g. the pack's tools). */
  extras?(
    def: AgentDefinition,
    runId: string,
  ): { mcp?: Record<string, unknown>; env?: Record<string, string> };
}

export interface SharedState {
  /** In-flight delegations by idempotency key, so an orchestrator retry joins the running call instead of starting a second. */
  inflight: Map<string, Promise<unknown>>;
  /** Agent instance reused per run and role (keeps its session and workspace). */
  agents: Map<string, string>;
  /** Last conversation per run and role, for resuming. */
  contexts: Map<string, string>;
}

export interface ToolCtx {
  scope: Scope;
  engine: Engine;
  ports: Ports;
  directory: AgentDirectory;
  state: SharedState;
}

export interface ToolDef<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  input: S;
  run(ctx: ToolCtx, args: z.infer<z.ZodObject<S>>): Promise<unknown>;
}

const def = <S extends z.ZodRawShape>(t: ToolDef<S>): ToolDef<S> => t;

const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;
const DEFAULT_READ_BYTES = 100_000;

const loadRun = async (c: ToolCtx): Promise<Run> => {
  const r = await c.ports.store.runs.get(c.scope.runId);
  if (!r) throw new DomainError('not_found', `Run ${c.scope.runId} not found`);
  return r.value.run;
};
const packOf = async (c: ToolCtx, run: Run): Promise<Pack> => {
  const p = await c.ports.packs.get(run.pack.id);
  if (!p) throw new DomainError('not_found', `Pack ${run.pack.id} not found`);
  return p;
};

const phaseView = (run: Run) =>
  (run.phases ?? []).map((p) => ({
    id: p.id,
    label: p.label,
    status: p.status,
    iteration: p.iteration,
    roles: p.agentRoles,
    dependsOn: p.dependsOn,
    ...(p.outcome
      ? {
          outcome: { status: p.outcome.status, gating: p.outcome.gating, reason: p.outcome.reason },
        }
      : {}),
  }));

const runSummary = async (c: ToolCtx) => {
  const run = await loadRun(c);
  const pending = (
    await c.ports.store.decisions.list({ runId: run.id, status: ['pending'] })
  ).items.map((i) => ({
    id: i.value.decision.id,
    kind: i.value.decision.kind,
    title: i.value.decision.title,
    phaseId: i.value.decision.phaseId,
  }));
  return {
    runId: run.id,
    title: run.title,
    status: run.status,
    ...(run.statusReason ? { statusReason: run.statusReason } : {}),
    mode: run.mode,
    currentPhaseIds: run.currentPhaseIds,
    phases: phaseView(run),
    pendingDecisions: pending,
  };
};

const resolveForRun = async (c: ToolCtx, pack: Pack): Promise<RosterResolution> =>
  resolveRoster(pack.roster, c.directory.definitions(), {
    backendUsable: (b) => c.directory.backendUsable(b),
  });

const EFFECTS = [
  'advance',
  'loop_back',
  'halt',
  'answer',
  'proceed',
  'decline',
] as const satisfies readonly EffectKind[];

// ---- tools ------------------------------------------------------------------

export const TOOLS = [
  def({
    name: 'get_run',
    title: 'Get run state',
    description:
      'Current state of your run: status, phases with their status and iteration, and pending decisions. Call this first, and again after a restart, to see where things stand.',
    input: {},
    run: (c) => runSummary(c),
  }),

  def({
    name: 'query_agents',
    title: 'Query agents',
    description:
      "Which agents you can delegate to. Without arguments: the run's roster, the definition chosen for each role, other candidates, and running instances. With capabilities or role: a ranked search across all definitions.",
    input: {
      role: z.string().optional(),
      capabilities: z.array(z.string()).optional(),
      backend: z.string().optional(),
    },
    run: async (c, a) => {
      const run = await loadRun(c);
      const defs = c.directory.definitions();
      const usable = (d: AgentDefinition) => c.directory.backendUsable(d.backend.wrapper);
      if (a.capabilities?.length) {
        return {
          candidates: matchDefinitions(
            defs,
            {
              ...(a.role ? { role: a.role } : {}),
              capabilities: a.capabilities,
              ...(a.backend ? { backend: a.backend } : {}),
            },
            usable,
          ).map((m) => ({
            definitionId: m.definition.id,
            role: m.definition.role,
            backend: m.definition.backend.wrapper,
            coverage: m.coverage,
            reasons: m.reasons,
          })),
        };
      }
      const pack = await packOf(c, run);
      const instances = c.ports.agents?.list({}) ?? [];
      const roles = pack.roster
        .filter((r) => !a.role || r.role === a.role)
        .map((entry) => {
          let selected: { definitionId: string; backend: string } | null = null;
          let reason: string | undefined;
          try {
            const r = resolveRoster([entry], defs, {
              backendUsable: (b) => c.directory.backendUsable(b),
            });
            const hit = r.resolved[0];
            if (hit) selected = { definitionId: hit.definition.id, backend: hit.backend };
            else reason = r.skipped[0]?.reason;
          } catch (e) {
            reason = e instanceof DomainError ? e.message : 'unresolved';
          }
          const candidates = matchDefinitions(
            defs,
            {
              role: entry.role,
              ...(entry.select.capabilities ? { capabilities: entry.select.capabilities } : {}),
              ...(entry.select.backend ? { backend: entry.select.backend } : {}),
            },
            usable,
          ).map((m) => ({
            definitionId: m.definition.id,
            backend: m.definition.backend.wrapper,
            coverage: m.coverage,
          }));
          return {
            role: entry.role,
            count: entry.count ?? 1,
            optional: entry.optional ?? false,
            selected,
            ...(reason ? { reason } : {}),
            candidates,
            instances: instances
              .filter((i) => i.role === entry.role && i.status !== 'stopped')
              .map((i) => ({ id: i.id, status: i.status, backend: i.backend })),
          };
        });
      return { roles };
    },
  }),

  def({
    name: 'delegate_to_agent',
    title: 'Delegate to an agent',
    description:
      "Give a task to the agent for a role and wait for the result. Starts the agent if needed and reuses its conversation for follow-ups. Returns the agent's answer, any question it needs answered, artifacts it produced and cost. The platform enforces run state, budget and allowed backends.",
    input: {
      phaseId: z.string().describe('The active phase this work belongs to'),
      role: z.string().describe('A role from query_agents'),
      task: z.string().min(1).describe('What the agent should do, with everything it needs'),
      contextId: z
        .string()
        .optional()
        .describe(
          'Resume a specific conversation; by default the last one with this role is resumed',
        ),
      timeoutMs: z
        .number()
        .int()
        .positive()
        .max(6 * 60 * 60_000)
        .optional()
        .describe('Longer budget for long jobs'),
    },
    run: async (c, a) => {
      // Same phase, role and task while one is running: join it (an orchestrator retry must not double-delegate).
      const key = createHash('sha256')
        .update(`${c.scope.runId}\0${a.phaseId}\0${a.role}\0${a.task}`)
        .digest('hex');
      const running = c.state.inflight.get(key);
      if (running) return running;
      const p = (async () => {
        const run = await loadRun(c);
        const pack = await packOf(c, run);
        const resolved = (await resolveForRun(c, pack)).resolved.find((r) => r.role === a.role);
        if (!resolved)
          throw new DomainError(
            'not_found',
            `No agent for role "${a.role}". Call query_agents to see the roster.`,
            { role: a.role, roles: pack.roster.map((r) => r.role) },
          );
        const runtime = c.ports.agents;
        if (!runtime) throw new DomainError('not_found', 'No agent runtime is configured');
        const slot = `${run.id}:${a.role}`;
        let agentId = c.state.agents.get(slot);
        if (!agentId || !runtime.ref(agentId)) {
          const extras = c.directory.extras?.(resolved.definition, run.id);
          const spawned = await runtime.spawn({
            definition:
              resolved.backend === resolved.definition.backend.wrapper
                ? resolved.definition
                : {
                    ...resolved.definition,
                    backend: { ...resolved.definition.backend, wrapper: resolved.backend },
                  },
            workspace: { mode: 'shared', key: run.id },
            assignment: { runId: run.id, phaseId: a.phaseId },
            systemPrompt: c.directory.systemPrompt(resolved.definition.id),
            ...(extras?.mcp ? { mcp: extras.mcp } : {}),
            ...(extras?.env ? { env: extras.env } : {}),
          });
          agentId = spawned.id;
          c.state.agents.set(slot, agentId);
        }
        const ref = runtime.ref(agentId)!;
        runtime.assign(agentId, { runId: run.id, phaseId: a.phaseId });
        const contextId = a.contextId ?? c.state.contexts.get(slot);
        try {
          const iteration = run.phases?.find((x) => x.id === a.phaseId)?.iteration ?? 0;
          const stepKey = createHash('sha256')
            .update(`${run.id}\0${a.phaseId}\0${iteration}\0${a.role}\0${a.task}`)
            .digest('hex')
            .slice(0, 32);
          const r = await c.engine.steps.delegate({
            runId: run.id,
            phaseId: a.phaseId,
            agent: ref,
            text: a.task,
            key: stepKey,
            ...(contextId ? { contextId } : {}),
            ...(a.timeoutMs ? { timeoutMs: a.timeoutMs } : {}),
          });
          if (r.step.a2a.contextId) c.state.contexts.set(slot, r.step.a2a.contextId);
          return {
            stepId: r.step.id,
            status: r.status,
            ...(r.cached
              ? {
                  cached: true,
                  note: 'This exact task was already completed; the earlier result is returned and no agent was contacted.',
                }
              : {}),
            answer: r.answer,
            ...(r.question ? { question: r.question } : {}),
            ...(r.error ? { error: r.error } : {}),
            artifacts: r.artifacts.map((x) => ({
              id: x.id,
              name: x.name,
              type: x.type,
              mediaType: x.mediaType,
              size: x.size,
            })),
            usage: r.usage,
            cost: r.step.cost ?? null,
            ...(r.step.a2a.contextId ? { contextId: r.step.a2a.contextId } : {}),
            agent: { id: ref.id, backend: ref.backend },
          };
        } finally {
          runtime.assign(agentId, undefined);
        }
      })().finally(() => c.state.inflight.delete(key));
      c.state.inflight.set(key, p);
      return p;
    },
  }),

  def({
    name: 'record_phase_outcome',
    title: 'Record phase outcome',
    description:
      'Record your verdict on an active phase. gating: continue (accept; a methodology gate may then ask a person), loop_back (send work back to loopTarget; the platform caps automated loops), skip_downstream, or halt. Returns the run state after the engine applied it.',
    input: {
      phaseId: z.string(),
      status: z.enum(['success', 'failure', 'partial', 'blocked', 'skipped']),
      reason: z.string().min(1),
      gating: z.enum(['continue', 'loop_back', 'skip_downstream', 'halt']),
      loopTarget: z.string().optional(),
      feedback: z.string().optional(),
      findings: z
        .array(
          z.object({
            severity: z.enum(['info', 'minor', 'major', 'blocker']),
            title: z.string(),
            detail: z.string().optional(),
            ref: z.string().optional(),
          }),
        )
        .optional(),
    },
    run: async (c, a) => {
      await c.engine.runs.recordPhaseOutcome(c.scope.runId, a.phaseId, {
        status: a.status,
        reason: a.reason,
        gating: a.gating,
        ...(a.loopTarget ? { loopTarget: a.loopTarget } : {}),
        ...(a.feedback ? { feedback: a.feedback } : {}),
        ...(a.findings ? { findings: a.findings } : {}),
      });
      return runSummary(c);
    },
  }),

  def({
    name: 'request_decision',
    title: 'Ask a person to decide',
    description:
      'Ask a person a question the run needs answered (missing information, a choice, a review). The run waits. Every option must say what the platform does when chosen (effect): advance, loop_back, halt, answer, proceed or decline. You cannot offer options the platform does not implement.',
    input: {
      kind: z.enum(['input', 'review', 'approval']),
      title: z.string().min(1),
      question: z.string().min(1).describe('Markdown'),
      phaseId: z.string().optional(),
      options: z
        .array(
          z.object({
            id: z.string().regex(/^[a-z][a-z0-9_]*$/),
            label: z.string(),
            style: z.enum(['primary', 'danger', 'neutral']).default('neutral'),
            effect: z.enum(EFFECTS),
            input: z
              .object({
                required: z.boolean(),
                label: z.string(),
                kind: z.enum(['text', 'markdown', 'choice']),
                choices: z.array(z.string()).optional(),
              })
              .optional(),
          }),
        )
        .min(1)
        .max(8),
      deadline: z.string().datetime().optional(),
      onTimeout: z.enum(['expire', 'escalate', 'auto_approve', 'auto_reject']).optional(),
    },
    run: async (c, a) => {
      const run = await loadRun(c);
      if (a.phaseId && !run.phases?.some((p) => p.id === a.phaseId))
        throw new ScopeError('invalid_argument', `Unknown phase "${a.phaseId}"`);
      const d = await c.engine.decisions.request({
        decision: {
          id: c.ports.ids.next('dec'),
          kind: a.kind,
          runId: run.id,
          ...(a.phaseId ? { phaseId: a.phaseId } : {}),
          title: a.title,
          question: a.question,
          options: a.options.map((o) => ({
            id: o.id,
            label: o.label,
            style: o.style,
            ...(o.input ? { input: o.input } : {}),
          })),
          ...(a.deadline ? { deadline: a.deadline } : {}),
          ...(a.onTimeout ? { onTimeout: a.onTimeout } : {}),
          createdAt: c.ports.clock.now().toISOString(),
          links: {},
        },
        effects: Object.fromEntries(a.options.map((o) => [o.id, o.effect])),
      });
      return {
        decisionId: d.id,
        status: d.status,
        message:
          'A person has been asked. The run is waiting; do not continue this phase until it is resolved.',
      };
    },
  }),

  def({
    name: 'store_artifact',
    title: 'Store an artifact',
    description:
      'Save a deliverable or working document for this run (text or base64 bytes). Pass supersedes to create a new version.',
    input: {
      name: z.string().min(1),
      type: z.string().default('document'),
      mediaType: z.string().default('text/markdown'),
      phaseId: z.string().optional(),
      summary: z.string().optional(),
      text: z.string().optional(),
      base64: z.string().optional(),
      supersedes: z.string().optional(),
    },
    run: async (c, a) => {
      if ((a.text === undefined) === (a.base64 === undefined))
        throw new ScopeError('invalid_argument', 'Provide exactly one of text or base64');
      const bytes =
        a.text !== undefined
          ? new TextEncoder().encode(a.text)
          : Uint8Array.from(Buffer.from(a.base64!, 'base64'));
      if (bytes.byteLength > MAX_ARTIFACT_BYTES)
        throw new ScopeError(
          'invalid_argument',
          `Artifacts over ${MAX_ARTIFACT_BYTES / 1024 / 1024} MB are not accepted here`,
        );
      if (a.supersedes) {
        const prior = await c.ports.artifacts.get(a.supersedes);
        if (!prior || prior.runId !== c.scope.runId)
          throw new ScopeError('out_of_scope', 'You can only supersede artifacts of your own run');
      }
      const art = await c.ports.artifacts.put({
        runId: c.scope.runId,
        ...(a.phaseId ? { phaseId: a.phaseId } : {}),
        name: a.name,
        type: a.type,
        mediaType: a.mediaType,
        producer: { type: 'orchestrator', id: c.scope.runId },
        bytes,
        ...(a.summary ? { summary: a.summary } : {}),
        ...(a.supersedes ? { supersedes: a.supersedes } : {}),
      });
      await c.ports.events.append({
        type: 'artifact.created',
        subject: { type: 'artifact', id: art.id },
        runId: c.scope.runId as Run['id'],
        data: { artifactId: art.id, type: art.type, mediaType: art.mediaType, name: art.name },
      });
      return {
        id: art.id,
        name: art.name,
        version: art.version,
        size: art.size,
        sha256: art.sha256,
      };
    },
  }),

  def({
    name: 'get_artifact',
    title: 'Read an artifact',
    description:
      'Read an artifact of this run. Text is returned as text; other types as base64. Large artifacts are cut at maxBytes (default 100 KB); use offset to page.',
    input: {
      artifactId: z.string(),
      maxBytes: z.number().int().positive().max(2_000_000).optional(),
      offset: z.number().int().nonnegative().optional(),
    },
    run: async (c, a) => {
      const meta = await c.ports.artifacts.get(a.artifactId);
      // Same answer for "does not exist" and "belongs to another run": no probing across runs.
      if (!meta || meta.runId !== c.scope.runId)
        throw new DomainError('not_found', `Artifact ${a.artifactId} not found in this run`);
      const start = a.offset ?? 0;
      const limit = a.maxBytes ?? DEFAULT_READ_BYTES;
      const content =
        meta.size === 0
          ? { bytes: new Uint8Array(), size: 0 }
          : await c.ports.artifacts.read(a.artifactId, { start, end: start + limit - 1 });
      if (!content) throw new DomainError('not_found', `Content of ${a.artifactId} is missing`);
      const isText =
        /^text\//.test(meta.mediaType) || /json|xml|yaml|markdown/.test(meta.mediaType);
      return {
        id: meta.id,
        name: meta.name,
        type: meta.type,
        mediaType: meta.mediaType,
        version: meta.version,
        status: meta.status,
        size: meta.size,
        offset: start,
        truncated: start + content.bytes.byteLength < meta.size,
        ...(isText
          ? { text: new TextDecoder().decode(content.bytes) }
          : { base64: Buffer.from(content.bytes).toString('base64') }),
      };
    },
  }),

  def({
    name: 'get_budget',
    title: 'Get budget',
    description:
      'Spend against the run cap. `spent` is null when no backend reported cost: it is never estimated. Non-dollar usage (tokens, calls, credits) is listed by unit.',
    input: {},
    run: async (c) => {
      const run = await loadRun(c);
      const rec = (await c.ports.store.runs.get(run.id))!.value;
      const ledger = await c.ports.store.usage.forRun(run.id);
      const spent = run.budget.spent;
      return {
        max: run.budget.max,
        spent,
        percentUsed:
          spent && run.budget.max.amount > 0
            ? Math.round((spent.amount / run.budget.max.amount) * 100)
            : null,
        status: rec.capWaived
          ? 'waived'
          : budgetStatus(run.budget.max, spent, run.budget.warnAtPct),
        warnAtPct: run.budget.warnAtPct,
        onExceed: run.budget.onExceed,
        usage: aggregateUsage(ledger.map((l) => l.usage)),
        costReported: ledger.some((l) => l.cost !== null),
        byPhase: (run.phases ?? [])
          .filter((p) => p.cost !== undefined)
          .map((p) => ({ phaseId: p.id, cost: p.cost ?? null })),
      };
    },
  }),
] as const;

export type ToolName = (typeof TOOLS)[number]['name'];
export type { ToolErrorBody };
