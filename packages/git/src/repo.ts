import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { Git, GitError } from './git.js';
import { looksBinary, scanText, type SecretFinding } from './secrets.js';

/** Who a commit or a tag is made by: the acting person, not whoever configured git on this machine. */
export interface Person {
  name: string;
  email: string;
}

export interface Commit {
  sha: string;
  parents: string[];
  author: Person;
  at: string;
  subject: string;
  body: string;
}

export interface Revision {
  /** `rev/3` */
  name: string;
  n: number;
  /** The commit it names. */
  sha: string;
  /** What the person wrote when making it; its first line is the label. */
  message: string;
  label: string;
  tagger: Person;
  at: string;
}

export interface FileChange {
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'other';
  path: string;
  from?: string;
}

/** What happened, for the audit record the host writes; this package knows nothing of the ledger. */
export type RepoEvent =
  | { type: 'repo.created'; dir: string; by: Person }
  | { type: 'draft.created'; name: string; by: Person }
  | { type: 'draft.saved'; name: string; sha: string; files: number; by: Person }
  | { type: 'draft.discarded'; name: string; by: Person }
  | { type: 'revision.created'; revision: Revision; by: Person }
  | { type: 'production.promoted'; from: string; to: string; revision: string; by: Person }
  | { type: 'production.rolled_back'; to: string; sha: string; revision: string; by: Person };

export interface RepoOptions {
  git?: Git;
  /** Told after each operation that changes the repository. A listener that throws never breaks the operation. */
  onEvent?: (e: RepoEvent) => void;
}

const PRODUCTION = 'main';
const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const REV = /^rev\/(\d+)$/;
/** Larger files are not scanned for secrets (they are not config). */
const SCAN_MAX = 1024 * 1024;

const identity = (p: Person) => ({
  GIT_AUTHOR_NAME: p.name,
  GIT_AUTHOR_EMAIL: p.email,
  GIT_COMMITTER_NAME: p.name,
  GIT_COMMITTER_EMAIL: p.email,
});

const SEP = '\u001f';
const END = '\u001e';

/** One writer at a time per repository: two saves at once must not race over refs. */
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
 * A repository Krama keeps for what a person authors (ADR-0015, "the authored flow"). `main` is production and only moves
 * forward to a revision. Each draft is a branch `draft/<name>` with its own work tree, so editing never touches what runs.
 * Every save is a commit by the person; a revision is an immutable annotated tag `rev/<n>`.
 */
export class Repo {
  private constructor(
    readonly dir: string,
    private readonly git: Git,
    private readonly onEvent: (e: RepoEvent) => void,
    /** Where draft work trees live: next to the repository, not inside it. */
    readonly draftsDir: string,
  ) {}

  private emit(e: RepoEvent): void {
    try {
      this.onEvent(e);
    } catch {
      /* a listener's trouble is not the repository's */
    }
  }

  private static draftsFor(dir: string): string {
    return join(dirname(dir), `.${basename(dir)}.drafts`);
  }

  /** Creates the repository with an empty first commit, so `main` exists and drafts can branch from it. */
  static async init(dir: string, by: Person, o: RepoOptions = {}): Promise<Repo> {
    const git = o.git ?? new Git();
    const root = resolve(dir);
    await mkdir(root, { recursive: true });
    if (
      await stat(join(root, '.git')).then(
        () => true,
        () => false,
      )
    )
      throw new GitError('exists', `${root} is already a git repository`);
    await git.run(['init', '-q', '-b', PRODUCTION], { cwd: root });
    // The same bytes on every machine, and paths longer than Windows' default are fine.
    for (const [k, v] of [
      ['core.autocrlf', 'false'],
      ['core.longpaths', 'true'],
      ['core.safecrlf', 'false'],
    ] as const)
      await git.run(['config', k, v], { cwd: root });
    await git.run(['commit', '-q', '--allow-empty', '-m', 'Start'], {
      cwd: root,
      env: identity(by),
    });
    const repo = new Repo(root, git, o.onEvent ?? (() => undefined), Repo.draftsFor(root));
    repo.emit({ type: 'repo.created', dir: root, by });
    return repo;
  }

  static async open(dir: string, o: RepoOptions = {}): Promise<Repo> {
    const git = o.git ?? new Git();
    const root = resolve(dir);
    const top = await git.text(['rev-parse', '--show-toplevel'], { cwd: root }).catch(() => {
      throw new GitError('not_a_repo', `${root} is not a git repository`);
    });
    // `--show-toplevel` is in git's own spelling of the path; compare what exists on disk, not the text.
    if (
      (await stat(top).then(
        (s) => s.ino,
        () => -1,
      )) !==
      (await stat(root).then(
        (s) => s.ino,
        () => -2,
      ))
    )
      throw new GitError('not_a_repo', `${root} is inside a repository but is not its top`);
    return new Repo(root, git, o.onEvent ?? (() => undefined), Repo.draftsFor(root));
  }

  /** The commit a ref points at, or throws. */
  async resolve(ref: string): Promise<string> {
    try {
      return await this.git.text(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
        cwd: this.dir,
      });
    } catch {
      throw new GitError('not_found', `"${ref}" is not a commit in this repository`);
    }
  }

  /** Whether the work tree at `dir` has changes not yet committed. */
  async isClean(dir = this.dir): Promise<boolean> {
    return (
      (await this.git.text(['status', '--porcelain=v1', '--untracked-files=all'], { cwd: dir })) ===
      ''
    );
  }

  // ---- history ------------------------------------------------------------------------------------------------------

  async log(ref = PRODUCTION, o: { limit?: number } = {}): Promise<Commit[]> {
    const fmt = ['%H', '%P', '%an', '%ae', '%aI', '%s', '%b'].join(SEP) + END;
    const out = await this.git.run(
      ['log', `--max-count=${o.limit ?? 100}`, `--format=${fmt}`, ref, '--'],
      { cwd: this.dir },
    );
    return out
      .split(END)
      .map((r) => r.replace(/^\r?\n/, ''))
      .filter(Boolean)
      .map((r) => {
        const [sha, parents, name, email, at, subject, body] = r.split(SEP);
        return {
          sha: sha!,
          parents: parents ? parents.split(' ') : [],
          author: { name: name!, email: email! },
          at: at!,
          subject: subject!,
          body: (body ?? '').trim(),
        };
      });
  }

  /** What changed between two refs, by file. */
  async changes(from: string, to: string): Promise<FileChange[]> {
    const out = await this.git.run(['diff', '--name-status', '-z', '-M', from, to, '--'], {
      cwd: this.dir,
    });
    const parts = out.split('\0').filter(Boolean);
    const changes: FileChange[] = [];
    for (let i = 0; i < parts.length;) {
      const s = parts[i++]!;
      const kind = s[0];
      if (kind === 'R') {
        const old = parts[i++]!;
        changes.push({ status: 'renamed', path: parts[i++]!, from: old });
      } else
        changes.push({
          status:
            kind === 'A' ? 'added' : kind === 'M' ? 'modified' : kind === 'D' ? 'deleted' : 'other',
          path: parts[i++]!,
        });
    }
    return changes;
  }

  /** A unified diff between two refs, cut at `maxBytes`. */
  async patch(
    from: string,
    to: string,
    maxBytes = 512 * 1024,
  ): Promise<{ text: string; truncated: boolean }> {
    const out = await this.git.run(['diff', '--no-color', '--no-ext-diff', from, to, '--'], {
      cwd: this.dir,
    });
    return out.length > maxBytes
      ? { text: out.slice(0, maxBytes), truncated: true }
      : { text: out, truncated: false };
  }

  // ---- drafts -------------------------------------------------------------------------------------------------------

  /** Starts a draft from production (or from `from`): a branch and a work tree of its own. */
  async createDraft(name: string, by: Person, o: { from?: string } = {}): Promise<Draft> {
    if (!NAME.test(name))
      throw new GitError(
        'invalid',
        'A draft name is lowercase letters, digits and hyphens, up to 63 characters',
      );
    return exclusive(this.dir, async () => {
      const dir = join(this.draftsDir, name);
      if (
        await stat(dir).then(
          () => true,
          () => false,
        )
      )
        throw new GitError('exists', `Draft "${name}" already exists`);
      await mkdir(this.draftsDir, { recursive: true });
      await this.git.run(
        ['worktree', 'add', '-q', '-b', `draft/${name}`, dir, o.from ?? PRODUCTION],
        { cwd: this.dir },
      );
      this.emit({ type: 'draft.created', name, by });
      return new Draft(this, name, dir);
    });
  }

  async draft(name: string): Promise<Draft | undefined> {
    return (await this.drafts()).find((d) => d.name === name);
  }

  async drafts(): Promise<Draft[]> {
    const out = await this.git.text(['worktree', 'list', '--porcelain'], { cwd: this.dir });
    const drafts: Draft[] = [];
    for (const block of out.split(/\r?\n\r?\n/)) {
      const branch = /^branch refs\/heads\/draft\/(.+)$/m.exec(block)?.[1];
      const path = /^worktree (.+)$/m.exec(block)?.[1];
      if (branch && path) drafts.push(new Draft(this, branch, path));
    }
    return drafts;
  }

  /** Throws a draft away: its work tree and its branch. Its commits stay in git's reflog for a while; nothing else keeps them. */
  async discardDraft(name: string, by: Person): Promise<void> {
    return exclusive(this.dir, async () => {
      const d = await this.draft(name);
      if (!d) throw new GitError('not_found', `There is no draft "${name}"`);
      await this.git.run(['worktree', 'remove', '--force', d.dir], { cwd: this.dir });
      await this.git.run(['branch', '-D', `draft/${name}`], { cwd: this.dir });
      await rm(d.dir, { recursive: true, force: true });
      this.emit({ type: 'draft.discarded', name, by });
    });
  }

  /** @internal Used by `Draft`. */
  get runner(): Git {
    return this.git;
  }
  /** @internal */
  notify(e: RepoEvent): void {
    this.emit(e);
  }
  /** @internal */
  lock<T>(fn: () => Promise<T>): Promise<T> {
    return exclusive(this.dir, fn);
  }

  // ---- revisions ----------------------------------------------------------------------------------------------------

  /**
   * Names a commit as a revision: an annotated tag `rev/<n>` that is never moved or deleted. The commit already having
   * one gives that one back (`created: false`), because two names for one snapshot help nobody.
   */
  async createRevision(
    ref: string,
    by: Person,
    o: { message?: string } = {},
  ): Promise<{ revision: Revision; created: boolean }> {
    return exclusive(this.dir, async () => {
      const sha = await this.resolve(ref);
      const existing = (await this.revisions()).find((r) => r.sha === sha);
      if (existing) return { revision: existing, created: false };
      for (let attempt = 0; ; attempt++) {
        const n = ((await this.revisions()).at(-1)?.n ?? 0) + 1;
        const message = (o.message ?? '').trim() || `Revision ${n}`;
        try {
          await this.git.run(['tag', '-a', `rev/${n}`, '-m', message, sha], {
            cwd: this.dir,
            env: identity(by),
          });
        } catch (e) {
          // Another writer (another process) took this number between listing and tagging: take the next.
          if (e instanceof GitError && e.code === 'exists' && attempt < 3) continue;
          throw e;
        }
        const revision = (await this.revisions()).find((r) => r.n === n)!;
        this.emit({ type: 'revision.created', revision, by });
        return { revision, created: true };
      }
    });
  }

  /** Every revision, oldest first. */
  async revisions(): Promise<Revision[]> {
    const fmt =
      [
        '%(refname:short)',
        '%(*objectname)',
        '%(taggername)',
        '%(taggeremail)',
        '%(taggerdate:iso-strict)',
        '%(contents)',
      ].join(SEP) + END;
    const out = await this.git.run(['for-each-ref', `--format=${fmt}`, 'refs/tags/rev'], {
      cwd: this.dir,
    });
    return out
      .split(END)
      .map((r) => r.replace(/^\r?\n/, ''))
      .filter(Boolean)
      .flatMap((r) => {
        const [name, sha, tn, te, at, msg] = r.split(SEP);
        const n = REV.exec(name ?? '')?.[1];
        // A lightweight tag (no `*objectname`) is not a revision: only annotated ones are.
        if (!n || !sha) return [];
        const message = (msg ?? '').trim();
        return [
          {
            name: name!,
            n: Number(n),
            sha,
            message,
            label: message.split('\n')[0] ?? '',
            tagger: { name: tn!, email: (te ?? '').replace(/^<|>$/g, '') },
            at: at!,
          },
        ];
      })
      .sort((a, b) => a.n - b.n);
  }

  async revision(name: string | number): Promise<Revision> {
    const want =
      typeof name === 'number' ? `rev/${name}` : /^\d+$/.test(name) ? `rev/${name}` : name;
    const r = (await this.revisions()).find((x) => x.name === want);
    if (!r) throw new GitError('not_found', `There is no revision "${want}"`);
    return r;
  }

  // ---- production ---------------------------------------------------------------------------------------------------

  /** The commit `main` is at, and the revision it is, if it is one. */
  async production(): Promise<{ sha: string; revision?: Revision }> {
    const sha = await this.resolve(PRODUCTION);
    const revision = (await this.revisions()).find((r) => r.sha === sha);
    return { sha, ...(revision ? { revision } : {}) };
  }

  /**
   * Makes a revision production: `main` moves forward to its commit, and only forward. A revision that is not ahead of
   * `main` (a draft made before something else was promoted) must first be brought up to date with `Draft.catchUp`.
   */
  async promote(
    revision: string | number,
    by: Person,
  ): Promise<{ changed: boolean; from: string; to: string }> {
    return exclusive(this.dir, async () => {
      const rev = await this.revision(revision);
      const from = await this.resolve(PRODUCTION);
      if (from === rev.sha) return { changed: false, from, to: from };
      if (!(await this.git.ok(['merge-base', '--is-ancestor', from, rev.sha], { cwd: this.dir })))
        throw new GitError(
          'not_fast_forward',
          `${rev.name} is not ahead of production, so it cannot be promoted. Bring its draft up to date with production, make a new revision, and promote that.`,
        );
      if (!(await this.isClean()))
        throw new GitError(
          'conflict',
          'The production work tree has changes that are not committed',
        );
      await this.git.run(['merge', '--ff-only', '-q', rev.name], {
        cwd: this.dir,
        env: identity(by),
      });
      this.emit({ type: 'production.promoted', from, to: rev.sha, revision: rev.name, by });
      return { changed: true, from, to: rev.sha };
    });
  }

  /**
   * Puts production back to what an earlier revision held, by adding a commit that restores its files, and names that
   * commit as a new revision. History is not rewritten, so what ran and when stays on record.
   */
  async rollback(
    revision: string | number,
    by: Person,
    o: { message?: string } = {},
  ): Promise<{ sha: string; revision: Revision }> {
    return exclusive(this.dir, async () => {
      const target = await this.revision(revision);
      if (!(await this.isClean()))
        throw new GitError(
          'conflict',
          'The production work tree has changes that are not committed',
        );
      // The index and the work tree take the revision's files, including removing the ones it did not have.
      await this.git.run(['read-tree', '-u', '--reset', target.name], { cwd: this.dir });
      if (await this.isClean())
        throw new GitError(
          'invalid',
          `Production already holds the files of ${target.name}; there is nothing to roll back`,
        );
      await this.git.run(['add', '-A'], { cwd: this.dir });
      await this.git.run(
        [
          'commit',
          '-q',
          '-m',
          (o.message ?? '').trim() || `Roll back to ${target.name} (${target.label})`,
        ],
        {
          cwd: this.dir,
          env: identity(by),
        },
      );
      const sha = await this.resolve('HEAD');
      const created = await this.createRevisionUnlocked(
        sha,
        by,
        `Rollback to ${target.name}: ${target.label}`,
      );
      this.emit({
        type: 'production.rolled_back',
        to: target.name,
        sha,
        revision: created.name,
        by,
      });
      return { sha, revision: created };
    });
  }

  private async createRevisionUnlocked(
    sha: string,
    by: Person,
    message: string,
  ): Promise<Revision> {
    const n = ((await this.revisions()).at(-1)?.n ?? 0) + 1;
    await this.git.run(['tag', '-a', `rev/${n}`, '-m', message, sha], {
      cwd: this.dir,
      env: identity(by),
    });
    const revision = (await this.revisions()).find((r) => r.n === n)!;
    this.emit({ type: 'revision.created', revision, by });
    return revision;
  }
}

/** A draft: a branch and a work tree. Edit files in `dir`, then `save`. */
export class Draft {
  readonly branch: string;
  constructor(
    private readonly repo: Repo,
    readonly name: string,
    readonly dir: string,
  ) {
    this.branch = `draft/${name}`;
  }

  async isClean(): Promise<boolean> {
    return this.repo.isClean(this.dir);
  }

  /**
   * Commits everything that changed in the draft's work tree as one save, by `by`. Nothing changed gives `undefined`
   * (no empty commits). A file that holds a credential stops the save with the files and lines named, and nothing is
   * committed: a secret that reaches history cannot be taken back.
   */
  async save(
    by: Person,
    o: { message?: string; trailers?: Record<string, string> } = {},
  ): Promise<{ sha: string; files: number } | undefined> {
    return this.repo.lock(async () => {
      const git = this.repo.runner;
      await git.run(['add', '-A'], { cwd: this.dir });
      const names = (await git.run(['diff', '--cached', '--name-only', '-z'], { cwd: this.dir }))
        .split('\0')
        .filter(Boolean);
      if (names.length === 0) return undefined;

      const found: SecretFinding[] = [];
      for (const path of names) {
        const file = join(this.dir, path);
        const s = await stat(file).catch(() => undefined);
        if (!s?.isFile() || s.size > SCAN_MAX) continue;
        const bytes = await readFile(file);
        if (!looksBinary(bytes)) found.push(...scanText(path, bytes.toString('utf8')));
      }
      if (found.length > 0) {
        await git.run(['reset', '-q'], { cwd: this.dir });
        throw new GitError(
          'secret_found',
          `This looks like a credential, so nothing was saved: ${found.map((f) => `${f.path}:${f.line} (${f.what})`).join(', ')}. Use a \${VAR} reference and bind the variable instead.`,
        );
      }

      const subject = (o.message ?? '').trim() || `Save ${this.name}`;
      const trailers = Object.entries(o.trailers ?? {}).map(([k, v]) => `${k}: ${v}`);
      await git.run(
        ['commit', '-q', '-m', [subject, ...(trailers.length ? ['', ...trailers] : [])].join('\n')],
        {
          cwd: this.dir,
          env: identity(by),
        },
      );
      const sha = await git.text(['rev-parse', 'HEAD'], { cwd: this.dir });
      this.repo.notify({ type: 'draft.saved', name: this.name, sha, files: names.length, by });
      return { sha, files: names.length };
    });
  }

  /** The draft's own history, newest first. */
  log(o: { limit?: number } = {}): Promise<Commit[]> {
    return this.repo.log(this.branch, o);
  }

  /**
   * Brings production's newer commits into the draft, so a revision made from it can be promoted. A conflict stops it,
   * leaves the draft as it was, and names the files.
   */
  async catchUp(by: Person): Promise<{ merged: boolean; conflicts: string[] }> {
    return this.repo.lock(async () => {
      const git = this.repo.runner;
      if (!(await this.isClean()))
        throw new GitError('conflict', 'Save the draft before bringing production into it');
      if (await git.ok(['merge-base', '--is-ancestor', 'main', 'HEAD'], { cwd: this.dir }))
        return { merged: false, conflicts: [] };
      try {
        await git.run(
          ['merge', '--no-edit', '-q', '-m', `Bring production into ${this.name}`, 'main'],
          { cwd: this.dir, env: identity(by) },
        );
        return { merged: true, conflicts: [] };
      } catch (e) {
        const conflicts = (
          await git
            .run(['diff', '--name-only', '--diff-filter=U', '-z'], { cwd: this.dir })
            .catch(() => '')
        )
          .split('\0')
          .filter(Boolean);
        await git.run(['merge', '--abort'], { cwd: this.dir }).catch(() => undefined);
        if (conflicts.length > 0) return { merged: false, conflicts };
        throw e;
      }
    });
  }
}
