import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  agentDefinition,
  agentPreviewRequest,
  type ActorRef,
  type AgentDefinition,
  type AgentPreview,
  type AgentPreviewRequest,
  type PermissionRequest,
} from '@kramahq/contract';
import { canonicalJson, DomainError, sha256Hex } from '@kramahq/engine';
import {
  loadAgentDir,
  permissionSurface,
  secretRefs,
  withAbsolutePaths,
  type AgentLoad,
  type PackLoad,
  type PackDiff,
} from '@kramahq/pack';
import { remoteAllowed, type SourceRef } from '@kramahq/git';
import type { PackManagerOptions } from '../packs/manager.js';
import { InstallError, consentFor, sourcePermission } from '../catalog-install.js';

type Consent = { granted: string[]; declined: string[] };
type Review = { previewId: string; manifestDigest: string; consent: Consent };
type Request = AgentPreviewRequest & { source: SourceRef };
interface Version {
  source: SourceRef;
  sha: string;
  digest: string;
  at: string;
  by: string;
  action: 'install' | 'update' | 'rollback';
  consent: Consent;
  definition: AgentDefinition;
  permissions: PermissionRequest[];
}
interface Entry {
  request: Request;
  current: Version;
  history: Version[];
}
interface Held {
  request: Request;
  preview: AgentPreview;
  expiresAt: number;
  /** The installed version reviewed by this update. */
  previous?: string;
}
export type AgentPoolOptions = Pick<
  PackManagerOptions,
  | 'dir'
  | 'sources'
  | 'backends'
  | 'secrets'
  | 'checkProviderConfig'
  | 'allowedBackends'
  | 'trusted'
  | 'audit'
  | 'now'
  | 'previewTtlMs'
> & {
  builtin?: readonly AgentDefinition[];
  /** Refuse mutations while an unfinished run may still select or use this definition. */
  inUse?: (definition: AgentDefinition) => Promise<boolean>;
};

/** Persistent, reviewed wrapper-config versions. Installing registers a definition; processes still start per run. */
export class AgentPool {
  private entries = new Map<string, Entry>();
  private readonly previews = new Map<string, Held>();
  private readonly configs = new Map<string, Record<string, unknown>>();
  private tail: Promise<unknown> = Promise.resolve();
  private readonly now: () => Date;
  private constructor(private readonly o: AgentPoolOptions) {
    this.now = o.now ?? (() => new Date());
  }

  static async open(o: AgentPoolOptions): Promise<AgentPool> {
    await mkdir(o.dir, { recursive: true });
    const pool = new AgentPool(o);
    let raw: { agents: Entry[] };
    try {
      raw = JSON.parse(await readFile(join(o.dir, 'registry.json'), 'utf8')) as { agents: Entry[] };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return pool;
      throw e;
    }
    for (const entry of raw.agents) {
      const id = entry.request.id;
      if (o.builtin?.some((d) => d.id === id))
        throw new InstallError(
          'conflict',
          `Installed agent ${id} conflicts with a built-in definition`,
        );
      for (const version of entry.history) {
        agentDefinition.parse(version.definition);
        const load = await pool.load(
          await o.sources.at(version.source, version.sha),
          version.definition.backend.secrets ?? {},
          version.source.path,
        );
        if (
          !load.ok ||
          pool.digest(
            {
              ...entry.request,
              source: version.source,
              secrets: version.definition.backend.secrets ?? {},
            },
            version.sha,
            load,
          ) !== version.digest
        )
          throw new InstallError(
            'invalid',
            `Installed agent ${id} no longer matches its recorded version`,
            load.issues.map((i) => ({ ...i, severity: i.severity === 'error' ? 'error' : 'warn' })),
          );
        pool.remember(version, load);
      }
      pool.entries.set(id, entry);
    }
    return pool;
  }

  list(): AgentDefinition[] {
    return [
      ...(this.o.builtin ?? []),
      ...[...this.entries.values()].map((e) => structuredClone(e.current.definition)),
    ];
  }
  get(id: string): AgentDefinition | undefined {
    return this.list().find((d) => d.id === id);
  }
  config(def: AgentDefinition): { json: Record<string, unknown> } | undefined {
    if (def.source.type !== 'git') return undefined;
    const json = this.configs.get(`${def.id}@${def.source.digest}`);
    if (!json) return undefined;
    const descriptor = this.o.backends.get(def.backend.wrapper);
    if (!descriptor || !(descriptor.providerKey in json))
      throw new DomainError(
        'invalid_graph',
        `Git-installed agent ${def.id} must use the backend its config was written for`,
      );
    const derived = structuredClone(json);
    // Peers and reporting are assigned by Krama for each run, never taken from a downloaded config.
    if ('subAgents' in derived) derived.subAgents = { enabled: false, agents: [] };
    if ('events' in derived) derived.events = { enabled: false };
    if (def.backend.model) {
      const parts = descriptor.mapping.model.split('.');
      let section = derived[descriptor.providerKey] as Record<string, unknown>;
      for (const part of parts.slice(0, -1))
        section = (section[part] ??= {}) as Record<string, unknown>;
      section[parts.at(-1)!] = def.backend.model;
    }
    return { json: derived };
  }
  versions(id: string) {
    const entry = this.entry(id);
    return structuredClone(
      [...entry.history].reverse().map((v, index) => ({
        sha: v.sha,
        digest: v.digest,
        source: v.source,
        at: v.at,
        by: v.by,
        action: v.action,
        consent: structuredClone(v.consent),
        current: index === 0,
      })),
    );
  }
  private entry(id: string): Entry {
    const entry = this.entries.get(id);
    if (!entry) throw new InstallError('not_found', `Agent ${id} is not installed from git`);
    return entry;
  }
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.tail.then(work, work);
    this.tail = run.catch(() => undefined);
    return run;
  }
  private async persist(entries: Map<string, Entry>): Promise<void> {
    const file = join(this.o.dir, 'registry.json');
    const temp = `${file}.${randomBytes(8).toString('hex')}.tmp`;
    await writeFile(
      temp,
      `${JSON.stringify({ version: 1, agents: [...entries.values()] }, null, 2)}\n`,
      { mode: 0o600 },
    );
    await rename(temp, file);
  }
  private load(
    path: string,
    secrets: Record<string, string>,
    sourcePath: string,
  ): Promise<AgentLoad> {
    const parents = sourcePath
      .split('/')
      .filter((p) => p && p !== '.')
      .map(() => '..');
    return loadAgentDir(path, this.o, secrets, resolve(path, ...parents));
  }
  private digest(request: Request, sha: string, load: AgentLoad): string {
    return sha256Hex(
      canonicalJson({
        id: request.id,
        source: request.source,
        sha,
        secrets: request.secrets,
        config: load.agent.config,
      }),
    );
  }
  private remember(version: Version, load: AgentLoad): void {
    this.configs.set(
      `${version.definition.id}@${version.digest}`,
      withAbsolutePaths(load.agent.config!, load.agent.dir!),
    );
  }
  private definition(
    request: Request,
    sha: string,
    digest: string,
    load: AgentLoad,
  ): AgentDefinition {
    const a = load.agent;
    const config = a.config!;
    const card = config.agentCard as {
      name: string;
      description: string;
      skills?: { id: string; tags?: string[] }[];
    };
    const backend = this.o.backends.get(a.backend!)!;
    const section = config[backend.providerKey] as Record<string, unknown>;
    const model = backend.mapping.model
      .split('.')
      .reduce<unknown>(
        (value, key) =>
          value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined,
        section,
      );
    const [role, variant] = request.id.split('/');
    return agentDefinition.parse({
      id: request.id,
      role,
      variant,
      name: card.name,
      description: card.description,
      backend: {
        wrapper: backend.id,
        ...(typeof model === 'string' ? { model } : {}),
        secrets: request.secrets,
      },
      skills: [],
      mcpServers: Object.keys((config.mcp ?? {}) as object),
      permissions: { tools: {} },
      memory: { enabled: !!config.memory, scopes: [] },
      capabilities: [
        ...new Set(
          (Array.isArray(card.skills) ? card.skills : []).flatMap((s) =>
            s && typeof s === 'object' ? [s.id, ...(Array.isArray(s.tags) ? s.tags : [])] : [],
          ),
        ),
      ].filter((s) => typeof s === 'string'),
      source: { type: 'git', ...request.source, sha, digest },
      links: {},
    });
  }
  private asPack(load: AgentLoad): PackLoad {
    return { ok: load.ok, issues: load.issues, agents: { agent: load.agent } };
  }
  async preview(input: AgentPreviewRequest): Promise<AgentPreview> {
    const parsed = agentPreviewRequest.parse(input);
    const request: Request = {
      ...parsed,
      source: {
        url: parsed.source.url,
        ref: parsed.source.ref?.trim() || 'HEAD',
        path: parsed.source.path ?? '',
      },
    };
    return this.build(request);
  }
  async previewUpdate(
    id: string,
    to?: { ref?: string; secrets?: Record<string, string> },
  ): Promise<AgentPreview> {
    const entry = this.entry(id);
    return this.build(
      {
        ...entry.request,
        secrets: to?.secrets ?? entry.current.definition.backend.secrets ?? {},
        source: { ...entry.current.source, ...(to?.ref ? { ref: to.ref } : {}) },
      },
      entry,
    );
  }
  private async build(request: Request, against?: Entry): Promise<AgentPreview> {
    const peek = await this.o.sources.peek(request.source);
    const load = await this.load(peek.dir, request.secrets, request.source.path);
    const trust =
      this.o.trusted?.length && remoteAllowed(request.source.url, this.o.trusted)
        ? 'trusted'
        : 'untrusted';
    const surface = load.ok ? await permissionSurface(this.asPack(load), this.o.backends) : [];
    const permissions = load.ok ? [...surface, ...sourcePermission(request.source, trust)] : [];
    const manifestDigest = load.ok ? this.digest(request, peek.sha, load) : '';
    const expiresAt = this.now().getTime() + (this.o.previewTtlMs ?? 30 * 60_000);
    const config = load.agent.config;
    const peers = config?.subAgents as
      { agents?: { name?: unknown; agentCardUrl?: unknown }[] } | undefined;
    const secretsToBind = await Promise.all(
      secretRefs(this.asPack(load)).map(async (s) => ({
        ...s,
        bound: (await this.o.secrets.resolve(s.ref)) !== undefined,
      })),
    );
    const definition = load.ok
      ? this.definition(request, peek.sha, manifestDigest, load)
      : undefined;
    let diff: PackDiff | undefined;
    if (against) {
      const previous = await this.load(
        await this.o.sources.at(against.current.source, against.current.sha),
        against.current.definition.backend.secrets ?? {},
        against.current.source.path,
      );
      diff = configDiff(
        {
          config: previous.agent.config,
          secrets: against.current.definition.backend.secrets ?? {},
        },
        { config: load.agent.config, secrets: request.secrets },
      );
      if (against.current.sha !== peek.sha)
        diff.changed.unshift({
          path: 'source.sha',
          summary: `${against.current.sha.slice(0, 10)} to ${peek.sha.slice(0, 10)}`,
        });
      if (against.current.source.ref !== request.source.ref)
        diff.changed.push({ path: 'source.ref', summary: 'The selected Git ref changed' });
      diff.permissionChanges = permissions.filter(
        (p) => !against.current.permissions.some((old) => canonicalJson(old) === canonicalJson(p)),
      );
    }
    const preview: AgentPreview = {
      previewId: `prev_${randomBytes(12).toString('hex')}`,
      manifestDigest,
      sha: peek.sha,
      ...(definition ? { definition } : {}),
      trust,
      issues: load.issues.map((i) => ({
        ...i,
        severity: i.severity === 'error' ? 'error' : 'warn',
      })),
      permissions,
      secretsToBind,
      declaredSubAgents:
        load.ok && Array.isArray(peers?.agents)
          ? peers.agents.flatMap((p) =>
              p && typeof p.name === 'string' && typeof p.agentCardUrl === 'string'
                ? [{ name: p.name, agentCardUrl: p.agentCardUrl }]
                : [],
            )
          : [],
      expiresAt: new Date(expiresAt).toISOString(),
      ...(diff ? { diff } : {}),
    };
    this.previews.set(preview.previewId, {
      request,
      preview,
      expiresAt,
      ...(against ? { previous: against.current.digest } : {}),
    });
    return structuredClone(preview);
  }
  private take(review: Review, id?: string): Held {
    const held = this.previews.get(review.previewId);
    if (!held || held.expiresAt <= this.now().getTime())
      throw new InstallError('conflict', 'That preview has expired; preview the agent again');
    if (held.preview.manifestDigest !== review.manifestDigest)
      throw new InstallError('conflict', 'The digest is not the one reviewed');
    if (!held.preview.definition)
      throw new InstallError('invalid', 'The agent configuration has errors', held.preview.issues);
    if (id ? held.request.id !== id || !held.previous : held.previous !== undefined)
      throw new InstallError('conflict', 'Use a preview for this agent and this operation');
    return held;
  }
  install(review: Review, actor: ActorRef): Promise<AgentDefinition> {
    return this.exclusive(async () => {
      const held = this.take(review);
      if (this.get(held.request.id))
        throw new InstallError(
          'conflict',
          `Agent ${held.request.id} already exists; update it instead`,
        );
      return this.apply(held, review, actor);
    });
  }
  update(id: string, review: Review, actor: ActorRef): Promise<AgentDefinition> {
    return this.exclusive(async () => {
      const entry = this.entry(id);
      const held = this.take(review, id);
      if (held.previous !== entry.current.digest)
        throw new InstallError('conflict', 'This agent changed since the update preview');
      await this.requireUnused(entry.current.definition);
      if (held.preview.manifestDigest === entry.current.digest)
        throw new InstallError('conflict', 'That is the version installed now');
      return this.apply(held, review, actor, entry);
    });
  }
  private async apply(
    held: Held,
    review: Review,
    actor: ActorRef,
    old?: Entry,
  ): Promise<AgentDefinition> {
    const previous = new Set(
      (old?.current.permissions ?? [])
        .filter((p) => held.preview.permissions.some((n) => canonicalJson(n) === canonicalJson(p)))
        .map((p) => p.id),
    );
    const consent = consentFor(held.preview.permissions, review.consent, previous, 'agent');
    // Recheck the moving ref, then pin the immutable commit under its own lock key. This never moves a pack's pin.
    const peek = await this.o.sources.peek(held.request.source);
    const load = await this.load(peek.dir, held.request.secrets, held.request.source.path);
    if (
      !load.ok ||
      peek.sha !== held.preview.sha ||
      this.digest(held.request, peek.sha, load) !== held.preview.manifestDigest
    )
      throw new InstallError(
        'conflict',
        'The source changed after preview; preview the agent again',
      );
    await this.o.sources.resolve({ ...held.request.source, ref: peek.sha });
    const definition = this.definition(held.request, peek.sha, held.preview.manifestDigest, load);
    const version: Version = {
      source: held.request.source,
      sha: peek.sha,
      digest: held.preview.manifestDigest,
      at: this.now().toISOString(),
      by: actor.id,
      action: old ? 'update' : 'install',
      consent,
      definition,
      permissions: held.preview.permissions,
    };
    const entry: Entry = {
      request: held.request,
      current: version,
      history: [...(old?.history ?? []), version],
    };
    const next = new Map(this.entries);
    next.set(definition.id, entry);
    await this.commit(next, () => this.record(version, actor));
    this.remember(version, load);
    this.previews.delete(review.previewId);
    return structuredClone(definition);
  }
  rollback(id: string, sha: string, actor: ActorRef, digest?: string): Promise<AgentDefinition> {
    return this.exclusive(async () => {
      const entry = this.entry(id);
      await this.requireUnused(entry.current.definition);
      const target = [...entry.history]
        .reverse()
        .find((v) => v.sha === sha && (!digest || v.digest === digest));
      if (!target) throw new InstallError('not_found', `Agent ${id} was never installed at ${sha}`);
      if (target.digest === entry.current.digest)
        throw new InstallError('conflict', 'That is the version installed now');
      await this.o.sources.at(target.source, target.sha);
      const version: Version = {
        ...target,
        at: this.now().toISOString(),
        by: actor.id,
        action: 'rollback',
      };
      const next = new Map(this.entries);
      next.set(id, {
        ...entry,
        request: {
          ...entry.request,
          source: target.source,
          secrets: target.definition.backend.secrets ?? {},
        },
        current: version,
        history: [...entry.history, version],
      });
      await this.commit(next, () => this.record(version, actor));
      return structuredClone(version.definition);
    });
  }
  uninstall(id: string, actor: ActorRef): Promise<void> {
    return this.exclusive(async () => {
      const entry = this.entry(id);
      await this.requireUnused(entry.current.definition);
      const next = new Map(this.entries);
      next.delete(id);
      await this.commit(next, async () => {
        await this.o.audit?.(
          'agent_definition.uninstalled',
          actor,
          { type: 'agent_definition', id },
          { sha: entry.current.sha, digest: entry.current.digest },
        );
      });
    });
  }
  private async commit(next: Map<string, Entry>, audit: () => Promise<void>): Promise<void> {
    await this.persist(next);
    try {
      await audit();
    } catch (e) {
      await this.persist(this.entries);
      throw e;
    }
    this.entries = next;
  }
  private async requireUnused(definition: AgentDefinition): Promise<void> {
    if (await this.o.inUse?.(definition))
      throw new InstallError(
        'conflict',
        `An active run may use ${definition.id}; stop or finish it before changing the installed agent`,
      );
  }
  private record(version: Version, actor: ActorRef): Promise<void> {
    return (
      this.o.audit?.(
        `agent_definition.${version.action === 'rollback' ? 'rolled_back' : version.action === 'update' ? 'updated' : 'installed'}`,
        actor,
        { type: 'agent_definition', id: version.definition.id },
        {
          sha: version.sha,
          digest: version.digest,
          source: version.source,
          consent: version.consent,
        },
      ) ?? Promise.resolve()
    );
  }
}

/** Paths changed between two configurations, without echoing config values into the diff. */
function configDiff(from: Record<string, unknown>, to: Record<string, unknown>): PackDiff {
  const diff: PackDiff = { added: [], removed: [], changed: [], permissionChanges: [] };
  const object = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === 'object' && !Array.isArray(v);
  const visit = (a: Record<string, unknown>, b: Record<string, unknown>, prefix = '') => {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (!(key in a)) diff.added.push(path);
      else if (!(key in b)) diff.removed.push(path);
      else if (object(a[key]) && object(b[key])) visit(a[key], b[key], path);
      else if (canonicalJson(a[key] ?? null) !== canonicalJson(b[key] ?? null))
        diff.changed.push({ path, summary: 'The configured value changed' });
    }
  };
  visit(from, to);
  return diff;
}
