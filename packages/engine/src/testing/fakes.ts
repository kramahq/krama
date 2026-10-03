import { createHash } from 'node:crypto';
import type {
  Artifact,
  EventEnvelope,
  MemoryRecord,
  Pack,
  Project,
  Run,
  Step,
  AuditEntry,
} from '@kramahq/contract';
import type { DecisionRecord } from '../domain/decision.js';
import {
  CursorGoneError,
  VersionConflictError,
  type AgentGateway,
  type AgentRef,
  type ArtifactCatalog,
  type ArtifactContent,
  type ArtifactStore,
  type AuditLog,
  type ByteRange,
  type Clock,
  type DecisionQuery,
  type DecisionRepository,
  type EventDraft,
  type EventLog,
  type EventReadOptions,
  type GatewayEvent,
  type IdGenerator,
  type ListOptions,
  type MemoryQuery,
  type MemoryStore,
  type Notifier,
  type Page,
  type PackRepository,
  type Ports,
  type ProjectRepository,
  type PutArtifact,
  type RunExecutor,
  type RunQuery,
  type RunRecord,
  type RunRepository,
  type SecretResolver,
  type SendMessage,
  type Store,
  type StepRepository,
  type UsageEntry,
  type UsageLedger,
  type Versioned,
} from '../ports/index.js';

// ---- Deterministic clock and ids -------------------------------------------

export class FakeClock implements Clock {
  constructor(private t = Date.parse('2026-10-03T09:00:00.000Z')) {}
  now(): Date {
    return new Date(this.t);
  }
  advance(ms: number): void {
    this.t += ms;
  }
  set(iso: string): void {
    this.t = Date.parse(iso);
  }
}

/** `run_000001`-style ids: sortable and deterministic. */
export class SequentialIds implements IdGenerator {
  private n = 0;
  next<P extends string>(prefix: P): `${P}_${string}` {
    return `${prefix}_${String(++this.n).padStart(6, '0')}`;
  }
}

// ---- Generic versioned map -------------------------------------------------

class VersionedMap<T extends { id: string }> {
  private m = new Map<string, Versioned<T>>();
  get(id: string): Versioned<T> | undefined {
    const v = this.m.get(id);
    return v ? { value: structuredClone(v.value), version: v.version } : undefined;
  }
  put(value: T, expected?: number): Versioned<T> {
    const cur = this.m.get(value.id);
    if (expected === undefined ? cur !== undefined : cur?.version !== expected)
      throw new VersionConflictError(value.id, expected, cur?.version);
    const next = { value: structuredClone(value), version: (cur?.version ?? 0) + 1 };
    this.m.set(value.id, next);
    return { value: structuredClone(next.value), version: next.version };
  }
  all(): Versioned<T>[] {
    return [...this.m.values()].map((v) => ({
      value: structuredClone(v.value),
      version: v.version,
    }));
  }
  snapshot(): Map<string, Versioned<T>> {
    return new Map(this.m);
  }
  restore(s: Map<string, Versioned<T>>): void {
    this.m = new Map(s);
  }
}

const paginate = <T>(items: T[], o: ListOptions = {}): Page<T> => {
  const limit = o.limit ?? 50;
  const start = Number(o.cursor ?? 0) || 0;
  return {
    items: items.slice(start, start + limit),
    ...(start + limit < items.length ? { nextCursor: String(start + limit) } : {}),
  };
};

// ---- Store -----------------------------------------------------------------

class MemRuns implements RunRepository {
  readonly map = new VersionedMap<RunRecord & { id: string }>();
  private strip = (v: Versioned<RunRecord & { id: string }>): Versioned<RunRecord> => {
    const rest: Partial<RunRecord & { id: string }> = { ...v.value };
    delete rest.id;
    return { value: rest as RunRecord, version: v.version };
  };
  async get(id: string) {
    const v = this.map.get(id);
    return v ? this.strip(v) : undefined;
  }
  async put(r: RunRecord, expected?: number) {
    return this.strip(this.map.put({ ...r, id: r.run.id }, expected));
  }
  async findByIdempotencyKey(key: string) {
    const v = this.map.all().find((x) => x.value.idempotencyKey === key);
    return v ? this.strip(v) : undefined;
  }
  async list(q: RunQuery = {}) {
    const text = q.q?.toLowerCase();
    const rows = this.map
      .all()
      .map((v) => this.strip(v))
      .filter(
        ({ value: { run } }) =>
          (!q.status || q.status.includes(run.status)) &&
          (!q.packId || run.pack.id === q.packId) &&
          (!q.projectId || run.projectId === q.projectId) &&
          (!text || run.title.toLowerCase().includes(text)),
      )
      .sort((a, b) =>
        a.value.run.createdAt < b.value.run.createdAt
          ? 1
          : a.value.run.createdAt > b.value.run.createdAt
            ? -1
            : b.value.run.id.localeCompare(a.value.run.id),
      );
    return paginate(rows, q);
  }
}

class MemDecisions implements DecisionRepository {
  readonly map = new VersionedMap<DecisionRecord & { id: string }>();
  private strip = (v: Versioned<DecisionRecord & { id: string }>): Versioned<DecisionRecord> => ({
    value: { decision: v.value.decision, effects: v.value.effects },
    version: v.version,
  });
  async get(id: string) {
    const v = this.map.get(id);
    return v ? this.strip(v) : undefined;
  }
  async put(r: DecisionRecord, expected?: number) {
    return this.strip(this.map.put({ ...r, id: r.decision.id }, expected));
  }
  async list(q: DecisionQuery = {}) {
    const rows = this.map
      .all()
      .map((v) => this.strip(v))
      .filter(
        ({ value: { decision: d } }) =>
          (!q.status || q.status.includes(d.status)) &&
          (!q.kind || q.kind.includes(d.kind)) &&
          (!q.runId || d.runId === q.runId),
      )
      .sort((a, b) =>
        a.value.decision.createdAt > b.value.decision.createdAt
          ? 1
          : a.value.decision.createdAt < b.value.decision.createdAt
            ? -1
            : a.value.decision.id.localeCompare(b.value.decision.id),
      );
    return paginate(rows, q);
  }
}

class MemSteps implements StepRepository {
  readonly map = new VersionedMap<Step>();
  async get(id: string) {
    return this.map.get(id);
  }
  async put(s: Step, expected?: number) {
    return this.map.put(s, expected);
  }
  async listByRun(runId: string) {
    return this.map
      .all()
      .map((v) => v.value)
      .filter((s) => s.runId === runId);
  }
}

class MemCatalog implements ArtifactCatalog {
  private m = new Map<string, Artifact>();
  snapshot() {
    return new Map(this.m);
  }
  restore(s: Map<string, Artifact>) {
    this.m = new Map(s);
  }
  async put(a: Artifact) {
    this.m.set(a.id, structuredClone(a));
  }
  async get(id: string) {
    const a = this.m.get(id);
    return a ? structuredClone(a) : undefined;
  }
  async findSuperseding(id: string) {
    const a = [...this.m.values()].find((x) => x.supersedes === id);
    return a ? structuredClone(a) : undefined;
  }
  async listByRun(
    runId: string,
    f: { phaseId?: string; type?: string; status?: Artifact['status'] } = {},
  ) {
    return [...this.m.values()]
      .filter(
        (a) =>
          a.runId === runId &&
          (!f.phaseId || a.phaseId === f.phaseId) &&
          (!f.type || a.type === f.type) &&
          (!f.status || a.status === f.status),
      )
      .sort((a, b) =>
        a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : a.createdAt < b.createdAt ? -1 : 1,
      )
      .map((a) => structuredClone(a));
  }
}

class MemProjects implements ProjectRepository {
  readonly map = new VersionedMap<Project>();
  async get(id: string) {
    return this.map.get(id);
  }
  async put(p: Project, expected?: number) {
    return this.map.put(p, expected);
  }
  async list(o?: ListOptions) {
    return paginate(
      this.map.all().sort((a, b) => a.value.name.localeCompare(b.value.name)),
      o,
    );
  }
}

class MemAudit implements AuditLog {
  readonly entries: AuditEntry[] = [];
  async append(e: AuditEntry) {
    this.entries.push(structuredClone(e));
  }
  async list(o: ListOptions & { actor?: string; action?: string } = {}) {
    return paginate(
      this.entries
        .filter((e) => (!o.actor || e.actor.id === o.actor) && (!o.action || e.action === o.action))
        .reverse(),
      o,
    );
  }
}

class MemUsage implements UsageLedger {
  readonly entries: UsageEntry[] = [];
  async append(e: UsageEntry) {
    this.entries.push(structuredClone(e));
  }
  async forRun(runId: string) {
    return this.entries.filter((e) => e.runId === runId).map((e) => structuredClone(e));
  }
}

/** In-memory Store. `transaction` snapshots every collection and restores them if the callback throws. */
export class InMemoryStore implements Store {
  readonly runs = new MemRuns();
  readonly decisions = new MemDecisions();
  readonly steps = new MemSteps();
  readonly artifacts = new MemCatalog();
  readonly projects = new MemProjects();
  readonly audit = new MemAudit();
  readonly usage = new MemUsage();
  private depth = 0;

  async transaction<T>(fn: (tx: Store) => Promise<T>): Promise<T> {
    if (this.depth > 0) return fn(this);
    const snap = {
      r: this.runs.map.snapshot(),
      d: this.decisions.map.snapshot(),
      s: this.steps.map.snapshot(),
      p: this.projects.map.snapshot(),
      c: this.artifacts.snapshot(),
      a: this.audit.entries.length,
      u: this.usage.entries.length,
    };
    this.depth++;
    try {
      return await fn(this);
    } catch (e) {
      this.runs.map.restore(snap.r);
      this.decisions.map.restore(snap.d);
      this.steps.map.restore(snap.s);
      this.projects.map.restore(snap.p);
      this.artifacts.restore(snap.c);
      this.audit.entries.length = snap.a;
      this.usage.entries.length = snap.u;
      throw e;
    } finally {
      this.depth--;
    }
  }
}

// ---- Event log -------------------------------------------------------------

export const topicMatches = (e: EventEnvelope, topics: string[] | undefined): boolean => {
  if (!topics || topics.length === 0) return true;
  return topics.some((t) => {
    const [kind, id] = t.split(':') as [string, string | undefined];
    switch (kind) {
      case 'run':
        return e.runId === id;
      case 'runs':
        return e.type.startsWith('run.');
      case 'inbox':
        return e.type.startsWith('decision.');
      case 'agent':
        return e.subject.type === 'agent' && e.subject.id === id;
      case 'agents':
        return e.type.startsWith('agent.');
      case 'memory':
        return e.type.startsWith('memory.');
      case 'schedules':
        return e.type.startsWith('schedule.');
      case 'packs':
        return e.type.startsWith('pack.');
      case 'operations':
        return e.type.startsWith('operation.') && (!id || e.subject.id === id);
      case 'audit':
        return e.type === 'audit.recorded';
      default:
        return false;
    }
  });
};

export class InMemoryEventLog implements EventLog {
  private events: EventEnvelope[] = [];
  private seq = 1;
  private floor = 1;
  private listeners = new Set<{ fn: (e: EventEnvelope) => void; topics?: string[] }>();
  constructor(
    private readonly clock: Clock = new FakeClock(),
    private readonly retain = 5000,
  ) {}

  async append(d: EventDraft): Promise<EventEnvelope> {
    const e: EventEnvelope = {
      ...structuredClone(d),
      id: String(this.seq++).padStart(9, '0'),
      at: this.clock.now().toISOString(),
      schema: 1,
    };
    this.events.push(e);
    if (this.events.length > this.retain) {
      this.events.shift();
      this.floor = Number(this.events[0]!.id);
    }
    for (const l of this.listeners) if (topicMatches(e, l.topics)) l.fn(structuredClone(e));
    return structuredClone(e);
  }
  async read(o: EventReadOptions = {}): Promise<EventEnvelope[]> {
    if (o.after !== undefined && Number(o.after) + 1 < this.floor)
      throw new CursorGoneError(o.after);
    const n = o.after ? Number(o.after) : 0;
    return this.events
      .filter((e) => Number(e.id) > n && topicMatches(e, o.topics))
      .slice(0, o.limit ?? 200)
      .map((e) => structuredClone(e));
  }
  subscribe(fn: (e: EventEnvelope) => void, topics?: string[]): () => void {
    const l = { fn, ...(topics ? { topics } : {}) };
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  async latestCursor() {
    return this.events.at(-1)?.id;
  }
}

// ---- Artifacts -------------------------------------------------------------

const sha256 = async (bytes: Uint8Array): Promise<string> =>
  createHash('sha256').update(bytes).digest('hex');

export class InMemoryArtifactStore implements ArtifactStore {
  private meta = new Map<string, Artifact>();
  private blobs = new Map<string, Uint8Array>();
  constructor(
    private readonly clock: Clock = new FakeClock(),
    private readonly ids: IdGenerator = new SequentialIds(),
  ) {}

  async put(i: PutArtifact): Promise<Artifact> {
    const digest = await sha256(i.bytes);
    this.blobs.set(digest, new Uint8Array(i.bytes));
    const prev = i.supersedes ? this.meta.get(i.supersedes) : undefined;
    if (i.supersedes && !prev) throw new Error(`Cannot supersede unknown artifact ${i.supersedes}`);
    const a: Artifact = {
      id: this.ids.next('art'),
      ...(i.runId ? { runId: i.runId as Artifact['runId'] } : {}),
      ...(i.phaseId ? { phaseId: i.phaseId } : {}),
      ...(i.stepId ? { stepId: i.stepId as Artifact['stepId'] } : {}),
      name: i.name,
      type: i.type,
      mediaType: i.mediaType,
      size: i.bytes.byteLength,
      sha256: digest,
      version: (prev?.version ?? 0) + 1,
      ...(prev ? { supersedes: prev.id } : {}),
      status: 'draft',
      producer: i.producer,
      ...(i.summary ? { summary: i.summary } : {}),
      ...(i.derivedFrom ? { derivedFrom: i.derivedFrom as Artifact['derivedFrom'] } : {}),
      ...(i.meta ? { meta: i.meta } : {}),
      renditions: [],
      createdAt: this.clock.now().toISOString(),
      links: {},
    };
    if (prev) this.meta.set(prev.id, { ...prev, status: 'superseded' });
    this.meta.set(a.id, a);
    return structuredClone(a);
  }
  async get(id: string) {
    const a = this.meta.get(id);
    return a ? structuredClone(a) : undefined;
  }
  async read(id: string, range?: ByteRange): Promise<ArtifactContent | undefined> {
    const a = this.meta.get(id);
    const blob = a && this.blobs.get(a.sha256);
    if (!a || !blob) return undefined;
    if (!range) return { bytes: blob.slice(), mediaType: a.mediaType, size: a.size };
    const end = Math.min(range.end, blob.length - 1);
    return {
      bytes: blob.slice(range.start, end + 1),
      mediaType: a.mediaType,
      size: a.size,
      range: { start: range.start, end },
    };
  }
  async versions(id: string): Promise<Artifact[]> {
    let cur = this.meta.get(id);
    if (!cur) return [];
    const chain: Artifact[] = [];
    // Walk to the oldest, then forward through whoever supersedes.
    while (cur?.supersedes) cur = this.meta.get(cur.supersedes);
    while (cur) {
      chain.push(structuredClone(cur));
      const prevId: string = cur.id;
      cur = [...this.meta.values()].find((x) => x.supersedes === prevId);
    }
    return chain;
  }
  async listByRun(
    runId: string,
    f: { phaseId?: string; type?: string; status?: Artifact['status'] } = {},
  ) {
    return [...this.meta.values()]
      .filter(
        (a) =>
          a.runId === runId &&
          (!f.phaseId || a.phaseId === f.phaseId) &&
          (!f.type || a.type === f.type) &&
          (!f.status || a.status === f.status),
      )
      .map((a) => structuredClone(a));
  }
  async setStatus(id: string, status: Artifact['status']): Promise<Artifact> {
    const a = this.meta.get(id);
    if (!a) throw new Error(`Artifact ${id} not found`);
    const next = { ...a, status };
    this.meta.set(id, next);
    return structuredClone(next);
  }
}

// ---- Misc ports ------------------------------------------------------------

export class FakePackRepository implements PackRepository {
  constructor(private readonly packs: Pack[]) {}
  async get(id: string) {
    return this.packs.find((p) => p.id === id);
  }
  async list() {
    return [...this.packs];
  }
}

export class StaticSecretResolver implements SecretResolver {
  constructor(private readonly values: Record<string, string> = {}) {}
  async resolve(ref: string) {
    return this.values[ref];
  }
}

export class RecordingNotifier implements Notifier {
  readonly sent: EventEnvelope[] = [];
  async notify(e: EventEnvelope) {
    this.sent.push(e);
  }
}

export class RecordingExecutor implements RunExecutor {
  readonly signals: Parameters<RunExecutor['onDecisionResolved']>[0][] = [];
  async onDecisionResolved(s: Parameters<RunExecutor['onDecisionResolved']>[0]) {
    this.signals.push(s);
  }
}

export class InMemoryMemoryStore implements MemoryStore {
  private readonly map = new VersionedMap<MemoryRecord>();
  async get(id: string) {
    return this.map.get(id);
  }
  async put(r: MemoryRecord, expected?: number) {
    return this.map.put(r, expected);
  }
  async search(q: MemoryQuery) {
    const rows = this.map
      .all()
      .filter(
        ({ value: m }) =>
          (!q.scope || (m.scope.type === q.scope.type && m.scope.id === q.scope.id)) &&
          (!q.status || q.status.includes(m.status)) &&
          (!q.tag || m.tags.includes(q.tag)) &&
          (!q.q || m.content.toLowerCase().includes(q.q.toLowerCase())),
      );
    return paginate(rows, q);
  }
}

/** Scripted agent: replays the events queued for a role, so a run can complete with no real backend. */
export class FakeAgentGateway implements AgentGateway {
  readonly sent: { agent: AgentRef; text: string }[] = [];
  readonly canceled: string[] = [];
  constructor(private readonly script: Record<string, GatewayEvent[][]> = {}) {}
  queue(role: string, ...turns: GatewayEvent[][]): void {
    (this.script[role] ??= []).push(...turns);
  }
  async *send(agent: AgentRef, message: SendMessage): AsyncIterable<GatewayEvent> {
    this.sent.push({ agent, text: message.text });
    const turn = this.script[agent.role]?.shift() ?? [
      { kind: 'state', state: 'completed', taskId: `task_${agent.role}` },
    ];
    for (const e of turn) yield e;
  }
  async cancel(_agent: AgentRef, taskId: string) {
    this.canceled.push(taskId);
  }
}

// ---- Wiring ----------------------------------------------------------------

export interface FakePorts extends Ports {
  store: InMemoryStore;
  events: InMemoryEventLog;
  artifacts: InMemoryArtifactStore;
  clock: FakeClock;
  ids: SequentialIds;
  notifier: RecordingNotifier;
  executor: RecordingExecutor;
  memory: InMemoryMemoryStore;
  gateway: FakeAgentGateway;
}

/** A complete set of in-memory ports for tests, demos and the walking skeleton. */
export function createFakePorts(packs: Pack[] = []): FakePorts {
  const clock = new FakeClock();
  const ids = new SequentialIds();
  return {
    store: new InMemoryStore(),
    events: new InMemoryEventLog(clock),
    artifacts: new InMemoryArtifactStore(clock, ids),
    packs: new FakePackRepository(packs),
    clock,
    ids,
    notifier: new RecordingNotifier(),
    secrets: new StaticSecretResolver(),
    executor: new RecordingExecutor(),
    memory: new InMemoryMemoryStore(),
    gateway: new FakeAgentGateway(),
  };
}

export type { Run };
