import { join } from 'node:path';
import { FsArtifactStore, FsAuditBlobs } from '@kramahq/artifacts-fs';
import {
  A2AGateway,
  BackendRegistry,
  ProcessAgentRuntime,
  validateOptions,
  type RuntimeOptions,
} from '@kramahq/agents';
import { Git, Sources, type SourceEvent } from '@kramahq/git';
import type { ActorRef, AgentDefinition, Pack } from '@kramahq/contract';
import {
  AuditWriter,
  EnvSecretResolver,
  NullNotifier,
  Redactor,
  SystemClock,
  TranscriptRecorder,
  UlidIdGenerator,
  createEngine,
  createGatewayTap,
  type Engine,
  type Policy,
  type Ports,
  type SecretResolver,
} from '@kramahq/engine';
import {
  AgentEventCollector,
  EventTokens,
  OrchestratorMcp,
  OrchestratorRunner,
  TokenRegistry,
  resolveGraphBackends,
  type AgentDirectory,
  type SubAgentsOptions,
} from '@kramahq/orchestrator-mcp';
import { PgStore, openPglite, type OpenedStore } from '@kramahq/store';
import { PackManager } from './packs/index.js';

/** An agent definition together with its persona text (the contents of its `prompt.md`). */
export interface DefinitionBundle {
  definition: AgentDefinition;
  systemPrompt?: string;
}

export interface KramaOptions {
  /** Where the database, artifacts, agent configs and workspaces live. */
  home: string;
  packs: Pack[];
  definitions: DefinitionBundle[];
  /** Platform policy: allowed backends, default orchestrator, default delegation mode, budget. */
  policy?: Policy;
  /** Backends known to this server. Default: the built-in wrapper backends. */
  backends?: BackendRegistry;
  /** How a backend is executed. Default: its `bin` on PATH. Tests and the demo point this at a script. */
  resolveCommand?: RuntimeOptions['resolveCommand'];
  /** Sub-agent timings for `native` delegation. */
  subAgents?: SubAgentsOptions;
  /**
   * Where the audit record lives. `same` (default): in the main database. `separate`: in its own embedded database under
   * `<home>/audit-db`, which keeps heavy audit writes from slowing the event log (measured in the M2.5 spike; it matters
   * on PGlite, which runs one query at a time, and not on Postgres).
   */
  auditStorage?: 'same' | 'separate';
  /** Git sources: which remotes may be used, which are trusted, and whether they must be signed. */
  sources?: {
    allow?: string[];
    trusted?: string[];
    requireSigned?: boolean;
    /** The git runner; tests isolate it from the machine's own configuration. */
    git?: Git;
  };
  /** This Krama's version, for each pack's `engine` range. */
  engineVersion?: string;
  onError?: (e: unknown, where: string) => void;
}

export interface Krama {
  engine: Engine;
  ports: Ports;
  /** Writes everything said and done in a run to the audit ledger, with secrets masked first. */
  transcript: TranscriptRecorder;
  mcp: OrchestratorMcp;
  /** Where agents Krama does not call itself report their activity and usage (`POST /agent-events`). */
  collector: AgentEventCollector;
  runner: OrchestratorRunner;
  runtime: ProcessAgentRuntime;
  /** The packs on this machine: those shipped with this build and those installed from git. */
  packs: PackManager;
  /** Other people's repositories: mirrors, pinned work trees and the lock file. */
  sources: Sources;
  backends: BackendRegistry;
  /** The agent definitions this server was started with (from its packs and local files). */
  definitions: readonly DefinitionBundle[];
  /** Where agent workspaces live: `runs/<runId>/shared` and `runs/<runId>/agents/<agentId>` under it. */
  workspaceRoot: string;
  /** Stops agents, the MCP endpoint and the database. Safe to call twice. */
  close(): Promise<void>;
}

/**
 * The composition root: the one place that wires adapters to the engine's ports. Local and embedded (PGlite, files on
 * disk, wrapper processes), no Docker and no native modules.
 */
export async function createKrama(o: KramaOptions): Promise<Krama> {
  const backends = o.backends ?? BackendRegistry.withBuiltins();
  const db: OpenedStore = await openPglite(join(o.home, 'db'));
  const auditDb: OpenedStore | undefined =
    o.auditStorage === 'separate' ? await openPglite(join(o.home, 'audit-db')) : undefined;
  const clock = new SystemClock();
  const ids = new UlidIdGenerator();
  // Secrets the platform knows about (the ones it passes to agents, the tokens it issues) are masked before anything is
  // recorded, so they never reach the ledger.
  const redactor = new Redactor();
  for (const [k, v] of Object.entries(process.env))
    if (k.startsWith('KRAMA_SECRET_')) redactor.addValue(v, 'secret');
  const envSecrets = new EnvSecretResolver();
  const secrets: SecretResolver = {
    resolve: async (ref) => {
      const v = await envSecrets.resolve(ref);
      redactor.addValue(v, `secret:${ref}`);
      return v;
    },
  };
  const ledger = (auditDb ?? db).ledger;
  const auditBlobs = new FsAuditBlobs(join(o.home, 'audit-blobs'));
  const transcript = new TranscriptRecorder({
    writer: new AuditWriter(ledger, auditBlobs),
    redactor,
    ...(o.onError ? { onError: (e, where) => o.onError!(e, where) } : {}),
  });
  const runtime = new ProcessAgentRuntime({
    catalog: backends,
    events: db.events,
    ids,
    clock,
    secrets,
    dataDir: join(o.home, 'agents-data'),
    ...(o.resolveCommand ? { resolveCommand: o.resolveCommand } : {}),
  });
  const control = async (
    kind: string,
    actor: ActorRef,
    subject: { type: string; id: string },
    detail: Record<string, unknown>,
  ): Promise<void> => {
    await ledger.append({
      chain: 'control',
      actor: {
        type: actor.type === 'schedule' ? 'system' : actor.type,
        id: actor.id,
        ...(actor.role ? { role: actor.role } : {}),
      },
      kind,
      source: actor.type === 'system' ? 'system' : 'api',
      sourceEventId: ids.next('aud'),
      payload: { subject, ...(actor.name ? { actorName: actor.name } : {}), detail },
    });
  };
  const sources = await Sources.open({
    root: join(o.home, 'sources'),
    ...(o.sources?.git ? { git: o.sources.git } : {}),
    ...(o.sources?.allow ? { allow: o.sources.allow } : {}),
    ...(o.sources?.requireSigned ? { requireSigned: true } : {}),
    // What the platform does with other people's repositories is part of the record, whoever asked.
    onEvent: (e: SourceEvent) => {
      if (e.type === 'source.fetched') return;
      void control(
        e.type,
        { type: 'system', id: 'engine' },
        { type: 'source', id: 'url' in e ? e.url : e.entry.url },
        { ...e },
      ).catch((err: unknown) => o.onError?.(err, 'sources'));
    },
  });
  const packManager = await PackManager.open({
    dir: join(o.home, 'packs'),
    sources,
    backends,
    secrets,
    checkProviderConfig: (d, section) =>
      validateOptions(d, section).map((i) => ({ path: i.path, message: i.message })),
    allowedBackends: o.policy?.allowedBackends,
    trusted: o.sources?.trusted,
    engineVersion: o.engineVersion ?? '0.0.0',
    builtin: o.packs,
    audit: control,
  });
  const ports: Ports = {
    // With the audit record in its own database a store transaction cannot include it: those writes follow the change instead.
    store: auditDb ? new PgStore(db.db) : db.store,
    events: db.events,
    artifacts: new FsArtifactStore({
      dir: join(o.home, 'artifacts'),
      catalog: db.store.artifacts,
      ids,
      clock,
    }),
    packs: packManager,
    clock,
    ids,
    notifier: new NullNotifier(),
    secrets,
    memory: db.memory,
    ledger,
    auditBlobs,
    transcript,
    gateway: new A2AGateway({ tap: createGatewayTap(transcript) }),
    backends,
    agents: runtime,
  };
  const engine = createEngine(ports, o.policy ?? {});

  const byId = new Map(o.definitions.map((b) => [b.definition.id, b]));
  const directory: AgentDirectory = {
    definitions: () => o.definitions.map((b) => b.definition),
    systemPrompt: (id) => byId.get(id)?.systemPrompt ?? '',
    backendUsable: (b) => backends.get(b) !== undefined,
    agentFiles: (pack, agentId) => packManager.agentFiles(pack, agentId),
  };
  // A graph pack's real orchestrator and backends are known before its run is accepted, so policy covers them (#35).
  ports.graphs = { resolve: (pack) => resolveGraphBackends({ ports, directory }, pack) };
  const mcp = new OrchestratorMcp({
    engine,
    ports,
    directory,
    tokens: new TokenRegistry(undefined, (t) => redactor.addValue(t, 'krama-token')),
    ...(o.onError ? { onError: (e, tool) => o.onError!(e, `mcp:${tool}`) } : {}),
  });
  const mcpBaseUrl = await mcp.listen();
  const collector = new AgentEventCollector({
    engine,
    ports,
    tokens: new EventTokens(undefined, (t) => redactor.addValue(t, 'krama-token')),
    ...(o.onError ? { onError: (e) => o.onError!(e, 'collector') } : {}),
  });
  await collector.listen();
  const runner = new OrchestratorRunner({
    engine,
    ports,
    mcp,
    mcpBaseUrl,
    directory,
    collector,
    ...(o.subAgents ? { subAgents: o.subAgents } : {}),
    ...(o.onError ? { onError: o.onError } : {}),
  });
  ports.executor = runner; // the runner is told whenever a decision settles
  await runtime.start();

  let closed = false;
  return {
    engine,
    ports,
    transcript,
    mcp,
    collector,
    runner,
    runtime,
    packs: packManager,
    sources,
    backends,
    definitions: o.definitions,
    workspaceRoot: join(o.home, 'agents-data', 'workspaces'),
    async close() {
      if (closed) return;
      closed = true;
      await runner.shutdown();
      await mcp.close();
      await collector.close();
      await runtime.shutdown();
      await transcript.closeAll(); // whatever a run's record is missing is written down before the database closes
      await db.close();
      await auditDb?.close();
    },
  };
}
