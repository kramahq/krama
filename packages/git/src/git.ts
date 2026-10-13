import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type GitErrorCode =
  | 'git_missing'
  | 'not_a_repo'
  | 'auth_failed'
  | 'not_found'
  | 'refused'
  | 'conflict'
  | 'not_fast_forward'
  | 'secret_found'
  | 'exists'
  | 'invalid'
  | 'timeout'
  | 'failed';

/**
 * A git operation that did not work. `message` says why in words; `stderr` is git's own text with any credentials in a URL
 * removed, because it ends up in logs and in audit records.
 */
export class GitError extends Error {
  constructor(
    readonly code: GitErrorCode,
    message: string,
    readonly stderr = '',
    readonly args: readonly string[] = [],
  ) {
    super(message);
    this.name = 'GitError';
  }
}

/** `https://user:token@host/x` -> `https://host/x`, so a secret in a URL never reaches a log. */
export const redactUrls = (text: string): string =>
  text.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1');

/** An empty git config file to point `GIT_CONFIG_GLOBAL` at: `/dev/null` is not a path git can open on Windows. */
function emptyConfig(): string {
  const dir = join(tmpdir(), 'krama-git-isolated');
  const file = join(dir, 'empty.gitconfig');
  if (!existsSync(file)) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, '');
  }
  return file;
}

export interface GitOptions {
  /** The git executable. Default `git`. */
  binary?: string;
  /** Extra environment for every call. */
  env?: Record<string, string>;
  /** Kill a call after this long. Default 60 s (a signing prompt that cannot appear would otherwise hang). */
  timeoutMs?: number;
  /**
   * Ignore the user's and the system's git configuration, for tests: the same result on every machine. Never set in
   * production, where the point is to use the person's own configuration and credentials.
   */
  isolated?: boolean;
}

export interface RunOptions {
  cwd?: string;
  input?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

/** What a failed call's stderr says, as a code. */
function classify(stderr: string): GitErrorCode {
  const s = stderr.toLowerCase();
  if (/not a git repository/.test(s)) return 'not_a_repo';
  if (
    /authentication failed|permission denied|could not read username|terminal prompts disabled|access denied|403|publickey/.test(
      s,
    )
  )
    return 'auth_failed';
  if (
    /repository not found|does not appear to be a git repository|could not resolve host|not found/.test(
      s,
    )
  )
    return 'not_found';
  if (
    /non-fast-forward|\[rejected\]|failed to push|protected branch|denied by hook|hook declined/.test(
      s,
    )
  )
    return 'refused';
  if (/conflict|would be overwritten|unmerged/.test(s)) return 'conflict';
  if (/already exists/.test(s)) return 'exists';
  return 'failed';
}

/**
 * Runs the `git` binary with no shell and no prompt, using the person's own configuration and credentials. A call that
 * would ask a question fails instead (`GIT_TERMINAL_PROMPT=0`). Output is returned as text; nothing is ever interpreted by
 * a shell, so a name or a path cannot become a command.
 */
export class Git {
  private readonly binary: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly timeoutMs: number;

  constructor(o: GitOptions = {}) {
    this.binary = o.binary ?? 'git';
    this.timeoutMs = o.timeoutMs ?? 60_000;
    this.env = {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'never',
      // Messages in a form `classify` understands, whatever the person's language.
      LC_ALL: 'C',
      LANGUAGE: 'C',
      ...(o.isolated
        ? {
            GIT_CONFIG_GLOBAL: emptyConfig(),
            GIT_CONFIG_SYSTEM: emptyConfig(),
            GIT_CONFIG_NOSYSTEM: '1',
            HOME: tmpdir(),
            USERPROFILE: tmpdir(),
          }
        : {}),
      ...(o.env ?? {}),
    };
  }

  /** stdout, untrimmed. Throws `GitError`. */
  run(args: readonly string[], o: RunOptions = {}): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = execFile(
        this.binary,
        [...args],
        {
          cwd: o.cwd,
          env: { ...this.env, ...(o.env ?? {}) },
          timeout: o.timeoutMs ?? this.timeoutMs,
          maxBuffer: 64 * 1024 * 1024,
          windowsHide: true,
          encoding: 'utf8',
        },
        (err, stdout, stderr) => {
          if (!err) return resolve(stdout);
          const safeArgs = args.map(redactUrls);
          const text = redactUrls(String(stderr || err.message)).trim();
          const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
          if (e.code === 'ENOENT')
            return reject(
              new GitError(
                'git_missing',
                'git is not installed, or not on the PATH',
                text,
                safeArgs,
              ),
            );
          if (e.killed || e.signal === 'SIGTERM')
            return reject(
              new GitError(
                'timeout',
                `git ${safeArgs[0]} took too long and was stopped`,
                text,
                safeArgs,
              ),
            );
          const code = classify(text);
          reject(
            new GitError(
              code,
              `git ${safeArgs[0]} failed: ${text.split('\n')[0] ?? ''}`.trim(),
              text,
              safeArgs,
            ),
          );
        },
      );
      if (o.input !== undefined) child.stdin?.end(o.input);
    });
  }

  /** stdout with the trailing newline removed. */
  async text(args: readonly string[], o: RunOptions = {}): Promise<string> {
    return (await this.run(args, o)).replace(/\r?\n$/, '');
  }

  /** Whether the command exits 0 (for questions like `merge-base --is-ancestor`). Anything but a plain "no" still throws. */
  async ok(args: readonly string[], o: RunOptions = {}): Promise<boolean> {
    try {
      await this.run(args, o);
      return true;
    } catch (e) {
      if (e instanceof GitError && e.code === 'failed') return false;
      throw e;
    }
  }

  async version(): Promise<string> {
    return (await this.text(['--version'])).replace(/^git version\s+/, '');
  }
}
