import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { readdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';
import type { ApiContext, Handlers } from './context.js';
import { ApiProblem, notFound } from './problems.js';
import { RawBody, mediaTypeOfPath, negotiate } from './raw.js';

/** The same rule the runtime applies to the names it puts in a workspace path. */
const SAFE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const MAX_TREE_ENTRIES = 5000;
const MAX_DIFF_BYTES = 4 * 1024 * 1024;
const GIT_TIMEOUT_MS = 10_000;

interface Workspace {
  id: string;
  mode: 'isolated' | 'shared';
  path: string;
  agents: string[];
}

const isDir = async (p: string): Promise<boolean> => {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
};

async function requireRun(ctx: ApiContext, runId: string): Promise<void> {
  if (!SAFE.test(runId) || !(await ctx.krama.ports.store.runs.get(runId)))
    throw notFound('Run', runId);
}

/** The workspaces of a run on disk: the shared one, and one private directory per agent that had its own. */
async function workspacesOf(ctx: ApiContext, runId: string): Promise<Workspace[]> {
  const base = join(ctx.krama.workspaceRoot, 'runs', runId);
  const agents = ctx.krama.runtime.list({ runId });
  const out: Workspace[] = [];

  const shared = join(base, 'shared');
  if (await isDir(shared))
    out.push({
      id: 'shared',
      mode: 'shared',
      path: shared,
      agents: agents.filter((a) => a.workspace?.path === shared).map((a) => a.id),
    });

  let names: string[] = [];
  try {
    names = (await readdir(join(base, 'agents'), { withFileTypes: true }))
      .filter((e) => e.isDirectory() && SAFE.test(e.name))
      .map((e) => e.name)
      .sort();
  } catch {
    // no private workspaces
  }
  for (const name of names)
    out.push({ id: name, mode: 'isolated', path: join(base, 'agents', name), agents: [name] });
  return out;
}

async function workspaceDir(ctx: ApiContext, runId: string, wid: string): Promise<string> {
  await requireRun(ctx, runId);
  const ws = (await workspacesOf(ctx, runId)).find((w) => w.id === wid);
  if (!ws) throw notFound('Workspace', wid);
  return ws.path;
}

/**
 * Resolves a request path inside a workspace. The path is untrusted (the query string, and the files an agent left
 * behind): it must stay relative, and the real location, after following links, must still be inside the workspace.
 */
async function inside(root: string, rel: string): Promise<string> {
  if (rel.includes('\0') || isAbsolute(rel) || /^[A-Za-z]:/.test(rel) || rel.startsWith('\\'))
    throw new ApiProblem('validation_failed', 'The path must be relative to the workspace', {
      errors: [{ field: 'path', message: 'Use a path relative to the workspace root' }],
    });
  const realRoot = await realpath(root);
  let real: string;
  try {
    real = await realpath(resolve(realRoot, rel));
  } catch {
    throw notFound('Path', rel);
  }
  if (real !== realRoot && !real.startsWith(realRoot + sep))
    throw new ApiProblem('forbidden', 'The path leaves the workspace');
  return real;
}

const posix = (p: string) => p.split(sep).join('/');

async function tree(root: string, rel: string) {
  const realRoot = await realpath(root);
  const dir = await inside(root, rel);
  if (!(await isDir(dir)))
    throw new ApiProblem('validation_failed', 'The path is not a directory', {
      errors: [{ field: 'path', message: 'Not a directory' }],
    });
  const prefix = dir === realRoot ? '' : `${posix(dir.slice(realRoot.length + 1))}/`;
  const entries = await readdir(dir, { withFileTypes: true });
  const items: { name: string; path: string; type: 'file' | 'dir'; size?: number }[] = [];
  for (const e of entries) {
    if (e.name === '.git') continue; // repository internals are not what a person browses
    if (items.length >= MAX_TREE_ENTRIES) break;
    try {
      // A link is shown only when it resolves to something inside the workspace.
      const target = await inside(root, `${prefix}${e.name}`);
      const s = await stat(target);
      items.push(
        s.isDirectory()
          ? { name: e.name, path: `${prefix}${e.name}`, type: 'dir' }
          : { name: e.name, path: `${prefix}${e.name}`, type: 'file', size: s.size },
      );
    } catch {
      // vanished, or leads out of the workspace
    }
  }
  return items.sort((a, b) =>
    a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1,
  );
}

// ---- git -------------------------------------------------------------------

type GitResult = { ok: true; stdout: string } | { ok: false; tooLarge: boolean };

/**
 * Runs git in a workspace. The directory belongs to an agent, so nothing from its repository configuration may run:
 * no filesystem monitor, no external diff or text conversion, no pager, and no prompts.
 */
function git(dir: string, args: string[]): Promise<GitResult> {
  return new Promise((done) => {
    execFile(
      'git',
      ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.pager=cat', ...args],
      {
        cwd: dir,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: MAX_DIFF_BYTES,
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' },
      },
      (err, stdout) => {
        if (!err) return done({ ok: true, stdout });
        const code = (err as NodeJS.ErrnoException).code;
        done({ ok: false, tooLarge: code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' });
      },
    );
  });
}

/** Only a workspace that is itself a repository counts: a parent directory's repository says nothing about it. */
const isRepo = (dir: string): Promise<boolean> =>
  stat(join(dir, '.git')).then(
    () => true,
    () => false,
  );

type FileStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked';

export function parseGitStatus(out: string): {
  branch?: string;
  files: { path: string; status: FileStatus }[];
} {
  const parts = out.split('\0');
  let branch: string | undefined;
  const files: { path: string; status: FileStatus }[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    if (p === '') continue;
    if (p.startsWith('## ')) {
      const text = p.slice(3);
      if (text.startsWith('No commits yet on ')) branch = text.slice('No commits yet on '.length);
      else if (!text.startsWith('HEAD (no branch)')) branch = text.split(/\.\.\.| /)[0];
      continue;
    }
    const xy = p.slice(0, 2);
    const path = p.slice(3);
    const kind = (c: string) => xy.includes(c);
    const status: FileStatus =
      xy === '??'
        ? 'untracked'
        : kind('R') || kind('C')
          ? 'renamed'
          : kind('D')
            ? 'deleted'
            : kind('A')
              ? 'added'
              : 'modified';
    if (status === 'renamed') i++; // the original name follows as its own entry
    files.push({ path, status });
  }
  return { ...(branch ? { branch } : {}), files };
}

const REF = /^[A-Za-z0-9._/~^@{}-]{1,200}$/;

export function workspaceHandlers(): Handlers {
  return {
    listWorkspaces: async (req) => {
      const id = req.params['id']!;
      await requireRun(req.ctx, id);
      return { items: await workspacesOf(req.ctx, id) };
    },

    getWorkspaceTree: async (req) => {
      const dir = await workspaceDir(req.ctx, req.params['id']!, req.params['wid']!);
      const { path } = req.query as { path?: string };
      return { items: await tree(dir, path ?? '') };
    },

    getWorkspaceFile: async (req) => {
      const dir = await workspaceDir(req.ctx, req.params['id']!, req.params['wid']!);
      const { path } = req.query as { path: string };
      const real = await inside(dir, path);
      const s = await stat(real);
      if (!s.isFile())
        throw new ApiProblem('validation_failed', 'The path is not a file', {
          errors: [{ field: 'path', message: 'Not a file' }],
        });
      const mediaType = mediaTypeOfPath(path);
      const neg = negotiate(req, s.size, {
        etag: `"${s.size}-${Math.floor(s.mtimeMs)}"`,
        mediaType,
      });
      if (neg.kind === 'not_modified' || neg.kind === 'unsatisfiable') return neg.response;
      const stream = createReadStream(
        real,
        neg.range ? { start: neg.range.start, end: neg.range.end } : {},
      );
      return new RawBody(stream, {
        status: neg.kind === 'partial' ? 206 : 200,
        mediaType,
        headers: neg.headers,
      });
    },

    getWorkspaceGitStatus: async (req) => {
      const dir = await workspaceDir(req.ctx, req.params['id']!, req.params['wid']!);
      if (!(await isRepo(dir))) return { files: [] };
      const res = await git(dir, ['status', '--porcelain=v1', '-z', '--branch']);
      return res.ok ? parseGitStatus(res.stdout) : { files: [] };
    },

    getWorkspaceDiff: async (req) => {
      const dir = await workspaceDir(req.ctx, req.params['id']!, req.params['wid']!);
      const { base } = req.query as { base?: string };
      if (base !== undefined && (!REF.test(base) || base.startsWith('-')))
        throw new ApiProblem('validation_failed', 'The base is not a valid reference', {
          errors: [{ field: 'base', message: 'Use a branch, tag or commit' }],
        });
      const against = base ?? 'HEAD';
      if (!(await isRepo(dir))) return { base: against, diff: '' };
      const res = await git(dir, [
        'diff',
        '--no-color',
        '--no-ext-diff',
        '--no-textconv',
        against,
        '--',
      ]);
      if (res.ok) return { base: against, diff: res.stdout };
      if (res.tooLarge)
        throw new ApiProblem('payload_too_large', 'The diff is too large to return');
      // No such base, or no commits yet: there is nothing to compare against.
      return { base: against, diff: '' };
    },
  };
}
