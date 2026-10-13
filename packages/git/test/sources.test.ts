import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  Git,
  GitError,
  Repo,
  Sources,
  normalizeRemote,
  remoteAllowed,
  type Person,
  type SourceEvent,
} from '../src/index.js';

const hasGit = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const git = new Git({ isolated: true });
const ann: Person = { name: 'Ann Author', email: 'ann@example.com' };
const id = {
  GIT_AUTHOR_NAME: ann.name,
  GIT_AUTHOR_EMAIL: ann.email,
  GIT_COMMITTER_NAME: ann.name,
  GIT_COMMITTER_EMAIL: ann.email,
};

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'krama src '));
  dirs.push(d);
  return d;
};
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A remote with a working copy: commit into `work`, then `push` to the bare `url`. */
async function remote(files: Record<string, string>) {
  const base = tmp();
  const url = join(base, 'remote.git');
  const work = join(base, 'work');
  mkdirSync(work, { recursive: true });
  await git.run(['init', '-q', '--bare', '-b', 'main', url]);
  await git.run(['init', '-q', '-b', 'main'], { cwd: work });
  const r = {
    url,
    work,
    async commit(more: Record<string, string>, message = 'change', remove: string[] = []) {
      for (const [f, text] of Object.entries(more)) {
        mkdirSync(join(work, f, '..'), { recursive: true });
        writeFileSync(join(work, f), text);
      }
      for (const f of remove) rmSync(join(work, f));
      await git.run(['add', '-A'], { cwd: work });
      await git.run(['commit', '-q', '-m', message], { cwd: work, env: id });
      return git.text(['rev-parse', 'HEAD'], { cwd: work });
    },
    tag: (name: string, force = false) =>
      git.run(['tag', '-a', ...(force ? ['-f'] : []), name, '-m', name], { cwd: work, env: id }),
    push: (...refs: string[]) =>
      git.run(['push', '-q', '--force', url, ...(refs.length ? refs : ['main', '--tags'])], {
        cwd: work,
      }),
  };
  await r.commit(files, 'first');
  await r.push();
  return r;
}

const open = async (
  o: Partial<Parameters<typeof Sources.open>[0]> = {},
  events: SourceEvent[] = [],
) => Sources.open({ root: join(tmp(), 'sources'), git, onEvent: (e) => events.push(e), ...o });

describe.skipIf(!hasGit)('installed sources', () => {
  it('pins a tag, a branch and a commit, and gives a work tree with the files', async () => {
    const r = await remote({
      'workers/author/config.json': '{"v":1}',
      'workers/author/memory/instructions.md': 'be brief',
    });
    const sha1 = await git.text(['rev-parse', 'HEAD'], { cwd: r.work });
    await r.tag('v1.0.0');
    await r.push();
    const sources = await open();

    const byTag = await sources.resolve({ url: r.url, ref: 'v1.0.0', path: 'workers/author' });
    expect(byTag.entry).toMatchObject({ refKind: 'tag', sha: sha1, path: 'workers/author' });
    expect(readFileSync(join(byTag.dir, 'config.json'), 'utf8')).toBe('{"v":1}');
    expect(existsSync(join(byTag.dir, 'memory/instructions.md'))).toBe(true);

    const byBranch = await sources.resolve({ url: r.url, ref: 'main', path: '' });
    expect(byBranch.entry).toMatchObject({ refKind: 'branch', sha: sha1 });
    const byCommit = await sources.resolve({ url: r.url, ref: sha1.slice(0, 10), path: '' });
    expect(byCommit.entry).toMatchObject({ refKind: 'commit', sha: sha1 });
    // One work tree per commit, however it was asked for.
    expect(byTag.dir.startsWith(byBranch.dir)).toBe(true);

    await expect(sources.resolve({ url: r.url, ref: 'nope', path: '' })).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('writes lock.json and then works from it with the remote gone (the offline cache)', async () => {
    const r = await remote({ 'a/config.json': '{}' });
    await r.tag('v1');
    await r.push();
    const events: SourceEvent[] = [];
    const sources = await open({}, events);
    const src = { url: r.url, ref: 'v1', path: 'a' };
    const first = await sources.resolve(src);
    expect(first.changed).toBe(true);
    const lock = await sources.lockfile();
    expect(Object.values(lock)).toHaveLength(1);
    expect(Object.values(lock)[0]).toMatchObject({ ref: 'v1', sha: first.entry.sha });

    rmSync(r.url, { recursive: true, force: true });
    const again = await sources.resolve(src);
    expect(again.changed).toBe(false);
    expect(again.dir).toBe(first.dir);
    // Looking at the remote again is what an update does, and it cannot.
    await expect(sources.resolve(src, { update: true })).rejects.toBeInstanceOf(GitError);
    expect(Object.values(await sources.lockfile())[0]!.sha).toBe(first.entry.sha);
    expect(events.map((e) => e.type)).toEqual([
      'source.fetched',
      'source.pinned',
      'source.refused',
    ]);
  });

  it('previews an update as a diff, moves the pin only when asked, and keeps the old work tree to go back to', async () => {
    const r = await remote({ 'a/config.json': '{"v":1}', 'a/keep.md': 'same', 'a/gone.md': 'x' });
    const sources = await open();
    const src = { url: r.url, ref: 'main', path: 'a' };
    const pinned = await sources.resolve(src);

    const sha2 = await r.commit({ 'a/config.json': '{"v":2}', 'a/new.md': 'n' }, 'second', [
      'a/gone.md',
    ]);
    await r.push();
    const preview = await sources.preview(src);
    expect(preview).toMatchObject({ from: pinned.entry.sha, to: sha2 });
    expect(preview.changes).toEqual(
      expect.arrayContaining([
        { status: 'modified', path: 'a/config.json' },
        { status: 'added', path: 'a/new.md' },
        { status: 'deleted', path: 'a/gone.md' },
      ]),
    );
    // A preview is not an update.
    expect((await sources.resolve(src)).entry.sha).toBe(pinned.entry.sha);

    const updated = await sources.resolve(src, { update: true });
    expect(updated).toMatchObject({ changed: true });
    expect(updated.entry.sha).toBe(sha2);
    expect(readFileSync(join(updated.dir, 'config.json'), 'utf8')).toBe('{"v":2}');
    // The commit that was pinned before is still checked out: rolling back is pinning it again.
    expect(readFileSync(join(pinned.dir, 'config.json'), 'utf8')).toBe('{"v":1}');
    expect(pinned.dir).not.toBe(updated.dir);
  });

  it('refuses a tag the remote has moved, keeps the old pin, reports it, and still serves other refs', async () => {
    const r = await remote({ 'a/config.json': '{"v":1}' });
    const sha1 = await git.text(['rev-parse', 'HEAD'], { cwd: r.work });
    await r.tag('v1');
    await r.push();
    const events: SourceEvent[] = [];
    const sources = await open({}, events);
    const src = { url: r.url, ref: 'v1', path: 'a' };
    await sources.resolve(src);

    // Someone force-moves the published tag to a different commit.
    const sha2 = await r.commit({ 'a/config.json': '{"v":"tampered"}' }, 'swapped');
    await r.tag('v1', true);
    await r.push();

    await expect(sources.resolve(src, { update: true })).rejects.toMatchObject({
      code: 'refused',
      message: expect.stringMatching(/tag v1 .* does not move/),
    });
    expect(Object.values(await sources.lockfile())[0]!.sha).toBe(sha1);
    const moved = events.find((e) => e.type === 'source.moved_tag');
    expect(moved).toMatchObject({ moved: [{ tag: 'v1', was: sha1, now: sha2 }] });
    expect(events.some((e) => e.type === 'source.refused' && e.reason === 'moved_tag')).toBe(true);
    // The pinned tag still resolves to the commit it first named, and the branch is free to move.
    const stillPinned = await sources.resolve(src);
    expect(readFileSync(join(stillPinned.dir, 'config.json'), 'utf8')).toBe('{"v":1}');
    expect((await sources.resolve({ url: r.url, ref: 'main', path: 'a' })).entry.sha).toBe(sha2);
  });

  it('keeps a pack and the agents it pulls from other repositories each pinned, however deep', async () => {
    const wrappers = await remote({ 'agents/claude-reviewer/config.json': '{"w":1}' });
    const team = await remote({ 'workers/author/config.json': '{"t":1}' });
    await wrappers.tag('v2.0.0');
    await team.tag('v1.2.0');
    await wrappers.push();
    await team.push();
    const sources = await open();
    const a = await sources.resolveGit({
      url: wrappers.url,
      ref: 'v2.0.0',
      path: 'agents/claude-reviewer',
    });
    const b = await sources.resolveGit({ url: team.url, ref: 'v1.2.0', path: 'workers/author' });
    expect(readFileSync(join(a.dir, 'config.json'), 'utf8')).toBe('{"w":1}');
    expect(readFileSync(join(b.dir, 'config.json'), 'utf8')).toBe('{"t":1}');
    expect(a.sha).not.toBe(b.sha);
    expect(Object.keys(await sources.lockfile())).toHaveLength(2);
  });

  describe('policy', () => {
    it('matches remotes written in any of git’s forms against an allow-list', () => {
      expect(normalizeRemote('https://github.com/Acme/Agents.git')).toBe('github.com/acme/agents');
      expect(normalizeRemote('git@github.com:acme/agents.git')).toBe('github.com/acme/agents');
      expect(normalizeRemote('ssh://git@host.example/x/y/')).toBe('host.example/x/y');
      expect(normalizeRemote('https://user:tok@github.com/a/b')).toBe('github.com/a/b');
      expect(remoteAllowed('git@github.com:acme/agents.git', ['github.com/acme/*'])).toBe(true);
      expect(remoteAllowed('https://github.com/evil/agents', ['github.com/acme/*'])).toBe(false);
      expect(remoteAllowed('https://anything/at/all', [])).toBe(true);
      expect(remoteAllowed('https://anything/at/all', undefined)).toBe(true);
    });

    it('refuses a remote that is not allowed before it is touched, and says so on the record', async () => {
      const r = await remote({ 'a/config.json': '{}' });
      const events: SourceEvent[] = [];
      const root = join(tmp(), 'sources');
      const sources = await open({ root, allow: ['github.com/acme/*'] }, events);
      await expect(sources.resolve({ url: r.url, ref: 'main', path: '' })).rejects.toMatchObject({
        code: 'refused',
      });
      expect(existsSync(join(root, 'lock.json'))).toBe(false);
      expect(events).toEqual([
        expect.objectContaining({ type: 'source.refused', reason: 'not_allowed' }),
      ]);
      await expect(sources.fetch(r.url)).rejects.toMatchObject({ code: 'refused' });
    });

    it('refuses an unsigned source when signed ones are required, and pins nothing', async () => {
      const r = await remote({ 'a/config.json': '{}' });
      await r.tag('v1');
      await r.push();
      const events: SourceEvent[] = [];
      const sources = await open({ requireSigned: true }, events);
      for (const ref of ['v1', 'main'])
        await expect(sources.resolve({ url: r.url, ref, path: '' })).rejects.toMatchObject({
          code: 'refused',
          message: expect.stringMatching(/not signed/),
        });
      expect(await sources.lockfile()).toEqual({});
      expect(
        events.filter((e) => e.type === 'source.refused' && e.reason === 'unsigned'),
      ).toHaveLength(2);
    });

    it('never lets a credential in a URL reach an error or an event', async () => {
      const events: SourceEvent[] = [];
      const sources = await open({}, events);
      const err = (await sources
        .fetch('http://ann:hunter2-s3cret@127.0.0.1:1/x.git')
        .catch((e: unknown) => e)) as GitError;
      expect(err).toBeInstanceOf(GitError);
      for (const text of [
        err.message,
        err.stderr,
        JSON.stringify(err.args),
        JSON.stringify(events),
      ])
        expect(text).not.toContain('hunter2-s3cret');
    });
  });
});

describe.skipIf(!hasGit)('pushing an authored repository', () => {
  const lsRemote = async (url: string) =>
    Object.fromEntries(
      (await git.text(['ls-remote', '--heads', '--tags', url]))
        .split('\n')
        .filter((l) => l && !l.endsWith('^{}'))
        .map((l) => l.split('\t').reverse() as [string, string]),
    );

  const made = async () => {
    const base = tmp();
    const bare = join(base, 'origin.git');
    await git.run(['init', '-q', '--bare', '-b', 'main', bare]);
    const repo = await Repo.init(join(base, 'pack'), ann, { git });
    const draft = await repo.createDraft('d', ann);
    writeFileSync(join(draft.dir, 'krama-pack.yaml'), 'v1\n');
    await draft.save(ann);
    await repo.createRevision(draft.branch, ann, { message: 'One' });
    await repo.promote(1, ann);
    await repo.setRemote(bare);
    return { base, bare, repo, draft };
  };

  it('sends production, the draft and the revisions, and reports each ref', async () => {
    const { bare, repo } = await made();
    expect((await repo.remotes()).map((r) => r.name)).toEqual(['origin']);
    const first = await repo.push(ann);
    expect(first.rejected).toEqual([]);
    expect(first.pushed.sort()).toEqual(['draft/d', 'main', 'rev/1']);
    const remoteRefs = await lsRemote(bare);
    expect(Object.keys(remoteRefs).sort()).toEqual([
      'refs/heads/draft/d',
      'refs/heads/main',
      'refs/tags/rev/1',
    ]);
    const again = await repo.push(ann);
    expect(again.pushed).toEqual([]);
    expect(again.upToDate.sort()).toEqual(['draft/d', 'main', 'rev/1']);
  });

  it('never forces: a diverged branch and a revision number the remote has for another commit are refused, the rest still goes', async () => {
    const { bare, repo, draft } = await made();
    // Someone else has already pushed their own history and their own rev/1 to this remote.
    const other = await Repo.init(
      join(tmp(), 'other'),
      { name: 'Bo', email: 'bo@example.com' },
      { git },
    );
    const od = await other.createDraft('x', ann);
    writeFileSync(join(od.dir, 'f'), 'theirs');
    await od.save(ann);
    await other.createRevision(od.branch, ann);
    await other.promote(1, ann);
    await other.setRemote(bare);
    const theirs = await other.push(ann, { drafts: 'none' });
    expect(theirs.rejected).toEqual([]);
    const theirMain = (await lsRemote(bare))['refs/heads/main'];

    writeFileSync(join(draft.dir, 'more.md'), 'more');
    await draft.save(ann);
    const res = await repo.push(ann);
    expect(res.rejected.map((x) => x.ref).sort()).toEqual(['main', 'rev/1']);
    expect(res.pushed).toEqual(['draft/d']);
    expect(res.rejected.every((x) => x.reason.length > 0)).toBe(true);
    // Their production and their revision are exactly as they were.
    const after = await lsRemote(bare);
    expect(after['refs/heads/main']).toBe(theirMain);
    expect(after['refs/tags/rev/1']).not.toBe((await repo.revision(1)).sha);
  });

  it('says plainly when the remote cannot be reached, and sends nothing', async () => {
    const { repo } = await made();
    await repo.setRemote(join(tmp(), 'does-not-exist.git'));
    await expect(repo.push(ann)).rejects.toBeInstanceOf(GitError);
    expect((await repo.remotes())[0]!.name).toBe('origin');
  });

  it('keeps a credential in a remote URL out of what it reports', async () => {
    const { repo } = await made();
    await repo.setRemote('http://ann:topsecret-token@127.0.0.1:1/x.git');
    expect(JSON.stringify(await repo.remotes())).not.toContain('topsecret-token');
    const err = (await repo.push(ann).catch((e: unknown) => e)) as GitError;
    expect(`${err.message} ${err.stderr}`).not.toContain('topsecret-token');
  });
});
