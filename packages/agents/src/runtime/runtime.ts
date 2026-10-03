import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Agent, BackendDescriptor } from '@kramahq/contract';
import type {
  AgentFilter,
  AgentRef,
  AgentRuntime,
  BackendCatalog,
  Clock,
  EventLog,
  IdGenerator,
  SecretResolver,
  SpawnSpec,
} from '@kramahq/engine';
import spawn from 'cross-spawn';
import type { ChildProcess } from 'node:child_process';
import { buildLaunch, type BuildProblem } from '../config-builder.js';
import { Ledger, writeFileAtomic } from './ledger.js';
import { LogTail } from './log-tail.js';
import { PortAllocator } from './port-allocator.js';
import { defaultKillOps, killTree, type KillOps } from './process-tree.js';
import { WorkspaceManager } from './workspace.js';

export type StartErrorCode =
  'backend_unknown' | 'config_invalid' | 'spawn_failed' | 'startup_timeout' | 'exited_early';

/** Why an agent could not be started, with what the process printed and how to fix it. */
export class AgentStartError extends Error {
  constructor(
    readonly code: StartErrorCode,
    message: string,
    readonly details: { logTail?: string[]; problems?: BuildProblem[]; hint?: string } = {},
  ) {
    super(message);
    this.name = 'AgentStartError';
  }
}

export interface RuntimeOptions {
  catalog: BackendCatalog;
  events: EventLog;
  ids: IdGenerator;
  clock: Clock;
  secrets: SecretResolver;
  /** Where configs, workspaces and the process ledger live (`KRAMA_HOME`-derived). */
  dataDir: string;
  workspaces?: WorkspaceManager;
  ports?: PortAllocator;
  /** Override how a backend is executed (development, tests). Default: its `bin` on PATH. */
  resolveCommand?: (d: BackendDescriptor) => { command: string; args: string[] };
  ambientEnv?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  killOps?: KillOps;
  /** Automatic restarts after an unexpected exit or a dead health check. */
  restart?: { max: number; backoffMs: number };
  health?: { intervalMs: number; timeoutMs: number; maxFailures: number };
  /** Stop agents idle (and unassigned) this long. 0 disables. */
  idleTtlMs?: number;
  /** Forget stopped agents after this long. */
  stoppedTtlMs?: number;
  stopGraceMs?: number;
}

interface Entry {
  agent: Agent;
  spec: SpawnSpec;
  descriptor: BackendDescriptor;
  child?: ChildProcess;
  tail: LogTail;
  stopping: boolean;
  restarts: number;
  failures: number;
  lastActive: number;
  stoppedAt?: number;
  configPath: string;
}

/** Variables a child may inherit: enough to find programs and a home directory, nothing else. */
const BASE_ENV = [
  'PATH',
  'Path',
  'HOME',
  'USERPROFILE',
  'SYSTEMROOT',
  'SystemRoot',
  'COMSPEC',
  'ComSpec',
  'TEMP',
  'TMP',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMFILES',
  'ProgramFiles',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class ProcessAgentRuntime implements AgentRuntime {
  private readonly entries = new Map<string, Entry>();
  private readonly workspaces: WorkspaceManager;
  private readonly ports: PortAllocator;
  private readonly ledger: Ledger;
  private readonly ops: KillOps;
  private readonly doFetch: typeof fetch;
  private timers: NodeJS.Timeout[] = [];

  constructor(private readonly o: RuntimeOptions) {
    this.workspaces = o.workspaces ?? new WorkspaceManager(join(o.dataDir, 'workspaces'));
    this.ports = o.ports ?? new PortAllocator();
    this.ledger = new Ledger(join(o.dataDir, 'agents', 'ledger.json'));
    this.ops = o.killOps ?? defaultKillOps;
    this.doFetch = o.fetch ?? fetch;
  }

  // ---- lifecycle -----------------------------------------------------------

  /** Kills wrappers left behind by a crashed previous run, then starts health checks and the reaper. */
  async start(): Promise<{ reaped: string[] }> {
    const reaped = await this.ledger.reapOrphans({
      isAlive: (pid) => this.ops.isAlive(pid),
      answers: async (port) =>
        (await this.probe(`http://127.0.0.1:${port}`, '/.well-known/agent-card.json')).ok,
      kill: (pid) => killTree(pid, { ops: this.ops, graceMs: this.o.stopGraceMs ?? 3000 }),
    });
    const h = this.o.health ?? { intervalMs: 15_000, timeoutMs: 3000, maxFailures: 3 };
    if (h.intervalMs > 0)
      this.timers.push(setInterval(() => void this.checkHealth(), h.intervalMs).unref());
    this.timers.push(setInterval(() => void this.reap(), 60_000).unref());
    return { reaped };
  }

  async shutdown(): Promise<void> {
    for (const t of this.timers.splice(0)) clearInterval(t);
    await Promise.allSettled([...this.entries.keys()].map((id) => this.stop(id)));
  }

  // ---- AgentRuntime --------------------------------------------------------

  get(id: string): Agent | undefined {
    const e = this.entries.get(id);
    return e ? structuredClone(e.agent) : undefined;
  }

  list(f: AgentFilter = {}): Agent[] {
    return [...this.entries.values()]
      .map((e) => e.agent)
      .filter(
        (a) =>
          (!f.status || f.status.includes(a.status)) &&
          (!f.role || a.role === f.role) &&
          (!f.runId || a.assignment?.runId === f.runId),
      )
      .map((a) => structuredClone(a));
  }

  ref(id: string): AgentRef | undefined {
    const a = this.entries.get(id)?.agent;
    return a && a.status !== 'stopped'
      ? { id: a.id, url: a.url, role: a.role, backend: a.backend }
      : undefined;
  }

  assign(id: string, assignment: Agent['assignment'] | undefined): void {
    const e = this.entries.get(id);
    if (!e || e.agent.status === 'stopped' || e.agent.status === 'starting') return;
    if (assignment) e.agent.assignment = assignment;
    else delete e.agent.assignment;
    e.lastActive = Date.now();
    void this.setStatus(e, assignment ? 'busy' : 'idle');
  }

  async spawn(spec: SpawnSpec): Promise<Agent> {
    const def = spec.definition;
    const descriptor = this.o.catalog.get(def.backend.wrapper);
    if (!descriptor) {
      throw new AgentStartError('backend_unknown', `Unknown backend "${def.backend.wrapper}"`, {
        hint: `Registered: ${this.o.catalog
          .list()
          .map((d) => d.id)
          .join(', ')}. Add a descriptor to <KRAMA_HOME>/backends (see "Adding a backend").`,
      });
    }
    const id = spec.instanceId ?? this.o.ids.next('agt');
    const entry = await this.launch(
      id,
      spec,
      descriptor,
      spec.instanceId ? this.entries.get(id) : undefined,
    );
    return structuredClone(entry.agent);
  }

  async restart(id: string): Promise<Agent> {
    const e = this.entries.get(id);
    if (!e) throw new Error(`Agent not found: ${id}`);
    await this.stop(id);
    const restarts = e.restarts;
    const entry = await this.launch(id, e.spec, e.descriptor, e);
    entry.restarts = restarts;
    await this.emit('agent.restarted', entry.agent);
    return structuredClone(entry.agent);
  }

  async stop(id: string): Promise<void> {
    const e = this.entries.get(id);
    if (!e || e.agent.status === 'stopped') return;
    e.stopping = true;
    const pid = e.child?.pid;
    if (pid) await killTree(pid, { ops: this.ops, graceMs: this.o.stopGraceMs ?? 3000 });
    this.markStopped(e);
    await this.ledger.remove(id).catch(() => undefined);
    await this.emit('agent.stopped', e.agent);
  }

  // ---- launching -----------------------------------------------------------

  private async launch(
    id: string,
    spec: SpawnSpec,
    descriptor: BackendDescriptor,
    prior?: Entry,
  ): Promise<Entry> {
    const def = spec.definition;
    const port = await this.ports.allocate();
    const workDir =
      spec.workspace.mode === 'shared'
        ? this.workspaces.shared(spec.workspace.key)
        : this.workspaces.isolated(spec.workspace.key, id);
    const agentDir = join(this.o.dataDir, 'agents', id);
    mkdirSync(agentDir, { recursive: true });
    const configPath = join(agentDir, 'config.json');

    // Resolve only the secrets this definition binds.
    const secretValues: Record<string, string> = {};
    for (const ref of Object.values(def.backend.secrets ?? {})) {
      const v = await this.o.secrets.resolve(ref);
      if (v !== undefined) secretValues[ref] = v;
    }
    const plan = buildLaunch(
      descriptor,
      {
        model: def.backend.model,
        options: def.backend.options,
        common: def.backend.common,
        secrets: def.backend.secrets,
      },
      {
        port,
        workspace: workDir,
        configPath,
        agentName: def.name,
        agentDescription: def.description,
        ...(spec.systemPrompt ? { systemPrompt: spec.systemPrompt } : {}),
        ...(spec.allowedTools ? { allowedTools: spec.allowedTools } : {}),
        ...(spec.mcp ? { mcp: spec.mcp } : {}),
        secretValues,
        ambientEnv: this.o.ambientEnv ?? process.env,
      },
    );
    if (!plan.ok) {
      this.ports.release(port);
      throw new AgentStartError(
        'config_invalid',
        `Cannot start ${def.id} on ${descriptor.id}: ${plan.problems.map((p) => p.message).join('; ')}`,
        { problems: plan.problems },
      );
    }
    await writeFileAtomic(configPath, JSON.stringify(plan.config, null, 2));

    const base: Record<string, string> = { NO_COLOR: '1' };
    const ambient = this.o.ambientEnv ?? process.env;
    for (const k of BASE_ENV) if (ambient[k] !== undefined) base[k] = ambient[k]!;
    const cmd = this.o.resolveCommand?.(descriptor) ?? { command: plan.command, args: [] };

    const now = this.o.clock.now().toISOString();
    const agent: Agent = {
      id: id as Agent['id'],
      definitionId: def.id,
      role: def.role,
      variant: def.variant,
      backend: descriptor.id,
      ...(def.backend.model ? { model: def.backend.model } : {}),
      status: 'starting',
      url: `http://127.0.0.1:${port}`,
      port,
      startedAt: now,
      ...(spec.assignment ? { assignment: spec.assignment } : {}),
      workspace: { mode: spec.workspace.mode, path: workDir },
      session: { resumable: descriptor.capabilities.resumableSessions },
      links: {},
    };
    const entry: Entry = prior ?? {
      agent,
      spec,
      descriptor,
      tail: new LogTail(),
      stopping: false,
      restarts: 0,
      failures: 0,
      lastActive: Date.now(),
      configPath,
    };
    entry.agent = agent;
    entry.spec = spec;
    entry.descriptor = descriptor;
    entry.stopping = false;
    entry.failures = 0;
    entry.lastActive = Date.now();
    entry.configPath = configPath;
    delete entry.stoppedAt;
    this.entries.set(id, entry);

    let child: ChildProcess;
    try {
      child = spawn(cmd.command, [...cmd.args, ...plan.args], {
        cwd: workDir,
        env: { ...base, ...plan.env, ...(spec.env ?? {}) },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
    } catch (e) {
      return this.failStart(entry, port, 'spawn_failed', (e as Error).message);
    }
    entry.child = child;
    agent.pid = child.pid ?? 0;
    child.stdout?.setEncoding('utf8').on('data', (s: string) => entry.tail.push(s));
    child.stderr?.setEncoding('utf8').on('data', (s: string) => entry.tail.push(s));

    const exited = new Promise<{ code: number | null; error?: Error }>((resolve) => {
      child.once('error', (error) => resolve({ code: null, error }));
      child.once('exit', (code) => resolve({ code }));
    });
    void exited.then((r) => this.onExit(entry, port, r.code));

    if (!child.pid) {
      const r = await exited;
      return this.failStart(
        entry,
        port,
        'spawn_failed',
        r.error?.message ?? 'process did not start',
        `Is ${descriptor.package.bin} installed? ${descriptor.package.install}`,
      );
    }
    await this.ledger.add({ id, pid: child.pid, port, startedAt: now });
    if (!prior) await this.emit('agent.spawned', agent);

    const ready = await this.waitReady(entry, descriptor, exited);
    if (ready !== 'ok') {
      await killTree(child.pid, { ops: this.ops, graceMs: 500 });
      await this.ledger.remove(id).catch(() => undefined);
      return this.failStart(
        entry,
        port,
        ready === 'timeout' ? 'startup_timeout' : 'exited_early',
        ready === 'timeout'
          ? `${descriptor.id} did not become ready within ${descriptor.launch.startupTimeoutMs / 1000}s`
          : `${descriptor.id} exited during start-up`,
      );
    }
    const card = await this.fetchJson(agent.url, descriptor.launch.readyPath);
    if (card) agent.card = card;
    agent.lastHealthAt = this.o.clock.now().toISOString();
    await this.setStatus(entry, spec.assignment ? 'busy' : 'idle');
    return entry;
  }

  private async waitReady(
    entry: Entry,
    d: BackendDescriptor,
    exited: Promise<unknown>,
  ): Promise<'ok' | 'timeout' | 'exited'> {
    const deadline = Date.now() + d.launch.startupTimeoutMs;
    let dead = false;
    void exited.then(() => (dead = true));
    while (Date.now() < deadline) {
      if (dead) return 'exited';
      if ((await this.probe(entry.agent.url, d.launch.readyPath)).ok) return 'ok';
      await Promise.race([sleep(150), exited]);
    }
    return 'timeout';
  }

  private failStart(
    entry: Entry,
    port: number,
    code: StartErrorCode,
    message: string,
    hint?: string,
  ): never {
    this.ports.release(port);
    entry.agent.status = 'stopped';
    entry.stoppedAt = Date.now();
    const logTail = entry.tail.tail(30);
    throw new AgentStartError(
      code,
      `${message}${logTail.length ? `\n--- last output ---\n${logTail.join('\n')}` : ''}`,
      { logTail, ...(hint ? { hint } : {}) },
    );
  }

  // ---- supervision ---------------------------------------------------------

  private async onExit(entry: Entry, port: number, code: number | null): Promise<void> {
    if (entry.stopping || entry.agent.status === 'stopped' || entry.agent.port !== port) return;
    await this.ledger.remove(entry.agent.id).catch(() => undefined);
    await this.recover(entry, `exited with code ${code}`);
  }

  /** After a crash or a dead health check: restart within policy, otherwise mark stopped. */
  private async recover(entry: Entry, why: string): Promise<void> {
    const policy = this.o.restart ?? { max: 2, backoffMs: 1000 };
    this.markStopped(entry);
    if (entry.restarts < policy.max) {
      entry.restarts += 1;
      await sleep(policy.backoffMs * entry.restarts);
      try {
        const restarts = entry.restarts;
        const next = await this.launch(entry.agent.id, entry.spec, entry.descriptor, entry);
        next.restarts = restarts;
        await this.emit('agent.restarted', next.agent, { reason: why });
        return;
      } catch {
        /* fall through to stopped */
      }
    }
    entry.agent.status = 'stopped';
    await this.emit('agent.stopped', entry.agent, { reason: why, lastOutput: entry.tail.tail(10) });
  }

  /** One round of health checks. Called on a timer; exposed for tests. */
  async checkHealth(): Promise<void> {
    const h = this.o.health ?? { intervalMs: 15_000, timeoutMs: 3000, maxFailures: 3 };
    for (const e of [...this.entries.values()]) {
      if (!['idle', 'busy', 'unhealthy'].includes(e.agent.status) || e.stopping) continue;
      const r = await this.probe(e.agent.url, e.descriptor.launch.readyPath, h.timeoutMs);
      if (r.ok) {
        e.failures = 0;
        e.agent.lastHealthAt = this.o.clock.now().toISOString();
        if (e.agent.status === 'unhealthy')
          await this.setStatus(e, e.agent.assignment ? 'busy' : 'idle');
        continue;
      }
      e.failures += 1;
      if (e.failures >= h.maxFailures) {
        e.stopping = true;
        if (e.child?.pid) await killTree(e.child.pid, { ops: this.ops, graceMs: 500 });
        e.stopping = false;
        await this.recover(e, 'health checks failed');
      } else if (e.agent.status !== 'unhealthy') {
        await this.setStatus(e, 'unhealthy');
      }
    }
  }

  /** Stops idle, unassigned agents past the TTL and forgets old stopped ones. */
  async reap(): Promise<{ stopped: string[]; forgotten: string[] }> {
    const now = Date.now();
    const idleTtl = this.o.idleTtlMs ?? 600_000;
    const stoppedTtl = this.o.stoppedTtlMs ?? 300_000;
    const stopped: string[] = [];
    const forgotten: string[] = [];
    for (const [id, e] of [...this.entries]) {
      if (
        e.agent.status === 'idle' &&
        !e.agent.assignment &&
        idleTtl > 0 &&
        now - e.lastActive > idleTtl
      ) {
        await this.stop(id);
        stopped.push(id);
      } else if (e.agent.status === 'stopped' && e.stoppedAt && now - e.stoppedAt > stoppedTtl) {
        this.entries.delete(id);
        rmSync(join(this.o.dataDir, 'agents', id), { recursive: true, force: true });
        forgotten.push(id);
      }
    }
    return { stopped, forgotten };
  }

  /** Last lines the process printed (for diagnostics screens). */
  logTail(id: string, n = 50): string[] {
    return this.entries.get(id)?.tail.tail(n) ?? [];
  }

  // ---- helpers -------------------------------------------------------------

  private markStopped(e: Entry): void {
    if (e.agent.port) this.ports.release(e.agent.port);
    e.agent.status = 'stopped';
    e.stoppedAt = Date.now();
    delete e.agent.assignment;
  }

  private async setStatus(e: Entry, status: Agent['status'], eventType?: string): Promise<void> {
    e.agent.status = status;
    const type =
      eventType ??
      {
        idle: 'agent.idle',
        busy: 'agent.busy',
        unhealthy: 'agent.unhealthy',
        stopped: 'agent.stopped',
        starting: 'agent.spawned',
      }[status];
    await this.emit(type, e.agent);
  }

  private async emit(type: string, a: Agent, extra: Record<string, unknown> = {}): Promise<void> {
    await this.o.events
      .append({
        type,
        subject: { type: 'agent', id: a.id },
        data: { agentId: a.id, status: a.status, role: a.role, backend: a.backend, ...extra },
      })
      .catch(() => undefined);
  }

  private async probe(base: string, path: string, timeoutMs = 2000): Promise<{ ok: boolean }> {
    try {
      const res = await this.doFetch(`${base}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
      return { ok: res.ok };
    } catch {
      return { ok: false };
    }
  }

  private async fetchJson(
    base: string,
    path: string,
  ): Promise<Record<string, unknown> | undefined> {
    try {
      const res = await this.doFetch(`${base}${path}`, { signal: AbortSignal.timeout(2000) });
      return res.ok ? ((await res.json()) as Record<string, unknown>) : undefined;
    } catch {
      return undefined;
    }
  }
}
