import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { BackendRegistry, validateOptions } from '@kramahq/agents';
import { Git, Sources } from '@kramahq/git';
import { loadPackDir, type PackLoadEnv } from '@kramahq/pack';
import { createKrama } from '../src/index.js';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * The packs Krama ships (the `krama-packs` repository), checked against the real backend descriptors. They are read from
 * a checkout, so this runs where one exists: `KRAMA_PACKS_DIR`, or a `krama-packs` folder next to this repository.
 * Agents the packs take from another repository are checked offline (a warning) unless `KRAMA_PACKS_ONLINE=1`, which
 * fetches them at their pinned commits, so the default run never needs the network.
 */
const dir = process.env.KRAMA_PACKS_DIR ?? resolve(__dirname, '../../../../krama-packs');
const packs = existsSync(dir)
  ? readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(dir, e.name, 'krama-pack.yaml')))
      .map((e) => e.name)
  : [];

const online = process.env.KRAMA_PACKS_ONLINE === '1';
const scratch = mkdtempSync(join(tmpdir(), 'krama shipped packs '));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const env = async (): Promise<PackLoadEnv> => {
  const backends = BackendRegistry.withBuiltins();
  const sources = online
    ? await Sources.open({ root: join(scratch, 'sources'), git: new Git() })
    : undefined;
  return {
    backends,
    ...(sources
      ? { resolveGit: (s: Parameters<Sources['resolveGit']>[0]) => sources.resolveGit(s) }
      : {}),
    checkProviderConfig: (d, section) =>
      validateOptions(d, section).map((i) => ({ path: i.path, message: i.message })),
  };
};

describe.skipIf(packs.length === 0)('the packs Krama ships', () => {
  it.each(packs)(
    '%s validates against the real backends',
    async (name) => {
      const load = await loadPackDir(join(dir, name), await env());
      expect(load.issues.filter((i) => i.severity === 'error')).toEqual([]);
      expect(load.ok).toBe(true);
      if (online)
        expect(
          Object.values(load.agents)
            .filter((a) => a.kind === 'git')
            .every((a) => a.sha && /^[0-9a-f]{40}$/.test(a.sha)),
        ).toBe(true);
    },
    120_000,
  );
});

/**
 * A shipped pack, installed from git the way a person would install it, then used: a run is created on it and records the
 * exact commit of the pack. Needs the network, because the agents it takes from the wrapper repository are fetched.
 */
describe.skipIf(!online || packs.length === 0)(
  'installing a shipped pack and starting a run',
  () => {
    it.each(packs)(
      '%s',
      async (name) => {
        const git = new Git({ isolated: true });
        const ident = {
          GIT_AUTHOR_NAME: 'Ann',
          GIT_AUTHOR_EMAIL: 'ann@example.com',
          GIT_COMMITTER_NAME: 'Ann',
          GIT_COMMITTER_EMAIL: 'ann@example.com',
        };
        // The pack directory as a repository of its own, tagged, standing in for the published `krama-packs`.
        const work = join(scratch, `work-${name}`);
        cpSync(join(dir, name), join(work, name), { recursive: true });
        await git.run(['init', '-q', '-b', 'main'], { cwd: work });
        await git.run(['add', '-A'], { cwd: work });
        await git.run(['commit', '-q', '-m', 'the pack'], { cwd: work, env: ident });
        await git.run(['tag', '-a', 'v0.1.0', '-m', 'v0.1.0'], { cwd: work, env: ident });

        const home = join(scratch, `home-${name}`);
        mkdirSync(home, { recursive: true });
        const krama = await createKrama({
          home,
          packs: [],
          definitions: [],
          backends: BackendRegistry.withBuiltins(),
          engineVersion: '0.3.0',
          sources: { git: new Git() },
        });
        try {
          const src = { url: work.replace(/\\/g, '/'), ref: 'v0.1.0', path: name };
          const preview = await krama.packs.preview(src);
          expect(preview.issues.filter((i) => i.severity === 'error')).toEqual([]);
          const person = {
            type: 'user' as const,
            id: 'u_admin',
            name: 'Admin',
            role: 'admin' as const,
          };
          const pack = await krama.packs.install(
            {
              previewId: preview.previewId,
              manifestDigest: preview.manifestDigest,
              consent: { granted: preview.permissions.map((p) => p.id), declined: [] },
            },
            person,
          );
          const run = await krama.engine.runs.create(
            { packId: pack.id, input: { text: 'KAN-1' } },
            person,
          );
          expect(run.pack).toEqual({ id: pack.id, version: pack.version, sha: pack.source.sha });
          expect(run.orchestrator.backend).toBe('a2a-claude');
          // What the runtime will start each agent from: the wrapper's own config for one taken from git, and absolute paths
          // for the files an agent's config points at.
          for (const [id, a] of Object.entries(pack.agents ?? {})) {
            const files = krama.packs.agentFiles(pack, id);
            expect(files, id).toBeDefined();
            if (a.git) expect(Object.keys(files!.config)).toContain('claude');
            const memory = files!.config['memory'] as { instructions?: string } | undefined;
            if (memory?.instructions) {
              expect(isAbsolute(memory.instructions), id).toBe(true);
              expect(existsSync(memory.instructions), id).toBe(true);
            }
          }
        } finally {
          await krama.close();
        }
      },
      120_000,
    );
  },
);
