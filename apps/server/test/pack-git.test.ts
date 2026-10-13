import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BackendRegistry, validateOptions } from '@kramahq/agents';
import { Git, Sources } from '@kramahq/git';
import { loadPackDir, type PackLoadEnv } from '@kramahq/pack';
import { afterAll, describe, expect, it } from 'vitest';

const hasGit = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const git = new Git({ isolated: true });
const id = {
  GIT_AUTHOR_NAME: 'Ann',
  GIT_AUTHOR_EMAIL: 'ann@example.com',
  GIT_COMMITTER_NAME: 'Ann',
  GIT_COMMITTER_EMAIL: 'ann@example.com',
};
const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'krama pack git '));
  dirs.push(d);
  return d;
};
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A git remote: a bare repository and a working copy to commit into. */
async function remote() {
  const base = tmp();
  const url = join(base, 'remote.git');
  const work = join(base, 'work');
  mkdirSync(work, { recursive: true });
  await git.run(['init', '-q', '--bare', '-b', 'main', url]);
  await git.run(['init', '-q', '-b', 'main'], { cwd: work });
  return {
    url,
    work,
    async commit(files: Record<string, string>, message = 'change') {
      for (const [f, text] of Object.entries(files)) {
        mkdirSync(join(work, f, '..'), { recursive: true });
        writeFileSync(join(work, f), text);
      }
      await git.run(['add', '-A'], { cwd: work });
      await git.run(['commit', '-q', '-m', message], { cwd: work, env: id });
    },
    async tag(name: string) {
      await git.run(['tag', '-a', name, '-m', name], { cwd: work, env: id });
      await git.run(['push', '-q', '--force', url, 'main', '--tags'], { cwd: work });
    },
  };
}

const agentDir = (name: string, backend: 'claude' | 'codex', extra: object = {}) => ({
  [`config.json`]: JSON.stringify({
    agentCard: {
      name,
      description: `The ${name}`,
      skills: [{ id: name, name, description: `Does the ${name}'s work` }],
    },
    [backend]: backend === 'claude' ? { model: 'claude-sonnet-5-5' } : { model: 'gpt-5-codex' },
    ...extra,
  }),
});

describe.skipIf(!hasGit)('a pack in one repository whose agents live in others', () => {
  // The three repositories a shipped pack would span: the pack, the team's own agents, and the wrapper project's agents.
  const setup = async () => {
    const wrappers = await remote();
    const team = await remote();
    const packs = await remote();
    for (const [n, b] of [
      ['planner', 'claude'],
      ['reviewer', 'claude'],
    ] as const) {
      const files = agentDir(n, b);
      await wrappers.commit(
        Object.fromEntries(Object.entries(files).map(([f, t]) => [`agents/${n}/${f}`, t])),
      );
    }
    await wrappers.tag('v2.0.0');
    await team.commit(
      Object.fromEntries(
        Object.entries(agentDir('author', 'codex')).map(([f, t]) => [`workers/author/${f}`, t]),
      ),
    );
    await team.tag('v1.2.0');
    const pack = (w: string, t: string) => `
name: nested-notes
version: 0.1.0
description: A pack whose agents come from two other repositories.
orchestrator: planner
agents:
  planner:
    git: "${w}@v2.0.0#agents/planner"
    subAgents:
      - { agent: author, hint: Writes and revises the draft. }
      - { agent: reviewer, hint: Checks every draft. }
  author:
    git: { url: "${t}", ref: v1.2.0, path: workers/author }
  reviewer:
    git: "${w}@v2.0.0#agents/reviewer"
`;
    await packs.commit({ 'krama-pack.yaml': pack(wrappers.url, team.url) }, 'the pack');
    await packs.tag('v0.1.0');
    return { wrappers, team, packs };
  };

  const loadEnv = (sources: Sources): PackLoadEnv => {
    const backends = BackendRegistry.withBuiltins();
    return {
      backends,
      resolveGit: (s) => sources.resolveGit(s),
      checkProviderConfig: (descriptor, section) =>
        validateOptions(descriptor, section).map((i) => ({ path: i.path, message: i.message })),
    };
  };

  it('pins the pack and each agent, validates them with the real backends, and gives the same digest again', async () => {
    const { packs, wrappers, team } = await setup();
    const sources = await Sources.open({ root: join(tmp(), 'sources'), git });
    const pack = await sources.resolve({ url: packs.url, ref: 'v0.1.0', path: '' });
    const load = await loadPackDir(pack.dir, loadEnv(sources));
    expect(load.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(load.ok).toBe(true);
    expect(Object.fromEntries(Object.values(load.agents).map((a) => [a.id, a.backend]))).toEqual({
      planner: 'a2a-claude',
      author: 'a2a-codex',
      reviewer: 'a2a-claude',
    });
    // Three sources from three repositories (the planner and reviewer share one), each pinned to a commit.
    const lock = Object.values(await sources.lockfile());
    expect(lock.map((l) => l.url).sort()).toEqual(
      [packs.url, team.url, wrappers.url, wrappers.url].sort(),
    );
    expect(load.agents['author']!.sha).toBe(lock.find((l) => l.url === team.url)!.sha);

    const again = await loadPackDir(pack.dir, loadEnv(sources));
    expect(again.digest).toBe(load.digest);
  });

  it('is unchanged by what later happens to the repositories until someone updates, and then shows what would change', async () => {
    const { packs, wrappers } = await setup();
    const sources = await Sources.open({ root: join(tmp(), 'sources'), git });
    const pack = await sources.resolve({ url: packs.url, ref: 'v0.1.0', path: '' });
    const before = await loadPackDir(pack.dir, loadEnv(sources));

    // Someone also follows the wrapper project's branch directly.
    await sources.resolve({ url: wrappers.url, ref: 'main', path: 'agents/reviewer' });
    // The wrapper project moves its branch on, and the remote it came from disappears for good measure.
    await wrappers.commit(
      { 'agents/reviewer/memory/instructions.md': 'now with a checklist' },
      'update the reviewer',
    );
    await git.run(['push', '-q', wrappers.url, 'main'], { cwd: wrappers.work });
    const preview = await sources.preview({
      url: wrappers.url,
      ref: 'main',
      path: 'agents/reviewer',
    });
    expect(preview.changes).toEqual([
      { status: 'added', path: 'agents/reviewer/memory/instructions.md' },
    ]);
    rmSync(wrappers.url, { recursive: true, force: true });

    const after = await loadPackDir(pack.dir, loadEnv(sources));
    expect(after.ok).toBe(true);
    expect(after.digest).toBe(before.digest);
  });

  it('reports a pack whose agent source cannot be reached, with the path of the agent', async () => {
    const { packs } = await setup();
    const sources = await Sources.open({ root: join(tmp(), 'sources'), git });
    const pack = await sources.resolve({ url: packs.url, ref: 'v0.1.0', path: '' });
    // A fresh store with no lock and no remote to fetch from.
    const empty = await Sources.open({
      root: join(tmp(), 'sources'),
      git,
      allow: ['github.com/nobody/*'],
    });
    const load = await loadPackDir(pack.dir, loadEnv(empty));
    expect(load.ok).toBe(false);
    expect(
      load.issues
        .filter((i) => i.code === 'git_source_failed')
        .map((i) => i.path)
        .sort(),
    ).toEqual(['agents.author.git', 'agents.planner.git', 'agents.reviewer.git']);
    expect(load.issues.find((i) => i.code === 'git_source_failed')!.message).toMatch(
      /not in the list of allowed sources/,
    );
  });
});
