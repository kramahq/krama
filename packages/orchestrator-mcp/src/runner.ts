import type { EventEnvelope, Run } from '@kramahq/contract';
import {
  DomainError,
  isTerminalRun,
  resolveRoster,
  type AgentRef,
  type Engine,
  type GatewayEvent,
  type Ports,
  type RunExecutor,
  type SpawnSpec,
} from '@kramahq/engine';
import {
  childrenOf,
  graphOf,
  planFromPack,
  planFromRoster,
  specFor,
  startWorkers,
  type GraphEnv,
} from './graph.js';
import { firstMessage, renderOrchestratorPrompt } from './prompt.js';
import type { OrchestratorMcp } from './server.js';
import type { SubAgentsOptions } from './subagents.js';
import { mcpEntryFor } from './tokens.js';
import type { AgentDirectory } from './tools.js';

export interface RunnerOptions {
  engine: Engine;
  ports: Ports;
  mcp: OrchestratorMcp;
  /** Base URL of the MCP endpoint, as reachable from the agent (loopback). */
  mcpBaseUrl: string;
  directory: AgentDirectory;
  /** How often to ask the orchestrator to continue when it stops with work left. Default 2. */
  maxNudges?: number;
  /** Time one orchestrator turn may take. Default 6 h (turns include long delegations). */
  turnTimeoutMs?: number;
  /** Sub-agent tool timings for `native` delegation (skillmap probe and sync budget). */
  subAgents?: SubAgentsOptions;
  onError?: (e: unknown, where: string) => void;
}

interface Drive {
  runId: string;
  abort: AbortController;
  /** Aborts only the current orchestrator turn (pause, block, stop). */
  turn?: AbortController;
  agentId?: string;
  contextId?: string;
  /** Messages for the orchestrator that arrived while it was waiting (decision answers, resume notices). */
  inbox: string[];
  wake?: () => void;
  /** A wake-up arrived while the loop was busy; the next sleep returns immediately (no lost wake-ups). */
  signaled?: boolean;
  unsubscribe?: () => void;
  done: Promise<void>;
  /** The drive loop has finished; a new one may start while cleanup runs. */
  ended: boolean;
  nudges: number;
  needsResume: boolean;
}

type TurnState = 'completed' | 'input_required' | 'failed' | 'timed_out' | 'canceled';

const STOP_TURN_ON = new Set(['paused', 'stopped', 'failed', 'blocked', 'interrupted']);
const WAITING = new Set(['awaiting_decision', 'paused', 'blocked', 'interrupted']);

/**
 * Starts and supervises the orchestrator agent of a run. The orchestrator is an ordinary agent: it gets a prompt
 * rendered from the neutral core plus the pack's methodology, and calls back into Krama over MCP with a token
 * scoped to its run. The runner turns its questions into Decisions, waits for people, pauses and resumes it with
 * the run, and picks a run back up after a restart without redoing completed work.
 */
export class OrchestratorRunner implements RunExecutor {
  private readonly drives = new Map<string, Drive>();
  constructor(private readonly o: RunnerOptions) {}

  /** Plans (if needed) and starts driving a run. Returns once the orchestrator has been started. */
  async start(runId: string): Promise<void> {
    const run = await this.run(runId);
    if (run.status === 'planning') await this.o.engine.runs.plan(runId);
    this.begin(runId, firstMessage('start'));
  }

  /** Continues a run after a pause, a block or a restart: orphaned steps are failed (so they can be retried), then driving resumes. */
  async resume(
    runId: string,
    actor: { type: 'user' | 'system'; id: string; name?: string } = {
      type: 'system',
      id: 'engine',
    },
  ): Promise<void> {
    await this.o.engine.steps.failOrphaned(runId);
    const run = await this.run(runId);
    if (['paused', 'interrupted', 'blocked'].includes(run.status))
      await this.o.engine.runs.resume(runId, actor);
    const existing = this.drives.get(runId);
    if (existing && !existing.ended) {
      existing.needsResume = true;
      this.notify(existing);
      return;
    }
    this.begin(runId, firstMessage('resume'));
  }

  /** After a restart: resume every interrupted run. */
  async recoverAll(): Promise<string[]> {
    const { items } = await this.o.ports.store.runs.list({ status: ['interrupted'] });
    for (const { value } of items) await this.resume(value.run.id);
    return items.map((i) => i.value.run.id);
  }

  async stop(runId: string): Promise<void> {
    const d = this.drives.get(runId);
    if (!d) return;
    d.abort.abort();
    d.turn?.abort();
    this.notify(d);
    await d.done;
  }

  /** Resolves when the drive for a run has ended (finished, stopped or waiting for a person to resume). */
  idle(runId: string): Promise<void> {
    return this.drives.get(runId)?.done ?? Promise.resolve();
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled([...this.drives.keys()].map((id) => this.stop(id)));
  }

  // ---- RunExecutor: always told when a decision settles -------------------------

  async onDecisionResolved(sig: {
    runId: string;
    decisionId: string;
    effect: string;
    optionId: string;
    input?: string;
  }): Promise<void> {
    const d = this.drives.get(sig.runId);
    if (!d) return;
    const dec = (await this.o.ports.store.decisions.get(sig.decisionId))?.value.decision;
    const title = dec?.title ?? 'A decision';
    const note = sig.input ? ` Their note: ${sig.input}` : '';
    const msg: Record<string, string | undefined> = {
      answer: `A person answered your question "${title}": ${sig.input ?? sig.optionId}`,
      advance: `"${title}" was approved. Call get_run and continue with what is now active.`,
      advance_autopilot: `"${title}" was approved and the run switched to autopilot. Call get_run and continue.`,
      loop_back: `Changes were requested on "${title}".${note} The phase was reopened. Call get_run, then redo the work addressing that feedback.`,
      raise_cap: 'The budget cap was raised. Call get_budget and continue.',
      continue_capped: 'Budget enforcement was waived for this run. Continue, but stay economical.',
      proceed: `"${title}" was resolved. Call get_run and continue.`,
    };
    const text = msg[sig.effect];
    if (text) d.inbox.push(text);
    this.notify(d);
  }

  // ---- the drive loop --------------------------------------------------------------

  private begin(runId: string, first: string): void {
    const prior = this.drives.get(runId);
    if (prior && !prior.ended) return;
    const d: Drive = {
      runId,
      abort: new AbortController(),
      inbox: [],
      nudges: 0,
      needsResume: false,
      ended: false,
      done: Promise.resolve(),
    };
    // Wake on state changes; end the current turn when the run is paused, blocked or stopped.
    d.unsubscribe = this.o.ports.events.subscribe(
      (e: EventEnvelope) => {
        if (
          e.type !== 'run.updated' &&
          e.type !== 'run.stopped' &&
          e.type !== 'run.failed' &&
          e.type !== 'run.completed'
        )
          return;
        const status = (e.data as { status?: string } | undefined)?.status;
        if (status && STOP_TURN_ON.has(status)) d.turn?.abort();
        this.notify(d);
      },
      [`run:${runId}`],
    );
    this.drives.set(runId, d);
    d.done = this.drive(d, first)
      .catch((e) => this.o.onError?.(e, 'drive'))
      .finally(() => {
        d.ended = true;
        return this.cleanup(d);
      });
  }

  private async drive(d: Drive, first: string): Promise<void> {
    let message: string | undefined = first;
    for (;;) {
      if (d.abort.signal.aborted) return;
      const run = await this.run(d.runId);
      if (isTerminalRun(run.status)) return;

      if (run.status === 'running') {
        const text =
          message ?? this.takeInbox(d) ?? (d.needsResume ? firstMessage('resume') : undefined);
        d.needsResume = false;
        if (text === undefined) {
          // Running with nothing to say: wait for something to happen.
          await this.sleepUntilWoken(d);
          continue;
        }
        message = undefined;
        const turn = await this.turn(d, run, text);
        if (d.abort.signal.aborted) return;
        if (turn.state === 'input_required') {
          await this.o.engine.decisions.request({
            decision: {
              id: this.o.ports.ids.next('dec'),
              kind: 'input',
              runId: d.runId as Run['id'],
              title: 'The orchestrator needs your input',
              question: turn.text || 'The orchestrator asked for input.',
              createdAt: this.o.ports.clock.now().toISOString(),
              links: {},
              options: [
                {
                  id: 'answer',
                  label: 'Answer',
                  style: 'primary',
                  input: { required: true, label: 'Your answer', kind: 'markdown' },
                  effect: 'Sent to the orchestrator, which continues',
                },
              ],
            },
          });
        } else if (turn.state === 'failed' || turn.state === 'timed_out') {
          const reason = `The orchestrator stopped unexpectedly: ${turn.text || turn.state}`;
          await this.o.engine.runs.block(d.runId, reason).catch(() => undefined);
          return; // a person resumes after fixing the cause
        } else if (turn.state === 'completed') {
          const after = await this.run(d.runId);
          if (after.status === 'running' && d.inbox.length === 0) {
            if (d.nudges >= (this.o.maxNudges ?? 2)) {
              await this.o.engine.runs
                .block(
                  d.runId,
                  'The orchestrator stopped before the run was finished and did not continue when asked.',
                )
                .catch(() => undefined);
              return;
            }
            d.nudges += 1;
            message = `You stopped, but the run is still ${after.status} (active: ${after.currentPhaseIds.join(', ') || 'none'}). Call get_run and continue, or request a decision if you need a person.`;
          } else {
            d.nudges = 0;
          }
        }
        continue;
      }

      // Waiting on a person, a pause, a block or an interruption.
      if (WAITING.has(run.status)) await this.sleepUntilWoken(d);
      else await this.sleepUntilWoken(d, 250); // planning: poll briefly
    }
  }

  private notify(d: Drive): void {
    d.signaled = true;
    d.wake?.();
  }

  private takeInbox(d: Drive): string | undefined {
    if (d.inbox.length === 0) return undefined;
    const t = d.inbox.join('\n\n');
    d.inbox = [];
    return t;
  }

  private sleepUntilWoken(d: Drive, ms = 60_000): Promise<void> {
    return new Promise<void>((resolve) => {
      if (d.signaled) {
        d.signaled = false;
        resolve();
        return;
      }
      const t = setTimeout(done, ms);
      function done() {
        clearTimeout(t);
        d.signaled = false;
        d.wake = undefined;
        resolve();
      }
      d.wake = done;
    });
  }

  /** One orchestrator turn: send a message, consume the stream, report where it ended. */
  private async turn(
    d: Drive,
    run: Run,
    text: string,
  ): Promise<{
    state: 'completed' | 'input_required' | 'failed' | 'timed_out' | 'canceled';
    text: string;
  }> {
    const { ports } = this.o;
    let agent: AgentRef;
    try {
      agent = await this.ensureAgent(d, run);
    } catch (e) {
      return { state: 'failed', text: (e as Error).message };
    }
    d.turn = new AbortController();
    const onStop = () => d.turn?.abort();
    d.abort.signal.addEventListener('abort', onStop, { once: true });
    let state = 'failed' as TurnState;
    let last = '';
    try {
      const gw = ports.gateway;
      if (!gw) throw new DomainError('not_found', 'No AgentGateway configured');
      for await (const e of gw.send(agent, {
        text,
        ...(d.contextId ? { contextId: d.contextId } : {}),
        timeoutMs: this.o.turnTimeoutMs ?? 6 * 60 * 60_000,
        signal: d.turn.signal,
      })) {
        await this.onEvent(d, run, agent, e, (s, t) => {
          state = s;
          if (t) last = t;
        });
      }
    } catch (e) {
      state = 'failed';
      last = (e as Error).message;
    } finally {
      // A turn we ended on purpose (pause, block, stop) is canceled, however the stream wound down.
      if (d.turn?.signal.aborted && state !== 'completed' && state !== 'input_required')
        state = 'canceled';
      d.abort.signal.removeEventListener('abort', onStop);
      d.turn = undefined;
    }
    return { state, text: last };
  }

  private async onEvent(
    d: Drive,
    run: Run,
    agent: AgentRef,
    e: GatewayEvent,
    set: (
      s: 'completed' | 'input_required' | 'failed' | 'timed_out' | 'canceled',
      text?: string,
    ) => void,
  ): Promise<void> {
    const { ports, engine } = this.o;
    switch (e.kind) {
      case 'state':
        if (e.contextId) d.contextId = e.contextId;
        if (e.state === 'working') break;
        set(e.state === 'input_required' ? 'input_required' : e.state, e.text);
        break;
      case 'sideband': {
        // The orchestrator is a participant: its tool calls and reasoning show up in the activity feed too.
        const type =
          e.type === 'tool_call'
            ? 'activity.tool_call'
            : e.type === 'tool_result'
              ? 'activity.tool_result'
              : e.type === 'message'
                ? 'activity.message'
                : 'activity.status';
        await ports.events.append({
          type,
          subject: { type: 'agent', id: agent.id },
          runId: run.id,
          data: {
            kind: e.type,
            agent: { id: agent.id, role: 'orchestrator', backend: agent.backend },
            ...(e.toolName ? { toolName: e.toolName } : {}),
            ...(e.isError !== undefined ? { isError: e.isError } : {}),
            ...(e.durationMs !== undefined ? { durationMs: e.durationMs } : {}),
            ...(e.text ? { text: e.text.slice(0, 4000) } : {}),
          },
        });
        break;
      }
      case 'usage':
        await engine.budget
          .record({ runId: run.id, cost: e.cost, usage: e.usage })
          .catch((err) => this.o.onError?.(err, 'usage'));
        break;
      default:
        break; // the orchestrator's own text is not a deliverable; it records outcomes through tools
    }
  }

  private async ensureAgent(d: Drive, run: Run): Promise<AgentRef> {
    const { ports, mcp, directory } = this.o;
    const runtime = ports.agents;
    if (!runtime) throw new DomainError('not_found', 'No agent runtime is configured');
    const existing = d.agentId ? runtime.ref(d.agentId) : undefined;
    if (existing) return existing;

    const pack = await ports.packs.get(run.pack.id);
    if (!pack) throw new DomainError('not_found', `Pack ${run.pack.id} not found`);

    // Runs created before delegation modes existed relayed through Krama.
    const mode = run.orchestrator.delegation ?? 'krama';
    const declared = planFromPack(pack);
    if (declared && mode !== 'native')
      throw new DomainError(
        'invalid_graph',
        'This pack declares an agent graph, which needs native delegation: the relay still works from a roster only',
      );
    const roster = declared
      ? []
      : resolveRoster(pack.roster, directory.definitions(), {
          backendUsable: (b) => directory.backendUsable(b),
        }).resolved;
    const orchestrator = declared
      ? undefined
      : directory.definitions().find((x) => x.id === run.orchestrator.definitionId);
    if (!declared && !orchestrator)
      throw new DomainError(
        'not_found',
        `Orchestrator definition "${run.orchestrator.definitionId}" not found`,
      );

    let spec: SpawnSpec;
    if (mode === 'native') {
      // The orchestrator calls its agents itself, so every agent it can reach must be up and addressable first, leaves
      // first, and each parent's sub-agent config is generated from exactly what the graph lets it call.
      const plan =
        declared ??
        planFromRoster(roster, {
          definitionId: orchestrator!.id,
          backend: run.orchestrator.backend,
          model: run.orchestrator.model,
        });
      const graph = graphOf(plan);
      const env: GraphEnv = { ports, directory, mcp, subAgents: this.o.subAgents };
      const started = await startWorkers(env, run, pack, plan, graph);
      const children = childrenOf(env, plan, graph, graph.orchestrator, started);
      mcp.tokens.revokeRun(run.id);
      const entry = mcpEntryFor(this.o.mcpBaseUrl, mcp.tokens.issue(run.id, undefined, mode));
      spec = await specFor(env, run, pack, plan, graph.orchestrator, children, {
        prompt: renderOrchestratorPrompt({ run, pack, roster, agents: children.lines }),
        hints: false, // the orchestrator's prompt already lists the agents it can call
        mcp: entry.mcp,
        env: entry.env,
      });
    } else {
      const base = orchestrator!;
      const definition = {
        ...base,
        backend: {
          ...base.backend,
          wrapper: run.orchestrator.backend,
          ...(run.orchestrator.model ? { model: run.orchestrator.model } : {}),
        },
      };
      mcp.tokens.revokeRun(run.id);
      const entry = mcpEntryFor(this.o.mcpBaseUrl, mcp.tokens.issue(run.id, undefined, mode));
      const persona = directory.systemPrompt(definition.id);
      spec = {
        definition,
        workspace: { mode: 'shared', key: run.id },
        assignment: { runId: run.id },
        systemPrompt: [persona, renderOrchestratorPrompt({ run, pack, roster })]
          .filter(Boolean)
          .join('\n\n'),
        mcp: entry.mcp,
        env: entry.env,
      };
    }
    const spawned = await runtime.spawn(spec);
    d.agentId = spawned.id;
    const ref = runtime.ref(spawned.id);
    if (!ref) throw new Error('The orchestrator agent stopped right after starting');
    return ref;
  }

  private async cleanup(d: Drive): Promise<void> {
    d.unsubscribe?.();
    const run = await this.run(d.runId).catch(() => undefined);
    // While the run can still continue (waiting, blocked, paused) keep its agents; otherwise release everything.
    if (!run || isTerminalRun(run.status)) {
      const workers = this.o.mcp.releaseRun(d.runId);
      for (const id of [...workers, ...(d.agentId ? [d.agentId] : [])])
        await this.o.ports.agents?.stop(id).catch(() => undefined);
    }
    if (this.drives.get(d.runId) === d) this.drives.delete(d.runId);
  }

  private async run(runId: string): Promise<Run> {
    const r = await this.o.ports.store.runs.get(runId);
    if (!r) throw new DomainError('not_found', `Run ${runId} not found`);
    return r.value.run;
  }
}
