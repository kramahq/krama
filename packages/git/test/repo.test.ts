import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Git, GitError, Repo, redactUrls, type Person, type RepoEvent } from '../src/index.js';

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
const bo: Person = { name: 'Bo Builder', email: 'bo@example.com' };

const dirs: string[] = [];
const tmp = () => {
  // A space in the path, as a person's home or a Windows profile may have.
  const d = mkdtempSync(join(tmpdir(), 'krama git '));
  dirs.push(d);
  return d;
};
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const newRepo = async (events: RepoEvent[] = []) =>
  Repo.init(join(tmp(), 'my pack'), ann, { git, onEvent: (e) => events.push(e) });
const put = (dir: string, file: string, text: string) => {
  mkdirSync(join(dir, file, '..'), { recursive: true });
  writeFileSync(join(dir, file), text);
};

describe.skipIf(!hasGit)('an authored repository', () => {
  it('starts with production at an empty first commit, and refuses to be started twice', async () => {
    const repo = await newRepo();
    expect((await repo.log('main')).map((c) => c.subject)).toEqual(['Start']);
    expect((await repo.production()).revision).toBeUndefined();
    await expect(Repo.init(repo.dir, ann, { git })).rejects.toMatchObject({ code: 'exists' });
    await expect(Repo.open(tmp(), { git })).rejects.toMatchObject({ code: 'not_a_repo' });
    expect((await Repo.open(repo.dir, { git })).dir).toBe(repo.dir);
  });

  describe('saving a draft', () => {
    it('makes one commit per save, by the person, and none when nothing changed', async () => {
      const repo = await newRepo();
      const draft = await repo.createDraft('release-notes', ann);
      put(draft.dir, 'krama-pack.yaml', 'name: a\n');
      const first = await draft.save(ann, {
        message: 'First version',
        trailers: { 'Krama-Session': 'ses_1' },
      });
      expect(first).toMatchObject({ files: 1 });
      expect(await draft.save(ann)).toBeUndefined();

      put(draft.dir, 'krama-pack.yaml', 'name: a\nversion: 0.1.0\n');
      put(draft.dir, 'agents/x/config.json', '{}');
      const second = await draft.save(bo, { message: 'Add an agent' });
      expect(second!.files).toBe(2);

      const log = await draft.log();
      expect(log.map((c) => [c.subject, c.author.name, c.author.email])).toEqual([
        ['Add an agent', 'Bo Builder', 'bo@example.com'],
        ['First version', 'Ann Author', 'ann@example.com'],
        ['Start', 'Ann Author', 'ann@example.com'],
      ]);
      expect(log[1]!.body).toContain('Krama-Session: ses_1');
      expect(log[0]!.parents).toEqual([log[1]!.sha]);
    });

    it('keeps production untouched, and a second draft apart from the first', async () => {
      const repo = await newRepo();
      const a = await repo.createDraft('a', ann);
      const b = await repo.createDraft('b', ann);
      put(a.dir, 'only-in-a.txt', 'a');
      await a.save(ann);
      expect(existsSync(join(repo.dir, 'only-in-a.txt'))).toBe(false);
      expect(existsSync(join(b.dir, 'only-in-a.txt'))).toBe(false);
      expect((await repo.drafts()).map((d) => d.name).sort()).toEqual(['a', 'b']);
      expect((await repo.log('main')).length).toBe(1);
    });

    it('takes only a sound draft name, and only once', async () => {
      const repo = await newRepo();
      for (const bad of ['', 'Has Space', '../escape', '-lead', 'x'.repeat(64)])
        await expect(repo.createDraft(bad, ann)).rejects.toMatchObject({ code: 'invalid' });
      await repo.createDraft('ok', ann);
      await expect(repo.createDraft('ok', ann)).rejects.toMatchObject({ code: 'exists' });
    });

    it('refuses a credential, names the file and line, never repeats the value, and commits nothing', async () => {
      const repo = await newRepo();
      const draft = await repo.createDraft('d', ann);
      const secret = 'sk-' + 'q'.repeat(40);
      put(
        draft.dir,
        'agents/x/config.json',
        `{\n  "mcp": { "h": { "Authorization": "Bearer ${'z'.repeat(30)}" } },\n  "k": "${secret}"\n}`,
      );
      put(draft.dir, 'fine.md', 'nothing here');
      const err = (await draft.save(ann).catch((e: unknown) => e)) as GitError;
      expect(err).toBeInstanceOf(GitError);
      expect(err.code).toBe('secret_found');
      expect(err.message).toContain('agents/x/config.json:2');
      expect(err.message).toContain('agents/x/config.json:3');
      expect(err.message).not.toContain(secret);
      expect((await draft.log()).map((c) => c.subject)).toEqual(['Start']);
      // Nothing is left staged, so the next save does not carry it along by accident.
      expect(
        execFileSync('git', ['diff', '--cached', '--name-only'], {
          cwd: draft.dir,
          encoding: 'utf8',
        }),
      ).toBe('');
      // A reference is fine, and so is a binary file that happens to contain such bytes.
      put(draft.dir, 'agents/x/config.json', '{ "k": "${API_KEY}" }');
      writeFileSync(
        join(draft.dir, 'blob.bin'),
        Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(secret)]),
      );
      expect(await draft.save(ann)).toMatchObject({ files: 3 });
    });

    it('serialises saves that arrive together', async () => {
      const repo = await newRepo();
      const a = await repo.createDraft('a', ann);
      const b = await repo.createDraft('b', ann);
      put(a.dir, 'f', '1');
      put(b.dir, 'g', '2');
      const [x, y] = await Promise.all([a.save(ann), b.save(bo)]);
      expect(x?.sha).toBeTruthy();
      expect(y?.sha).toBeTruthy();
      expect((await a.log()).length).toBe(2);
      expect((await b.log()).length).toBe(2);
    });

    it('can throw a draft away', async () => {
      const repo = await newRepo();
      const d = await repo.createDraft('gone', ann);
      put(d.dir, 'x', '1');
      await d.save(ann);
      await repo.discardDraft('gone', ann);
      expect(await repo.draft('gone')).toBeUndefined();
      expect(existsSync(d.dir)).toBe(false);
      await expect(repo.discardDraft('gone', ann)).rejects.toMatchObject({ code: 'not_found' });
    });
  });

  describe('revisions', () => {
    it('numbers them upwards, labels them, and gives the same one back for the same commit', async () => {
      const repo = await newRepo();
      const d = await repo.createDraft('d', ann);
      put(d.dir, 'f', '1');
      const s1 = await d.save(ann);
      const r1 = await repo.createRevision(d.branch, bo, {
        message: 'First cut\n\nCovers the basics.',
      });
      expect(r1.created).toBe(true);
      expect(r1.revision).toMatchObject({
        name: 'rev/1',
        n: 1,
        sha: s1!.sha,
        label: 'First cut',
        tagger: bo,
      });
      expect(r1.revision.message).toContain('Covers the basics.');
      expect((await repo.createRevision(d.branch, ann)).created).toBe(false);

      put(d.dir, 'f', '2');
      await d.save(ann);
      const r2 = await repo.createRevision(d.branch, ann);
      expect(r2.revision).toMatchObject({ name: 'rev/2', label: 'Revision 2' });
      expect((await repo.revisions()).map((r) => r.name)).toEqual(['rev/1', 'rev/2']);
      expect((await repo.revision(2)).sha).toBe(r2.revision.sha);
      await expect(repo.revision(9)).rejects.toMatchObject({ code: 'not_found' });
      await expect(repo.createRevision('nope', ann)).rejects.toMatchObject({ code: 'not_found' });
    });

    it('does not count a tag that is not an annotated revision, and numbers concurrent ones apart', async () => {
      const repo = await newRepo();
      execFileSync('git', ['tag', 'rev/7'], {
        cwd: repo.dir,
        env: { ...process.env, GIT_CONFIG_GLOBAL: devNull },
      });
      expect(await repo.revisions()).toEqual([]);
      const d = await repo.createDraft('d', ann);
      const shas: string[] = [];
      for (const n of ['a', 'b', 'c']) {
        put(d.dir, n, n);
        shas.push((await d.save(ann))!.sha);
      }
      const made = await Promise.all(shas.map((s) => repo.createRevision(s, ann)));
      expect(new Set(made.map((m) => m.revision.name)).size).toBe(3);
    });
  });

  describe('production', () => {
    /** A draft saved twice and made a revision each time. */
    const twoRevisions = async (events: RepoEvent[] = []) => {
      const repo = await newRepo(events);
      const d = await repo.createDraft('d', ann);
      put(d.dir, 'krama-pack.yaml', 'v1\n');
      await d.save(ann);
      await repo.createRevision(d.branch, ann, { message: 'One' });
      put(d.dir, 'krama-pack.yaml', 'v2\n');
      put(d.dir, 'extra.md', 'added later');
      await d.save(ann);
      await repo.createRevision(d.branch, ann, { message: 'Two' });
      return { repo, d };
    };

    it('moves forward to a revision only, and says which revision it is', async () => {
      const { repo } = await twoRevisions();
      expect(await repo.promote('rev/1', ann)).toMatchObject({ changed: true });
      expect(readFileSync(join(repo.dir, 'krama-pack.yaml'), 'utf8')).toBe('v1\n');
      expect((await repo.production()).revision?.name).toBe('rev/1');
      expect((await repo.promote(1, ann)).changed).toBe(false);
      await repo.promote(2, ann);
      expect((await repo.production()).revision?.name).toBe('rev/2');
      expect(readFileSync(join(repo.dir, 'extra.md'), 'utf8')).toBe('added later');
      await expect(repo.promote(9, ann)).rejects.toMatchObject({ code: 'not_found' });
    });

    it('refuses a revision that is not ahead of production, until its draft has caught up', async () => {
      const { repo, d } = await twoRevisions();
      const other = await repo.createDraft('other', bo);
      put(other.dir, 'other.md', 'x');
      await other.save(bo);
      const rOther = (await repo.createRevision(other.branch, bo)).revision;
      await repo.promote(2, ann);
      // `other` was made from the old production; production has moved on.
      await expect(repo.promote(rOther.n, ann)).rejects.toMatchObject({ code: 'not_fast_forward' });
      expect(await other.catchUp(bo)).toEqual({ merged: true, conflicts: [] });
      expect(await other.catchUp(bo)).toEqual({ merged: false, conflicts: [] });
      const caught = (await repo.createRevision(other.branch, bo)).revision;
      await repo.promote(caught.n, bo);
      expect(readFileSync(join(repo.dir, 'other.md'), 'utf8')).toBe('x');
      expect(readFileSync(join(repo.dir, 'extra.md'), 'utf8')).toBe('added later');
      void d;
    });

    it('reports a conflict when catching up, names the files, and leaves the draft as it was', async () => {
      const { repo } = await twoRevisions();
      const x = await repo.createDraft('x', bo);
      put(x.dir, 'krama-pack.yaml', 'x wants this\n');
      await x.save(bo);
      await repo.promote(2, ann);
      const before = (await x.log())[0]!.sha;
      const r = await x.catchUp(bo);
      expect(r.merged).toBe(false);
      expect(r.conflicts).toEqual(['krama-pack.yaml']);
      expect((await x.log())[0]!.sha).toBe(before);
      expect(await x.isClean()).toBe(true);
    });

    it('will not move while production has uncommitted changes', async () => {
      const { repo } = await twoRevisions();
      put(repo.dir, 'stray.txt', 'someone edited production by hand');
      await expect(repo.promote(1, ann)).rejects.toMatchObject({ code: 'conflict' });
    });

    it('rolls back by adding a commit and a new revision, never by rewriting', async () => {
      const events: RepoEvent[] = [];
      const { repo } = await twoRevisions(events);
      await repo.promote(2, ann);
      const before = await repo.log('main');
      const out = await repo.rollback(1, bo);
      expect(out.revision).toMatchObject({ name: 'rev/3' });
      expect(out.revision.label).toContain('Rollback to rev/1');
      expect(readFileSync(join(repo.dir, 'krama-pack.yaml'), 'utf8')).toBe('v1\n');
      expect(existsSync(join(repo.dir, 'extra.md'))).toBe(false);
      // Everything that was there is still there, with the rollback on top.
      const after = await repo.log('main');
      expect(after.slice(1).map((c) => c.sha)).toEqual(before.map((c) => c.sha));
      expect((await repo.revisions()).map((r) => r.name)).toEqual(['rev/1', 'rev/2', 'rev/3']);
      expect((await repo.production()).revision?.name).toBe('rev/3');
      // And there is nothing to roll back to what it already is.
      await expect(repo.rollback(3, bo)).rejects.toMatchObject({ code: 'invalid' });
      expect(events.map((e) => e.type)).toContain('production.rolled_back');
    });
  });

  describe('looking at changes', () => {
    it('lists what changed between two revisions by file, and gives the patch', async () => {
      const repo = await newRepo();
      const d = await repo.createDraft('d', ann);
      put(d.dir, 'keep.md', 'same');
      put(d.dir, 'edit.md', 'before');
      put(d.dir, 'drop.md', 'bye');
      put(
        d.dir,
        'old name.md',
        'a long enough body to be recognised as the same file when it moves',
      );
      await d.save(ann);
      await repo.createRevision(d.branch, ann);
      put(d.dir, 'edit.md', 'after');
      rmSync(join(d.dir, 'drop.md'));
      rmSync(join(d.dir, 'old name.md'));
      put(
        d.dir,
        'new name.md',
        'a long enough body to be recognised as the same file when it moves',
      );
      put(d.dir, 'fresh.md', 'new');
      await d.save(ann);
      await repo.createRevision(d.branch, ann);
      const changes = await repo.changes('rev/1', 'rev/2');
      expect(changes).toEqual(
        expect.arrayContaining([
          { status: 'modified', path: 'edit.md' },
          { status: 'deleted', path: 'drop.md' },
          { status: 'added', path: 'fresh.md' },
          { status: 'renamed', path: 'new name.md', from: 'old name.md' },
        ]),
      );
      expect(changes.find((c) => c.path === 'keep.md')).toBeUndefined();
      const patch = await repo.patch('rev/1', 'rev/2');
      expect(patch.truncated).toBe(false);
      expect(patch.text).toContain('-before');
      expect(patch.text).toContain('+after');
      expect((await repo.patch('rev/1', 'rev/2', 10)).truncated).toBe(true);
    });
  });

  it('tells the host what happened, in order, and survives a listener that throws', async () => {
    const events: RepoEvent[] = [];
    const repo = await Repo.init(join(tmp(), 'p'), ann, {
      git,
      onEvent: (e) => {
        events.push(e);
        throw new Error('listener broke');
      },
    });
    const d = await repo.createDraft('d', ann);
    put(d.dir, 'f', '1');
    await d.save(ann);
    await repo.createRevision(d.branch, ann);
    await repo.promote(1, ann);
    expect(events.map((e) => e.type)).toEqual([
      'repo.created',
      'draft.created',
      'draft.saved',
      'revision.created',
      'production.promoted',
    ]);
  });
});

describe('the git runner', () => {
  it('removes credentials from a URL before it reaches a message', () => {
    expect(
      redactUrls('fatal: unable to access https://ann:ghp_secret@github.com/acme/x.git/'),
    ).toBe('fatal: unable to access https://github.com/acme/x.git/');
    expect(redactUrls('ssh://git@host/x')).toBe('ssh://host/x');
    expect(redactUrls('no url here')).toBe('no url here');
  });

  it('says plainly when git is missing and when it is not given a repository', async () => {
    await expect(
      new Git({ binary: 'definitely-not-git-xyz' }).run(['--version']),
    ).rejects.toMatchObject({ code: 'git_missing' });
    if (hasGit)
      await expect(git.run(['status'], { cwd: tmp() })).rejects.toMatchObject({
        code: 'not_a_repo',
      });
  });
});
