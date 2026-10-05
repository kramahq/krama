import type {
  ActorRef,
  Agent,
  AgentDefinition,
  BackendDescriptor,
  Artifact,
  AuditEntry,
  Decision,
  EventEnvelope,
  MemoryRecord,
  Pack,
  Project,
  Run,
  RunStatus,
  Spend,
  Step,
  Usage,
  WorkItem,
} from '@kramahq/contract';
import type { DecisionRecord } from '../domain/decision.js';

// ---- Cross-cutting ---------------------------------------------------------

export interface Clock {
  now(): Date;
}

/** Prefixed, sortable ids such as `run_01J…` (contract section 3.1). */
export interface IdGenerator {
  next<P extends string>(prefix: P): `${P}_${string}`;
}

/** Resolves a secret reference to its value. Values must never be logged or put in events. */
export interface SecretResolver {
  resolve(ref: string): Promise<string | undefined>;
}

export interface Notifier {
  notify(event: EventEnvelope): Promise<void>;
}

// ---- Persistence -----------------------------------------------------------

/** Optimistic concurrency: every stored value carries a version, surfaced as an `ETag`. */
export interface Versioned<T> {
  value: T;
  version: number;
}

/** Thrown by `put` when `expectedVersion` does not match (HTTP 412). */
export class VersionConflictError extends Error {
  constructor(
    readonly id: string,
    readonly expected: number | undefined,
    readonly actual: number | undefined,
  ) {
    super(`Version conflict on ${id}: expected ${expected ?? 'new'}, found ${actual ?? 'none'}`);
    this.name = 'VersionConflictError';
  }
}

/** A run plus engine-private bookkeeping that is not part of the API shape. */
export interface RunRecord {
  run: Run;
  /** Automated evaluator loop counts per `from→to` pair. */
  loops: Record<string, number>;
  /** Budget warning already emitted (so it fires once). */
  warned?: boolean;
  /** A person chose to continue past the cap; budget enforcement is waived for this run. */
  capWaived?: boolean;
  idempotencyKey?: string;
}

export interface Page<T> {
  items: T[];
  nextCursor?: string;
}

export interface ListOptions {
  limit?: number;
  cursor?: string;
}

export interface RunQuery extends ListOptions {
  status?: RunStatus[];
  packId?: string;
  projectId?: string;
  q?: string;
}

export interface RunRepository {
  get(id: string): Promise<Versioned<RunRecord> | undefined>;
  /** `expectedVersion` undefined creates (fails if it exists); otherwise it must match. */
  put(record: RunRecord, expectedVersion?: number): Promise<Versioned<RunRecord>>;
  list(query?: RunQuery): Promise<Page<Versioned<RunRecord>>>;
  findByIdempotencyKey(key: string): Promise<Versioned<RunRecord> | undefined>;
}

export interface DecisionQuery extends ListOptions {
  status?: Decision['status'][];
  kind?: Decision['kind'][];
  runId?: string;
}

export interface DecisionRepository {
  get(id: string): Promise<Versioned<DecisionRecord> | undefined>;
  put(record: DecisionRecord, expectedVersion?: number): Promise<Versioned<DecisionRecord>>;
  list(query?: DecisionQuery): Promise<Page<Versioned<DecisionRecord>>>;
}

export interface StepRepository {
  get(id: string): Promise<Versioned<Step> | undefined>;
  put(step: Step, expectedVersion?: number): Promise<Versioned<Step>>;
  listByRun(runId: string): Promise<Step[]>;
}

export interface ProjectRepository {
  get(id: string): Promise<Versioned<Project> | undefined>;
  put(project: Project, expectedVersion?: number): Promise<Versioned<Project>>;
  list(options?: ListOptions): Promise<Page<Versioned<Project>>>;
}

export interface AuditLog {
  append(entry: AuditEntry): Promise<void>;
  list(options?: ListOptions & { actor?: string; action?: string }): Promise<Page<AuditEntry>>;
}

export interface UsageEntry {
  runId: string;
  phaseId?: string;
  stepId?: string;
  at: string;
  /** `null` = provider did not report cost; never estimated. */
  cost: Spend;
  usage: Usage[];
}

export interface UsageLedger {
  append(entry: UsageEntry): Promise<void>;
  forRun(runId: string): Promise<UsageEntry[]>;
}

/** Artifact metadata (blobs live in an `ArtifactStore` adapter such as `artifacts-fs`). */
export interface ArtifactCatalog {
  /** Insert or replace by id. */
  put(artifact: Artifact): Promise<void>;
  get(id: string): Promise<Artifact | undefined>;
  /** The artifact that supersedes `id`, if any. */
  findSuperseding(id: string): Promise<Artifact | undefined>;
  listByRun(
    runId: string,
    filter?: { phaseId?: string; type?: string; status?: Artifact['status'] },
  ): Promise<Artifact[]>;
}

export interface Store {
  runs: RunRepository;
  decisions: DecisionRepository;
  steps: StepRepository;
  artifacts: ArtifactCatalog;
  projects: ProjectRepository;
  audit: AuditLog;
  usage: UsageLedger;
  /** Runs `fn` atomically; if it throws, nothing is applied. */
  transaction<T>(fn: (tx: Store) => Promise<T>): Promise<T>;
}

// ---- Events ----------------------------------------------------------------

export type EventDraft = Omit<EventEnvelope, 'id' | 'at' | 'schema'>;

/** Thrown when a cursor is older than retention (HTTP 410 + snapshot link). */
export class CursorGoneError extends Error {
  constructor(readonly cursor: string) {
    super(`Cursor ${cursor} is older than retained history`);
    this.name = 'CursorGoneError';
  }
}

export interface EventReadOptions {
  /** Return events strictly after this cursor. */
  after?: string;
  /** Topics (`run:{id}`, `runs`, `inbox`, `agent:{id}`, `agents`, `memory`, `schedules`, `packs`, `operations:{id}`, `audit`). Empty = all. */
  topics?: string[];
  limit?: number;
}

export interface EventLog {
  /** Assigns a monotonic cursor and a timestamp. */
  append(draft: EventDraft): Promise<EventEnvelope>;
  read(options?: EventReadOptions): Promise<EventEnvelope[]>;
  /** Live tail; returns an unsubscribe function. */
  subscribe(listener: (e: EventEnvelope) => void, topics?: string[]): () => void;
  /** Cursor of the newest event, or `undefined` when empty. */
  latestCursor(): Promise<string | undefined>;
}

// ---- Artifacts -------------------------------------------------------------

export interface PutArtifact {
  runId?: string;
  phaseId?: string;
  stepId?: string;
  name: string;
  type: string;
  mediaType: string;
  producer: ActorRef;
  bytes: Uint8Array;
  summary?: string;
  derivedFrom?: string[];
  meta?: Record<string, unknown>;
  /** Id of the artifact this one supersedes (creates version n+1). */
  supersedes?: string;
}

export interface ByteRange {
  start: number;
  /** Inclusive. */
  end: number;
}

export interface ArtifactContent {
  bytes: Uint8Array;
  mediaType: string;
  /** Total size of the artifact, regardless of the range returned. */
  size: number;
  range?: ByteRange;
}

export interface ArtifactStore {
  /** Stores bytes content-addressed; computes size and sha256. */
  put(input: PutArtifact): Promise<Artifact>;
  get(id: string): Promise<Artifact | undefined>;
  read(id: string, range?: ByteRange): Promise<ArtifactContent | undefined>;
  /** Version chain from oldest to newest. */
  versions(id: string): Promise<Artifact[]>;
  listByRun(
    runId: string,
    filter?: { phaseId?: string; type?: string; status?: Artifact['status'] },
  ): Promise<Artifact[]>;
  setStatus(id: string, status: Artifact['status']): Promise<Artifact>;
}

// ---- Agents ----------------------------------------------------------------

export interface AgentRef {
  id: string;
  url: string;
  role: string;
  backend: string;
}

export type TaskState =
  'working' | 'input_required' | 'completed' | 'failed' | 'canceled' | 'timed_out';

/** Normalised events from an agent turn (A2A task state plus the wrapper's sideband). */
export type GatewayEvent =
  | {
      kind: 'state';
      state: TaskState;
      taskId: string;
      contextId?: string;
      text?: string;
      /** Set when `input_required` is a structured permission request rather than a question (wrapper task W3). */
      request?: { type: 'access'; path: string; mode?: 'read' | 'write' };
    }
  | {
      kind: 'sideband';
      type: 'tool_call' | 'tool_result' | 'thinking' | 'status' | 'message';
      text?: string;
      toolName?: string;
      isError?: boolean;
      durationMs?: number;
      raw?: unknown;
    }
  | { kind: 'artifact'; name: string; mediaType: string; bytes?: Uint8Array; data?: unknown }
  | { kind: 'usage'; usage: Usage[]; cost: Spend };

export interface SendMessage {
  text: string;
  /** Reuse an existing conversation. */
  contextId?: string;
  /** Overrides the default delegation timeout (long media jobs). */
  timeoutMs?: number;
  signal?: AbortSignal;
  /**
   * Who this call is for. Sent with the request so an agent can stamp it on its events and pass it on to the agents it
   * calls; an agent that does not read it is unaffected.
   */
  correlation?: {
    runId: string;
    phaseId?: string;
    stepId?: string;
    traceId?: string;
    parentAgentId?: string;
  };
}

export interface SpawnSpec {
  definition: AgentDefinition;
  /** Reuse an id (restart); generated when omitted. */
  instanceId?: string;
  /** Start on this port when it is free: the address agents that call this one were configured with. */
  preferredPort?: number;
  assignment?: Agent['assignment'];
  /** `isolated`: a private directory for this agent. `shared`: one directory shared by `key` (usually a run id). */
  workspace: { mode: 'isolated' | 'shared'; key: string };
  /**
   * Persona text, placed in the provider's own system-prompt key. When `baseConfig` is set the agent already has a
   * prompt of its own, so this text is appended to it instead.
   */
  systemPrompt?: string;
  /**
   * Start from the agent's own wrapper config, kept verbatim (PACK-FORMAT section 3), instead of building one from the
   * definition. `json` is an embedded config; `dir` is a directory holding `config.json`, and the derived file is written
   * next to it so relative paths keep working. The provider key in the config decides the backend.
   */
  baseConfig?: { json: Record<string, unknown> } | { dir: string };
  /** Deep-merged over the config just before launch: live sub-agents, events, anything Krama sets for this run. */
  overrides?: Record<string, unknown>;
  allowedTools?: string[];
  /** MCP servers for this agent, in the wrapper's `mcp` config format. */
  mcp?: Record<string, unknown>;
  /** Extra environment for this process (e.g. a scoped MCP token). Never logged. */
  env?: Record<string, string>;
}

export type AgentFilter = { status?: Agent['status'][]; role?: string; runId?: string };

/** Runs and supervises agent processes (A2A wrappers). The engine only sees this port. */
export interface AgentRuntime {
  spawn(spec: SpawnSpec): Promise<Agent>;
  /** Stops the process tree and releases its port and workspace lock. Idempotent. */
  stop(id: string): Promise<void>;
  restart(id: string): Promise<Agent>;
  get(id: string): Agent | undefined;
  list(filter?: AgentFilter): Agent[];
  /** Marks an instance as working for a run phase (or idle again). */
  assign(id: string, assignment: Agent['assignment'] | undefined): void;
  /** Address the gateway should talk to. */
  ref(id: string): AgentRef | undefined;
  /** Stops everything. Call on server shutdown. */
  shutdown(): Promise<void>;
}

/** Read access to registered backends (A2A wrappers). Adding a provider adds a descriptor; the engine never changes. */
export interface BackendCatalog {
  list(): BackendDescriptor[];
  get(id: string): BackendDescriptor | undefined;
}

export interface AgentGateway {
  send(agent: AgentRef, message: SendMessage): AsyncIterable<GatewayEvent>;
  cancel(agent: AgentRef, taskId: string): Promise<void>;
}

/** Notified whenever a decision settles, including rejections, so a waiting executor never hangs. */
export interface RunExecutor {
  onDecisionResolved(signal: {
    runId: string;
    decisionId: string;
    effect: string;
    optionId: string;
    input?: string;
  }): Promise<void>;
}

// ---- Catalog and sources ---------------------------------------------------

export interface PackRepository {
  get(id: string): Promise<Pack | undefined>;
  list(): Promise<Pack[]>;
}

export interface WorkItemSource {
  readonly id: string;
  get(ref: string): Promise<WorkItem | undefined>;
  search(query: string): Promise<WorkItem[]>;
}

export interface MemoryQuery extends ListOptions {
  scope?: MemoryRecord['scope'];
  status?: MemoryRecord['status'][];
  tag?: string;
  q?: string;
}

export interface MemoryStore {
  get(id: string): Promise<Versioned<MemoryRecord> | undefined>;
  put(record: MemoryRecord, expectedVersion?: number): Promise<Versioned<MemoryRecord>>;
  search(query: MemoryQuery): Promise<Page<Versioned<MemoryRecord>>>;
}

/** Everything the application layer needs. Adapters implement the ports; `apps/server` wires them. */
export interface Ports {
  store: Store;
  events: EventLog;
  artifacts: ArtifactStore;
  packs: PackRepository;
  clock: Clock;
  ids: IdGenerator;
  notifier: Notifier;
  secrets: SecretResolver;
  memory?: MemoryStore;
  gateway?: AgentGateway;
  executor?: RunExecutor;
  workItems?: readonly WorkItemSource[];
  backends?: BackendCatalog;
  agents?: AgentRuntime;
}
