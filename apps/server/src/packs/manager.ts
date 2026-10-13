import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { remoteAllowed, type LockEntry, type SourceRef, type Sources } from '@kramahq/git';
import {
  diffLoads,
  engineCompatible,
  loadPackDir,
  permissionSurface,
  secretRefs,
  toPack,
  type PackDiff,
  type PackLoad,
  type PackLoadEnv,
  withAbsolutePaths,
} from '@kramahq/pack';
import type { ActorRef, Pack, PackPreview, PermissionRequest } from '@kramahq/contract';
import type { BackendCatalog, PackRepository, SecretResolver } from '@kramahq/engine';

/** Why a pack operation did not happen, in terms a route can map to a status. */
export class PackError extends Error {
  constructor(
    readonly code:
      'not_found' | 'conflict' | 'invalid' | 'forbidden' | 'blocked' | 'engine_incompatible',
    message: string,
    readonly issues: { severity: 'warn' | 'error'; message: string; path?: string }[] = [],
  ) {
    super(message);
    this.name = 'PackError';
  }
}

export interface PackSource {
  url: string;
  ref?: string | undefined;
  path?: string | undefined;
}

/** One installed version of a pack, with every pin it used, so putting it back puts its agents back too. */
export interface PackVersion {
  /** Where this version came from (a ref and a path), kept so that putting it back puts the source back. */
  source: { url: string; ref: string; path: string };
  sha: string;
  version: string;
  digest: string;
  at: string;
  by: string;
  action: 'install' | 'update' | 'rollback';
  consent?: { granted: string[]; declined: string[] };
  locks: LockEntry[];
}

interface Entry {
  id: string;
  name: string;
  source: { url: string; ref: string; path: string };
  status: 'installed' | 'disabled';
  trust: Pack['trust'];
  current: PackVersion;
  history: PackVersion[];
}

interface Held {
  src: { url: string; ref: string; path: string };
  sha: string;
  digest: string;
  packId: string;
  /** The installed pack this preview would replace, if it is an update. */
  updates?: string;
  compatible: boolean;
  /** What stopped the pack loading, so installing the preview says why instead of that it is "gone". */
  errors?: PackPreview['issues'];
  expiresAt: number;
}

export interface PackManagerOptions {
  /** Where the registry lives. */
  dir: string;
  sources: Sources;
  backends: BackendCatalog;
  secrets: SecretResolver;
  /** The provider-config check the pack loader runs (the agents package's `validateOptions`). */
  checkProviderConfig?: PackLoadEnv['checkProviderConfig'];
  allowedBackends?: readonly string[] | undefined;
  /** Remotes whose packs are `trusted`; anything else installs as `untrusted`. */
  trusted?: readonly string[] | undefined;
  /** The Krama version, for each pack's `engine` range. */
  engineVersion: string;
  /** Packs that ship with this build and are not installed from anywhere. */
  builtin?: readonly Pack[];
  /** Told what happened, by whom, for the audit record. */
  audit?: (
    kind: string,
    actor: ActorRef,
    subject: { type: string; id: string },
    detail: Record<string, unknown>,
  ) => Promise<void>;
  now?: () => Date;
  previewTtlMs?: number;
}

const REGISTRY = 'registry.json';

const normSrc = (s: PackSource) => ({
  url: s.url,
  ref: s.ref?.trim() || 'HEAD',
  path: (s.path ?? '').replace(/^\/+|\/+$/g, ''),
});
const asRef = (s: { url: string; ref: string; path: string }): SourceRef => s;

/**
 * The packs on this machine: the ones that ship with Krama and the ones installed from git. An install is a pinned commit
 * of the pack and of every agent it pulls in (ADR-0015), kept with the version it came from so an update can show what it
 * would change and a rollback can put every pin back. Nothing installs without a preview of exactly that digest.
 */
export class PackManager implements PackRepository {
  private entries = new Map<string, Entry>();
  private readonly previews = new Map<string, Held>();
  private readonly loaded = new Map<string, Pack>();
  /** Each loaded version's agent configs, by `pack@sha`, for the runtime (`agentFiles`). */
  private readonly files = new Map<string, Record<string, Record<string, unknown>>>();
  private readonly now: () => Date;

  private constructor(private readonly o: PackManagerOptions) {
    this.now = o.now ?? (() => new Date());
  }

  static async open(o: PackManagerOptions): Promise<PackManager> {
    await mkdir(o.dir, { recursive: true });
    const m = new PackManager(o);
    try {
      const raw = JSON.parse(await readFile(join(o.dir, REGISTRY), 'utf8')) as { packs?: Entry[] };
      for (const e of raw.packs ?? []) m.entries.set(e.id, e);
    } catch {
      /* nothing installed yet */
    }
    return m;
  }

  private async save(): Promise<void> {
    const file = join(this.o.dir, REGISTRY);
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(
      tmp,
      `${JSON.stringify({ version: 1, packs: [...this.entries.values()] }, null, 2)}\n`,
    );
    await rename(tmp, file);
  }

  // ---- reading ------------------------------------------------------------------------------------------------------

  async list(): Promise<Pack[]> {
    const installed: Pack[] = [];
    for (const e of this.entries.values()) {
      const p = await this.packOf(e).catch(() => undefined);
      if (p) installed.push(p);
    }
    return [...(this.o.builtin ?? []), ...installed];
  }

  /** With a `sha`, the version pinned at that commit (a run keeps the one it started with); without, the current one. */
  async get(id: string, sha?: string): Promise<Pack | undefined> {
    const builtin = this.o.builtin?.find((p) => p.id === id);
    if (builtin) return builtin;
    const e = this.entries.get(id);
    if (!e) return undefined;
    const v = sha ? this.versionAt(e, sha) : e.current;
    return v ? this.packOf(e, v).catch(() => undefined) : undefined;
  }

  private versionAt(e: Entry, sha: string): PackVersion | undefined {
    return e.current.sha === sha ? e.current : [...e.history].reverse().find((v) => v.sha === sha);
  }

  /**
   * One agent's wrapper config of the installed version a run uses, with its file paths made absolute. Known once that
   * version has been read (`get` does it), which a run does before it starts anything.
   */
  agentFiles(pack: Pack, agentId: string): { config: Record<string, unknown> } | undefined {
    const config = this.files.get(`${pack.id}@${pack.source.sha}`)?.[agentId];
    return config ? { config } : undefined;
  }

  /** Every version this pack has been, newest first. */
  versions(id: string): PackVersion[] {
    const e = this.entry(id);
    return [e.current, ...[...e.history].reverse().filter((v) => v !== e.current)];
  }

  /** The directory an installed pack is checked out in (read-only), for browsing its files. */
  async rootOf(id: string): Promise<string> {
    if (this.o.builtin?.some((p) => p.id === id))
      throw new PackError('not_found', `${id} ships with Krama and has no files to browse`);
    return (await this.loadInstalled(this.entry(id))).dir;
  }

  async manifest(id: string): Promise<unknown> {
    const builtin = this.o.builtin?.find((p) => p.id === id);
    if (builtin) return builtin;
    const e = this.entry(id);
    const { load } = await this.loadInstalled(e);
    return load.file;
  }

  private entry(id: string): Entry {
    const e = this.entries.get(id);
    if (!e) throw new PackError('not_found', `Pack ${id} is not installed`);
    return e;
  }

  private loadEnv(mode: 'locked' | 'peek' | 'pin'): PackLoadEnv {
    const { sources } = this.o;
    return {
      backends: this.o.backends,
      allowedBackends: this.o.allowedBackends,
      checkProviderConfig: this.o.checkProviderConfig,
      resolveGit: async (s) => {
        if (mode === 'peek') {
          const p = await sources.peek(s);
          return { dir: p.dir, sha: p.sha };
        }
        const r = await sources.resolve(s, mode === 'pin' ? { update: true } : {});
        return { dir: r.dir, sha: r.entry.sha };
      },
    };
  }

  /** The pack as pinned: from the lock file, with no network unless a commit is missing from the mirror. */
  private async loadInstalled(
    e: Entry,
    v: PackVersion = e.current,
  ): Promise<{ load: PackLoad; dir: string }> {
    // By the exact commit, not through a ref that may have moved or been put back since.
    const dir = await this.o.sources.at(v.source, v.sha);
    return { load: await loadPackDir(dir, this.loadEnv('locked')), dir };
  }

  private async packOf(e: Entry, v: PackVersion = e.current): Promise<Pack> {
    const key = `${e.id}@${v.sha}@${v.digest}@${e.status}`;
    const hit = this.loaded.get(key);
    if (hit) return hit;
    const { load } = await this.loadInstalled(e, v);
    this.files.set(
      `${e.id}@${v.sha}`,
      Object.fromEntries(
        Object.values(load.agents).flatMap((r) =>
          r.config ? [[r.id, r.dir ? withAbsolutePaths(r.config, r.dir) : r.config]] : [],
        ),
      ),
    );
    const pack = toPack(load, {
      source: { ...v.source, sha: v.sha },
      trust: e.trust,
      status: e.status,
      installedAt: v.at,
      permissions: await permissionSurface(load, this.o.backends),
      engineVersion: this.o.engineVersion,
    });
    this.loaded.set(key, pack);
    return pack;
  }

  // ---- preview ------------------------------------------------------------------------------------------------------

  private trustOf(url: string): Pack['trust'] {
    return this.o.trusted && this.o.trusted.length > 0 && remoteAllowed(url, this.o.trusted)
      ? 'trusted'
      : 'untrusted';
  }

  private async build(
    src: { url: string; ref: string; path: string },
    against?: Entry,
  ): Promise<{ preview: PackPreview; held: Held }> {
    const peeked = await this.o.sources.peek(asRef(src));
    const load = await loadPackDir(peeked.dir, this.loadEnv('peek'));
    const trust = this.trustOf(src.url);
    const issues: PackPreview['issues'] = load.issues.map((i) => ({
      severity: i.severity === 'error' ? 'error' : 'warn',
      message: i.message,
      path: i.path,
    }));
    for (const m of peeked.moved)
      issues.push({
        severity: 'warn',
        message: `The tag ${m.tag} on this remote has moved; the first commit it named is the one used`,
        path: 'source',
      });

    const permissions = load.ok ? await permissionSurface(load, this.o.backends) : [];
    const compatible = !load.file || engineCompatible(load.file.engine, this.o.engineVersion);
    if (!compatible)
      issues.push({
        severity: 'error',
        message: `This pack needs Krama ${load.file?.engine}; this is ${this.o.engineVersion}`,
        path: 'engine',
      });

    const manifest = load.ok
      ? toPack(load, {
          source: { ...src, sha: peeked.sha },
          trust,
          status: 'available',
          permissions,
          engineVersion: this.o.engineVersion,
        })
      : placeholder(src, peeked.sha, trust, load.file?.name);
    const secrets = load.ok ? secretRefs(load) : [];
    const bound = await Promise.all(
      secrets.map(async (s) => ({
        ...s,
        bound: (await this.o.secrets.resolve(s.ref)) !== undefined,
      })),
    );

    let diff: PackDiff | undefined;
    if (against) {
      const cur = await this.loadInstalled(against);
      diff = diffLoads(
        cur.load,
        load,
        await permissionSurface(cur.load, this.o.backends),
        permissions,
      );
    }
    const previewId = `prev_${randomBytes(9).toString('base64url')}`;
    const expiresAt = this.now().getTime() + (this.o.previewTtlMs ?? 30 * 60_000);
    const preview: PackPreview = {
      previewId,
      manifestDigest: load.digest ?? '',
      sha: peeked.sha,
      manifest,
      trust,
      engineCompatible: compatible,
      issues,
      permissions,
      secretsToBind: bound,
      skills: [],
      definitions: [],
      ...(diff ? { diff } : {}),
      expiresAt: new Date(expiresAt).toISOString(),
    };
    const held: Held = {
      src,
      sha: peeked.sha,
      digest: load.digest ?? '',
      packId: manifest.id,
      ...(against ? { updates: against.id } : {}),
      compatible,
      ...(load.ok ? {} : { errors: issues.filter((i) => i.severity === 'error') }),
      expiresAt,
    };
    this.previews.set(previewId, held);
    return { preview, held };
  }

  /** Resolves, validates and describes a pack (with what it asks to be allowed) without installing or pinning anything. */
  async preview(req: PackSource): Promise<PackPreview> {
    return (await this.build(normSrc(req))).preview;
  }

  /** The same for a newer commit of an installed pack, with the diff against what is installed. */
  async previewUpdate(id: string, to?: { ref?: string }): Promise<PackPreview> {
    const e = this.entry(id);
    const src = { ...e.source, ...(to?.ref ? { ref: to.ref } : {}) };
    return (await this.build(src, e)).preview;
  }

  // ---- doing --------------------------------------------------------------------------------------------------------

  private take(previewId: string, digest: string, kind: 'install' | 'update', id?: string): Held {
    const held = this.previews.get(previewId);
    if (!held || held.expiresAt < this.now().getTime())
      throw new PackError(
        'conflict',
        'That preview is gone or has expired; preview the pack again',
      );
    if (held.digest !== digest)
      throw new PackError(
        'conflict',
        'The digest is not the one that was previewed, so what you consented to is not what would be installed',
      );
    if (kind === 'update' && held.updates !== id)
      throw new PackError('conflict', 'That preview is not an update of this pack');
    if (kind === 'install' && held.updates)
      throw new PackError('conflict', 'That preview is an update; update the pack instead');
    if (held.errors)
      throw new PackError('invalid', 'This pack has errors and cannot be installed', held.errors);
    if (!held.compatible)
      throw new PackError('engine_incompatible', 'This pack needs a different version of Krama');
    return held;
  }

  /** Pins the pack and everything it pulls in, and checks it is still exactly what was previewed. */
  private async pin(
    held: Held,
  ): Promise<{ load: PackLoad; version: Omit<PackVersion, 'at' | 'by' | 'action' | 'consent'> }> {
    const before = await this.o.sources.snapshot();
    try {
      const r = await this.o.sources.resolve(asRef(held.src), { update: true });
      const load = await loadPackDir(r.dir, this.loadEnv('pin'));
      if (r.entry.sha !== held.sha || load.digest !== held.digest || !load.ok)
        throw new PackError(
          'conflict',
          'The source changed after it was previewed; preview it again',
        );
      const nested = Object.values(load.agents).flatMap((a) => (a.git ? [a.git] : []));
      const locks = await this.o.sources.pinned([asRef(held.src), ...nested]);
      return {
        load,
        version: {
          source: held.src,
          sha: r.entry.sha,
          version: load.file!.version,
          digest: load.digest!,
          locks,
        },
      };
    } catch (e) {
      // A pin made for an install that did not happen is not left behind for the next one.
      await this.o.sources.replaceLock(before);
      throw e;
    }
  }

  async install(
    req: {
      previewId: string;
      manifestDigest: string;
      consent: { granted: string[]; declined: string[] };
    },
    actor: ActorRef,
  ): Promise<Pack> {
    const held = this.take(req.previewId, req.manifestDigest, 'install');
    if (this.entries.has(held.packId) || this.o.builtin?.some((p) => p.id === held.packId))
      throw new PackError(
        'conflict',
        `A pack called ${held.packId} is already installed; update it instead`,
      );
    const { version } = await this.pin(held);
    const at = this.now().toISOString();
    const v: PackVersion = {
      ...version,
      at,
      by: actor.id,
      action: 'install',
      consent: req.consent,
    };
    const entry: Entry = {
      id: held.packId,
      name: held.packId.replace(/^pack_/, ''),
      source: held.src,
      status: 'installed',
      trust: this.trustOf(held.src.url),
      current: v,
      history: [v],
    };
    this.entries.set(entry.id, entry);
    await this.save();
    this.previews.delete(req.previewId);
    await this.record('pack.installed', actor, entry, v);
    return (await this.get(entry.id))!;
  }

  async update(
    id: string,
    req: {
      previewId: string;
      manifestDigest: string;
      consent: { granted: string[]; declined: string[] };
    },
    actor: ActorRef,
  ): Promise<Pack> {
    const e = this.entry(id);
    const held = this.take(req.previewId, req.manifestDigest, 'update', id);
    if (held.packId !== id)
      throw new PackError('conflict', `That commit holds ${held.packId}, not ${id}`);
    const { version } = await this.pin(held);
    if (version.sha === e.current.sha && version.digest === e.current.digest)
      throw new PackError('conflict', 'That is what is installed already');
    const v: PackVersion = {
      ...version,
      at: this.now().toISOString(),
      by: actor.id,
      action: 'update',
      consent: req.consent,
    };
    e.source = held.src;
    e.current = v;
    e.history.push(v);
    await this.save();
    this.previews.delete(req.previewId);
    await this.record('pack.updated', actor, e, v);
    return (await this.get(id))!;
  }

  /** Puts an earlier version back: the pack's own commit and every pin the version used (its agents too). */
  async rollback(id: string, sha: string, actor: ActorRef): Promise<Pack> {
    const e = this.entry(id);
    const target = [...e.history].reverse().find((v) => v.sha === sha || v.sha.startsWith(sha));
    if (!target) throw new PackError('not_found', `${id} was never installed at ${sha}`);
    if (target.sha === e.current.sha && target.digest === e.current.digest)
      throw new PackError('conflict', 'That is the version installed now');
    await this.o.sources.restore(target.locks);
    const v: PackVersion = {
      ...target,
      at: this.now().toISOString(),
      by: actor.id,
      action: 'rollback',
    };
    e.source = target.source;
    e.current = v;
    e.history.push(v);
    await this.save();
    await this.record('pack.rolled_back', actor, e, v);
    return (await this.get(id))!;
  }

  async setEnabled(id: string, enabled: boolean, actor: ActorRef): Promise<Pack> {
    const e = this.entry(id);
    e.status = enabled ? 'installed' : 'disabled';
    await this.save();
    await this.record(enabled ? 'pack.enabled' : 'pack.disabled', actor, e, e.current);
    return (await this.get(id))!;
  }

  /** Takes the pack out of the catalogue. Its commits stay in the mirror and the lock file, so nothing is lost. */
  async uninstall(id: string, actor: ActorRef): Promise<void> {
    const e = this.entry(id);
    this.entries.delete(id);
    await this.save();
    await this.record('pack.uninstalled', actor, e, e.current);
  }

  private async record(kind: string, actor: ActorRef, e: Entry, v: PackVersion): Promise<void> {
    await this.o.audit?.(
      kind,
      actor,
      { type: 'pack', id: e.id },
      {
        sha: v.sha,
        version: v.version,
        digest: v.digest,
        source: `${e.source.url}@${e.source.ref}`,
        trust: e.trust,
        ...(v.consent ? { consent: v.consent } : {}),
      },
    );
  }
}

/** What a preview shows for a pack that did not load: enough to name it, with the issues carrying the reason. */
function placeholder(
  src: { url: string; ref: string; path: string },
  sha: string,
  trust: Pack['trust'],
  name?: string,
): Pack {
  return {
    id: `pack_${name ?? 'unknown'}`,
    name: name ?? 'unknown',
    version: '0.0.0',
    description: 'This pack did not load',
    tags: [],
    status: 'available',
    source: {
      type: 'git',
      url: src.url,
      ref: src.ref,
      sha,
      ...(src.path ? { path: src.path } : {}),
    },
    trust,
    engine: { requires: '*', compatible: false },
    inputsSchema: {},
    ui: {},
    artifactTypes: [],
    requirements: { mcpServers: [], secrets: [], workItemSources: [] },
    permissions: [] as PermissionRequest[],
    memoryScopes: [],
    tests: { suites: 0 },
    links: {},
  };
}
