import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Git, GitError, redactUrls } from './git.js';
import type { FileChange } from './repo.js';

/** Where an agent directory lives in git, as a pack writes it (`repo@ref#dir`). */
export interface SourceRef {
  url: string;
  ref: string;
  path: string;
}

export type RefKind = 'tag' | 'branch' | 'commit';

/** One pinned source in `lock.json`: what was asked for, and the commit it was resolved to. */
export interface LockEntry {
  url: string;
  ref: string;
  path: string;
  refKind: RefKind;
  sha: string;
  resolvedAt: string;
  /** The commit (or tag) passed `git verify-*` against the person's keyring when it was pinned. */
  verified?: boolean;
}

/** A tag the remote now points somewhere else than where it first did. */
export interface MovedTag {
  tag: string;
  was: string;
  now: string;
}

export type SourceEvent =
  | { type: 'source.fetched'; url: string; heads: number; tags: number }
  | { type: 'source.pinned'; entry: LockEntry; changed: boolean }
  | {
      type: 'source.refused';
      url: string;
      reason: 'not_allowed' | 'moved_tag' | 'unsigned' | 'not_found';
      detail: string;
    }
  | { type: 'source.moved_tag'; url: string; moved: MovedTag[] };

export interface SourcesOptions {
  /** Where mirrors, work trees and `lock.json` live. */
  root: string;
  git?: Git;
  /**
   * Remotes that may be used, as patterns over `host/owner/repo` where `*` matches any run of characters
   * (`github.com/acme/*`). Empty or absent allows every remote, which suits local use.
   */
  allow?: readonly string[];
  /** Every pinned commit (or tag) must pass `git verify-commit` or `verify-tag` with the person's own keyring. */
  requireSigned?: boolean;
  /** Told after each step, for the audit. A listener that throws never breaks the step. */
  onEvent?: (e: SourceEvent) => void;
  now?: () => Date;
}

const LOCK = 'lock.json';
const SHORT_SHA = /^[0-9a-f]{7,40}$/;

/** `https://github.com/Acme/Repo.git`, `git@github.com:acme/repo`, `ssh://git@host/x` -> `github.com/acme/repo`. */
export function normalizeRemote(url: string): string {
  let u = redactUrls(url.trim());
  const scp = /^[^@/\s]+@([^:/\s]+):(.+)$/.exec(u);
  if (scp) u = `${scp[1]}/${scp[2]}`;
  u = u.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/^[^@/]+@/, '');
  return u
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

/** Whether a remote passes an allow-list. */
export function remoteAllowed(url: string, allow: readonly string[] | undefined): boolean {
  if (!allow || allow.length === 0) return true;
  const n = normalizeRemote(url);
  return allow.some((p) => {
    const re = new RegExp(
      `^${p
        .toLowerCase()
        .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')}$`,
    );
    return re.test(n);
  });
}

const sourceKey = (s: SourceRef): string => `${s.url}@${s.ref}${s.path ? `#${s.path}` : ''}`;
const mirrorName = (url: string): string =>
  `${createHash('sha256').update(normalizeRemote(url)).digest('hex').slice(0, 16)}.git`;

const locks = new Map<string, Promise<unknown>>();
async function exclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => undefined);
  locks.set(key, tail);
  try {
    return await run;
  } finally {
    if (locks.get(key) === tail) locks.delete(key);
  }
}

/**
 * Other people's repositories, used the way ADR-0015 says: a bare mirror per remote (fetch only), a read-only work tree per
 * pinned commit, and `lock.json` saying which commit each `repo@ref#dir` resolved to. Branches are fetched as they move;
 * tags are fetched into a namespace of their own and copied in only when new, so a tag that is later moved on the remote
 * is seen and refused instead of silently replacing the one that was trusted.
 */
export class Sources {
  private readonly git: Git;
  private readonly opts: SourcesOptions;
  private readonly now: () => Date;

  private constructor(opts: SourcesOptions) {
    this.opts = opts;
    this.git = opts.git ?? new Git();
    this.now = opts.now ?? (() => new Date());
  }

  static async open(opts: SourcesOptions): Promise<Sources> {
    await mkdir(join(opts.root, 'mirrors'), { recursive: true });
    await mkdir(join(opts.root, 'worktrees'), { recursive: true });
    return new Sources(opts);
  }

  private emit(e: SourceEvent): void {
    try {
      this.opts.onEvent?.(e);
    } catch {
      /* a listener's trouble is not ours */
    }
  }

  private mirrorDir = (url: string): string => join(this.opts.root, 'mirrors', mirrorName(url));
  private worktreeDir = (sha: string): string => join(this.opts.root, 'worktrees', sha);

  // ---- the lock file ------------------------------------------------------------------------------------------------

  async lockfile(): Promise<Record<string, LockEntry>> {
    try {
      const raw = JSON.parse(await readFile(join(this.opts.root, LOCK), 'utf8')) as {
        sources?: Record<string, LockEntry>;
      };
      return raw.sources ?? {};
    } catch {
      return {};
    }
  }

  private async writeLock(sources: Record<string, LockEntry>): Promise<void> {
    const file = join(this.opts.root, LOCK);
    const tmp = `${file}.${process.pid}.tmp`;
    const ordered = Object.fromEntries(
      Object.entries(sources).sort(([a], [b]) => a.localeCompare(b)),
    );
    await writeFile(tmp, `${JSON.stringify({ version: 1, sources: ordered }, null, 2)}\n`);
    await rename(tmp, file);
  }

  // ---- policy -------------------------------------------------------------------------------------------------------

  private allow(url: string): void {
    if (remoteAllowed(url, this.opts.allow)) return;
    const detail = `${normalizeRemote(url)} is not in the list of allowed sources`;
    this.emit({ type: 'source.refused', url: redactUrls(url), reason: 'not_allowed', detail });
    throw new GitError('refused', detail);
  }

  // ---- the mirror ---------------------------------------------------------------------------------------------------

  /** Git over SSH must fail rather than ask for a passphrase on a terminal nobody is watching. */
  private async remoteEnv(): Promise<Record<string, string>> {
    if (process.env['GIT_SSH_COMMAND'] || process.env['GIT_SSH']) return {};
    const configured = await this.git.text(['config', '--get', 'core.sshCommand']).catch(() => '');
    return configured ? {} : { GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' };
  }

  private async ensureMirror(url: string): Promise<string> {
    const dir = this.mirrorDir(url);
    if (
      await stat(join(dir, 'HEAD')).then(
        () => true,
        () => false,
      )
    )
      return dir;
    await mkdir(dir, { recursive: true });
    await this.git.run(['init', '-q', '--bare'], { cwd: dir });
    await this.git.run(['config', 'core.longpaths', 'true'], { cwd: dir });
    return dir;
  }

  /**
   * Brings the mirror up to date. Branches follow the remote. Tags are fetched into `refs/remote-tags/` and a tag is copied
   * to `refs/tags/` only when the mirror has not seen it before; one that differs from what was trusted is reported.
   */
  async fetch(url: string): Promise<{ moved: MovedTag[] }> {
    this.allow(url);
    return exclusive(`mirror:${mirrorName(url)}`, async () => {
      const dir = await this.ensureMirror(url);
      const env = await this.remoteEnv();
      try {
        await this.git.run(
          [
            'fetch',
            '-q',
            '--prune',
            '--no-tags',
            url,
            '+refs/heads/*:refs/heads/*',
            '+refs/tags/*:refs/remote-tags/*',
          ],
          { cwd: dir, env },
        );
      } catch (e) {
        if (e instanceof GitError && (e.code === 'not_found' || e.code === 'auth_failed'))
          this.emit({
            type: 'source.refused',
            url: redactUrls(url),
            reason: 'not_found',
            detail: e.message,
          });
        throw e;
      }
      const seen = await this.tagMap(dir, 'refs/remote-tags');
      const known = await this.tagMap(dir, 'refs/tags');
      const moved: MovedTag[] = [];
      let created = 0;
      for (const [tag, now] of seen) {
        const was = known.get(tag);
        if (!was) {
          // Trust on first sight: the first commit a tag names is the one it is held to.
          await this.git.run(['update-ref', `refs/tags/${tag}`, now], { cwd: dir });
          created++;
        } else if (was !== now) moved.push({ tag, was, now });
      }
      const heads = (
        await this.git.text(['for-each-ref', '--format=%(refname)', 'refs/heads'], { cwd: dir })
      )
        .split('\n')
        .filter(Boolean).length;
      this.emit({ type: 'source.fetched', url: redactUrls(url), heads, tags: created });
      if (moved.length > 0) this.emit({ type: 'source.moved_tag', url: redactUrls(url), moved });
      return { moved };
    });
  }

  /** tag name -> the commit it names, for the refs under `prefix`. */
  private async tagMap(dir: string, prefix: string): Promise<Map<string, string>> {
    const out = await this.git.run(
      ['for-each-ref', '--format=%(refname)%09%(*objectname)%09%(objectname)', prefix],
      { cwd: dir },
    );
    const map = new Map<string, string>();
    for (const line of out.split('\n').filter(Boolean)) {
      const [ref, peeled, plain] = line.split('\t');
      map.set(ref!.slice(prefix.length + 1), (peeled || plain)!);
    }
    return map;
  }

  /** The commit a ref names in the mirror, and what kind of ref it is. Tags win over branches, as git's own lookup does. */
  private async lookup(
    dir: string,
    ref: string,
  ): Promise<{ sha: string; kind: RefKind } | undefined> {
    const try_ = async (name: string): Promise<string | undefined> =>
      this.git
        .text(['rev-parse', '--verify', '--quiet', `${name}^{commit}`], { cwd: dir })
        .catch(() => undefined);
    const tag = await try_(`refs/tags/${ref}`);
    if (tag) return { sha: tag, kind: 'tag' };
    const branch = await try_(`refs/heads/${ref}`);
    if (branch) return { sha: branch, kind: 'branch' };
    if (SHORT_SHA.test(ref)) {
      const sha = await try_(ref);
      if (sha && (ref.length === 40 ? sha === ref : sha.startsWith(ref)))
        return { sha, kind: 'commit' };
    }
    return undefined;
  }

  // ---- resolving and pinning ----------------------------------------------------------------------------------------

  /** A read-only work tree of a pinned commit, made once and kept. */
  private async ensureWorktree(url: string, sha: string): Promise<string> {
    const dir = this.worktreeDir(sha);
    return exclusive(`worktree:${sha}`, async () => {
      if (
        await stat(join(dir, '.git')).then(
          () => true,
          () => false,
        )
      )
        return dir;
      await rm(dir, { recursive: true, force: true });
      const mirror = this.mirrorDir(url);
      await this.git.run(['worktree', 'prune'], { cwd: mirror }).catch(() => undefined);
      await this.git.run(['worktree', 'add', '-q', '--detach', '--force', dir, sha], {
        cwd: mirror,
      });
      return dir;
    });
  }

  private async verifySigned(
    url: string,
    found: { sha: string; kind: RefKind },
    ref: string,
  ): Promise<void> {
    const dir = this.mirrorDir(url);
    const args =
      found.kind === 'tag' &&
      (await this.git
        .text(['cat-file', '-t', `refs/tags/${ref}`], { cwd: dir })
        .catch(() => '')) === 'tag'
        ? ['verify-tag', `refs/tags/${ref}`]
        : ['verify-commit', found.sha];
    try {
      await this.git.run(args, { cwd: dir });
    } catch {
      const detail = `${normalizeRemote(url)}@${ref} is not signed by a key in your keyring, and signed sources are required`;
      this.emit({ type: 'source.refused', url: redactUrls(url), reason: 'unsigned', detail });
      throw new GitError('refused', detail);
    }
  }

  /**
   * Pins a source and gives its work tree. A source already in the lock file is used as pinned, with no network (that is
   * the offline cache); pass `update` to look at the remote again and move the pin to what the ref names now.
   */
  async resolve(
    src: SourceRef,
    o: { update?: boolean } = {},
  ): Promise<{ entry: LockEntry; dir: string; changed: boolean; moved: MovedTag[] }> {
    this.allow(src.url);
    const key = sourceKey(src);
    const locked = (await this.lockfile())[key];

    if (locked && !o.update) {
      const mirror = await stat(join(this.mirrorDir(src.url), 'HEAD')).then(
        () => true,
        () => false,
      );
      if (
        !mirror ||
        !(await this.git
          .ok(['cat-file', '-e', `${locked.sha}^{commit}`], { cwd: this.mirrorDir(src.url) })
          .catch(() => false))
      )
        await this.fetch(src.url);
      const dir = await this.ensureWorktree(src.url, locked.sha);
      return { entry: locked, dir: join(dir, src.path), changed: false, moved: [] };
    }

    const { moved } = await this.fetch(src.url);
    const found = await this.lookup(this.mirrorDir(src.url), src.ref);
    if (!found) {
      const detail = `${normalizeRemote(src.url)} has no tag, branch or commit "${src.ref}"`;
      this.emit({ type: 'source.refused', url: redactUrls(src.url), reason: 'not_found', detail });
      throw new GitError('not_found', detail);
    }
    // A tag that moved on the remote is not followed. The pin stays on what the tag first named.
    const movedHere = moved.find((m) => m.tag === src.ref);
    if (movedHere) {
      const detail = `The tag ${src.ref} on ${normalizeRemote(src.url)} now points at ${movedHere.now.slice(0, 12)}, not ${movedHere.was.slice(0, 12)} where it first did. A published tag does not move; this is refused.`;
      this.emit({ type: 'source.refused', url: redactUrls(src.url), reason: 'moved_tag', detail });
      throw new GitError('refused', detail);
    }
    if (this.opts.requireSigned) await this.verifySigned(src.url, found, src.ref);

    const entry: LockEntry = {
      url: src.url,
      ref: src.ref,
      path: src.path,
      refKind: found.kind,
      sha: found.sha,
      resolvedAt: this.now().toISOString(),
      ...(this.opts.requireSigned ? { verified: true } : {}),
    };
    const dir = await this.ensureWorktree(src.url, found.sha);
    const changed = locked?.sha !== found.sha;
    const all = await this.lockfile();
    all[key] = changed ? entry : { ...locked!, resolvedAt: entry.resolvedAt };
    await this.writeLock(all);
    this.emit({ type: 'source.pinned', entry: all[key]!, changed });
    return { entry: all[key]!, dir: join(dir, src.path), changed, moved };
  }

  /** What an update would change, without moving the pin: the pinned commit, the commit the ref names now, and the files between. */
  async preview(
    src: SourceRef,
  ): Promise<{ from?: string; to: string; changes: FileChange[]; moved: MovedTag[] }> {
    this.allow(src.url);
    const from = (await this.lockfile())[sourceKey(src)]?.sha;
    const { moved } = await this.fetch(src.url);
    const mirror = this.mirrorDir(src.url);
    const found = await this.lookup(mirror, src.ref);
    if (!found)
      throw new GitError(
        'not_found',
        `${normalizeRemote(src.url)} has no tag, branch or commit "${src.ref}"`,
      );
    const changes =
      from && from !== found.sha ? await this.changes(src.url, from, found.sha, src.path) : [];
    return { ...(from ? { from } : {}), to: found.sha, changes, moved };
  }

  /** Files that differ between two commits of a mirror, limited to a directory when given. */
  async changes(url: string, from: string, to: string, path = ''): Promise<FileChange[]> {
    const out = await this.git.run(
      ['diff', '--name-status', '-z', '-M', from, to, '--', ...(path ? [path] : [])],
      { cwd: this.mirrorDir(url) },
    );
    const parts = out.split('\0').filter(Boolean);
    const changes: FileChange[] = [];
    for (let i = 0; i < parts.length;) {
      const s = parts[i++]!;
      if (s[0] === 'R') {
        const old = parts[i++]!;
        changes.push({ status: 'renamed', path: parts[i++]!, from: old });
      } else
        changes.push({
          status:
            s[0] === 'A' ? 'added' : s[0] === 'M' ? 'modified' : s[0] === 'D' ? 'deleted' : 'other',
          path: parts[i++]!,
        });
    }
    return changes;
  }

  /** The shape the pack loader's `resolveGit` expects: where the agent directory is, and the commit it was pinned at. */
  resolveGit = async (src: SourceRef): Promise<{ dir: string; sha: string }> => {
    const r = await this.resolve(src);
    return { dir: r.dir, sha: r.entry.sha };
  };
}
