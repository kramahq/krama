import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Git } from '@kramahq/git';
import type { ActorRef } from '@kramahq/contract';

export const hasGit = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

export const git = new Git({ isolated: true });
const id = {
  GIT_AUTHOR_NAME: 'Ann',
  GIT_AUTHOR_EMAIL: 'a@example.com',
  GIT_COMMITTER_NAME: 'Ann',
  GIT_COMMITTER_EMAIL: 'a@example.com',
};
export const admin: ActorRef = { type: 'user', id: 'u_admin', name: 'Admin', role: 'admin' };

const dirs: string[] = [];
export const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'krama packs '));
  dirs.push(d);
  return d;
};
export const cleanup = () =>
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));

export async function remote() {
  const base = tmp();
  const url = join(base, 'remote.git');
  const work = join(base, 'work');
  mkdirSync(work, { recursive: true });
  await git.run(['init', '-q', '--bare', '-b', 'main', url]);
  await git.run(['init', '-q', '-b', 'main'], { cwd: work });
  return {
    url,
    async commit(files: Record<string, string>, message = 'change') {
      for (const [f, text] of Object.entries(files)) {
        mkdirSync(join(work, f, '..'), { recursive: true });
        writeFileSync(join(work, f), text);
      }
      await git.run(['add', '-A'], { cwd: work });
      await git.run(['commit', '-q', '-m', message], { cwd: work, env: id });
      await git.run(['push', '-q', url, 'main'], { cwd: work });
      return git.text(['rev-parse', 'HEAD'], { cwd: work });
    },
    tag: async (name: string) => {
      await git.run(['tag', '-a', name, '-m', name], { cwd: work, env: id });
      await git.run(['push', '-q', url, '--tags'], { cwd: work });
    },
  };
}

export const agentConfig = (name: string, extra: object = {}) =>
  JSON.stringify({
    agentCard: {
      name,
      description: `The ${name}`,
      skills: [{ id: name, name, description: `Does the ${name}'s work` }],
    },
    claude: { model: 'claude-sonnet-5-5' },
    ...extra,
  });
