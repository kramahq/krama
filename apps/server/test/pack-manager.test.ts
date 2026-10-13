import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BackendRegistry, validateOptions } from '@kramahq/agents';
import type { ActorRef, Pack } from '@kramahq/contract';
import { Git, Sources } from '@kramahq/git';
import { afterAll, describe, expect, it } from 'vitest';
import { PackError, PackManager, type PackManagerOptions } from '../src/packs/index.js';

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
  GIT_AUTHOR_EMAIL: 'a@example.com',
  GIT_COMMITTER_NAME: 'Ann',
  GIT_COMMITTER_EMAIL: 'a@example.com',
};
const admin: ActorRef = { type: 'user', id: 'u_admin', name: 'Admin', role: 'admin' };
const slash = (p: string): string => p.replace(/\\/g, '/');

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'krama packs '));
  dirs.push(d);
  return d;
};
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

async function remote() {
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

const agentConfig = (name: string, extra: object = {}) =>
  JSON.stringify({
    agentCard: {
      name,
      description: `The ${name}`,
      skills: [{ id: name, name, description: `Does the ${name}'s work` }],
    },
    claude: { model: 'claude-sonnet-5-5' },
    ...extra,
  });

const packText = (agentsUrl: string, version: string, extra = '') => `
name: notes
version: ${version}
description: Notes from agents in another repository.
engine: ">=0.1.0"
orchestrator: planner
agents:
  planner:
    git: "${slash(agentsUrl)}@main#agents/planner"
    secrets: { SVC_TOKEN: notes-token }
    subAgents:
      - { agent: writer, hint: Writes. }
  writer:
    git: "${slash(agentsUrl)}@main#agents/writer"
${extra}`;

describe.skipIf(!hasGit)('installing packs from git', { timeout: 120_000 }, () => {
  const set = async (over: Partial<PackManagerOptions> = {}) => {
    const agents = await remote();
    const packs = await remote();
    await agents.commit({
      'agents/planner/config.json': agentConfig('planner', {
        mcp: {
          svc: {
            type: 'http',
            url: 'https://svc.example/mcp',
            headers: { Authorization: 'Bearer ${SVC_TOKEN}' },
          },
        },
      }),
      'agents/writer/config.json': agentConfig('writer'),
    });
    await packs.commit({ 'notes/krama-pack.yaml': packText(agents.url, '0.1.0') }, 'v0.1.0');
    await packs.tag('v0.1.0');
    const home = tmp();
    const audit: { kind: string; actor: string; detail: Record<string, unknown> }[] = [];
    const open = async (extra: Partial<PackManagerOptions> = {}) =>
      PackManager.open({
        dir: join(home, 'packs'),
        sources: await Sources.open({ root: join(home, 'sources'), git }),
        backends: BackendRegistry.withBuiltins(),
        secrets: { resolve: async (ref) => (ref === 'notes-token' ? 'x' : undefined) },
        checkProviderConfig: (d, s) =>
          validateOptions(d, s).map((i) => ({ path: i.path, message: i.message })),
        engineVersion: '0.3.0',
        audit: async (kind, actor, _subject, detail) =>
          void audit.push({ kind, actor: actor.id, detail }),
        ...over,
        ...extra,
      });
    return {
      agents,
      packs,
      home,
      audit,
      open,
      manager: await open(),
      src: { url: packs.url, ref: 'v0.1.0', path: 'notes' },
    };
  };
  const consent = { granted: ['mcp_server:svc:planner'], declined: [] };

  it('previews a pack with what it asks to be allowed, the secrets to bind and its digest, and installs nothing', async () => {
    const { manager, src, packs } = await set({ trusted: ['example.org/*'] });
    const p = await manager.preview(src);
    expect(p).toMatchObject({ trust: 'untrusted', engineCompatible: true });
    expect(p.manifestDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(p.sha).toBe(
      await git.text(['rev-parse', 'v0.1.0^{commit}'], { cwd: join(packs.url, '..', 'work') }),
    );
    expect(p.manifest).toMatchObject({
      id: 'pack_notes',
      version: '0.1.0',
      status: 'available',
      orchestrator: 'planner',
    });
    expect(p.permissions.map((x) => `${x.kind}:${x.subject}`).sort()).toEqual(
      expect.arrayContaining(['mcp_server:svc', 'network:svc.example', 'secret_ref:notes-token']),
    );
    expect(p.secretsToBind).toEqual([
      { ref: 'notes-token', description: expect.stringContaining('planner'), bound: true },
    ]);
    expect(p.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(await manager.list()).toEqual([]);
    expect(Date.parse(p.expiresAt)).toBeGreaterThan(Date.now());
  });

  it('marks a remote that is on the trusted list, and no other, as trusted', async () => {
    const { manager, src, packs } = await set();
    expect((await manager.preview(src)).trust).toBe('untrusted');
    const trusted = await set();
    const m = await trusted.open({
      trusted: [`${packs.url.slice(0, 3).toLowerCase()}*`, '*remote.git'],
    });
    expect((await m.preview(trusted.src)).trust).toBe('trusted');
  });

  it('installs only the preview that was consented to, once, and then serves the pack', async () => {
    const { manager, src, audit } = await set();
    const p = await manager.preview(src);
    await expect(
      manager.install({ previewId: p.previewId, manifestDigest: 'f'.repeat(64), consent }, admin),
    ).rejects.toMatchObject({ code: 'conflict' });
    await expect(
      manager.install({ previewId: 'prev_nope', manifestDigest: p.manifestDigest, consent }, admin),
    ).rejects.toMatchObject({ code: 'conflict' });

    const pack = await manager.install(
      { previewId: p.previewId, manifestDigest: p.manifestDigest, consent },
      admin,
    );
    expect(pack).toMatchObject({
      id: 'pack_notes',
      status: 'installed',
      trust: 'untrusted',
      source: { sha: p.sha },
    });
    expect((await manager.get('pack_notes'))!.agents!['writer']).toBeDefined();
    expect((await manager.list()).map((x) => x.id)).toEqual(['pack_notes']);
    await expect(
      manager.install({ previewId: p.previewId, manifestDigest: p.manifestDigest, consent }, admin),
    ).rejects.toBeInstanceOf(PackError);
    expect(audit).toEqual([
      expect.objectContaining({
        kind: 'pack.installed',
        actor: 'u_admin',
        detail: expect.objectContaining({ sha: p.sha, consent }),
      }),
    ]);
    expect((await manager.versions('pack_notes')).map((v) => [v.version, v.action])).toEqual([
      ['0.1.0', 'install'],
    ]);
  });

  it('survives a restart and works with every remote gone (the pinned commits are kept)', async () => {
    const t = await set();
    const p = await t.manager.preview(t.src);
    await t.manager.install(
      { previewId: p.previewId, manifestDigest: p.manifestDigest, consent },
      admin,
    );
    rmSync(t.agents.url, { recursive: true, force: true });
    rmSync(t.packs.url, { recursive: true, force: true });
    const again = await t.open();
    expect((await again.get('pack_notes'))!.version).toBe('0.1.0');
    expect((await again.list()).map((x) => x.id)).toEqual(['pack_notes']);
    expect(await again.manifest('pack_notes')).toMatchObject({
      name: 'notes',
      orchestrator: 'planner',
    });
  });

  it('refuses a pack that does not validate, and one this Krama is too old for', async () => {
    const t = await set();
    await t.packs.commit({
      'bad/krama-pack.yaml': packText(t.agents.url, '0.1.0').replace(
        'orchestrator: planner',
        'orchestrator: nobody',
      ),
    });
    const bad = await t.manager.preview({ url: t.packs.url, ref: 'main', path: 'bad' });
    expect(bad.issues.some((i) => i.severity === 'error')).toBe(true);
    await expect(
      t.manager.install(
        { previewId: bad.previewId, manifestDigest: bad.manifestDigest, consent },
        admin,
      ),
    ).rejects.toMatchObject({ code: 'invalid' });

    await t.packs.commit({
      'future/krama-pack.yaml': packText(t.agents.url, '0.1.0').replace('>=0.1.0', '>=9.0.0'),
    });
    const future = await t.manager.preview({ url: t.packs.url, ref: 'main', path: 'future' });
    expect(future).toMatchObject({ engineCompatible: false });
    expect(future.issues).toContainEqual(
      expect.objectContaining({ severity: 'error', path: 'engine' }),
    );
  });

  it('refuses a source that is not allowed before touching it', async () => {
    const t = await set();
    const strict = await PackManager.open({
      dir: join(t.home, 'strict'),
      sources: await Sources.open({
        root: join(t.home, 'strict-src'),
        git,
        allow: ['github.com/acme/*'],
      }),
      backends: BackendRegistry.withBuiltins(),
      secrets: { resolve: async () => undefined },
      engineVersion: '0.3.0',
    });
    await expect(strict.preview(t.src)).rejects.toMatchObject({ code: 'refused' });
  });

  describe('updating and rolling back', () => {
    const installed = async () => {
      const t = await set();
      const p = await t.manager.preview(t.src);
      await t.manager.install(
        { previewId: p.previewId, manifestDigest: p.manifestDigest, consent },
        admin,
      );
      return { ...t, first: p };
    };
    /** The agents' repository moves on, and the pack asks for the new agents at a new version. */
    const advance = async (t: Awaited<ReturnType<typeof installed>>) => {
      await t.agents.commit(
        {
          'agents/writer/config.json': agentConfig('writer', { claude: { model: 'claude-next' } }),
          'agents/planner/config.json': agentConfig('planner', {
            mcp: {
              svc: {
                type: 'http',
                url: 'https://svc.example/mcp',
                headers: { Authorization: 'Bearer ${SVC_TOKEN}' },
              },
              crm: { type: 'http', url: 'https://crm.example/mcp' },
            },
          }),
        },
        'agents move on',
      );
      await t.packs.commit({ 'notes/krama-pack.yaml': packText(t.agents.url, '0.2.0') }, 'v0.2.0');
      await t.packs.tag('v0.2.0');
    };

    it('shows what an update would change, installs it only on that digest, and keeps the old version', async () => {
      const t = await installed();
      await advance(t);
      const up = await t.manager.previewUpdate('pack_notes', { ref: 'v0.2.0' });
      expect(up.diff!.changed).toEqual(
        expect.arrayContaining([{ path: 'version', summary: '0.1.0 to 0.2.0' }]),
      );
      expect(up.diff!.permissionChanges.map((x) => x.subject).sort()).toEqual([
        'crm',
        'crm.example',
      ]);
      // Installed is still the old one until someone says so.
      expect((await t.manager.get('pack_notes'))!.version).toBe('0.1.0');

      await expect(
        t.manager.update(
          'pack_notes',
          { previewId: up.previewId, manifestDigest: '0'.repeat(64), consent },
          admin,
        ),
      ).rejects.toMatchObject({ code: 'conflict' });
      const pack = await t.manager.update(
        'pack_notes',
        {
          previewId: up.previewId,
          manifestDigest: up.manifestDigest,
          consent: { granted: ['mcp_server:crm:planner'], declined: [] },
        },
        admin,
      );
      expect(pack).toMatchObject({ version: '0.2.0', source: { ref: 'v0.2.0', sha: up.sha } });
      expect((await t.manager.versions('pack_notes')).map((v) => [v.version, v.action])).toEqual([
        ['0.2.0', 'update'],
        ['0.1.0', 'install'],
      ]);
      expect(t.audit.map((a) => a.kind)).toEqual(['pack.installed', 'pack.updated']);
    });

    it('serves the version a run started with after the pack has moved on', async () => {
      const t = await installed();
      await advance(t);
      const up = await t.manager.previewUpdate('pack_notes', { ref: 'v0.2.0' });
      await t.manager.update(
        'pack_notes',
        { previewId: up.previewId, manifestDigest: up.manifestDigest, consent },
        admin,
      );
      expect((await t.manager.get('pack_notes'))!.version).toBe('0.2.0');
      const old = await t.manager.get('pack_notes', t.first.sha);
      expect(old).toMatchObject({ version: '0.1.0', source: { sha: t.first.sha, ref: 'v0.1.0' } });
      expect((await t.manager.get('pack_notes', up.sha))!.version).toBe('0.2.0');
      // A commit this pack was never installed at is not served, rather than answered with the current version.
      expect(await t.manager.get('pack_notes', 'deadbeef')).toBeUndefined();
    });

    it('rolls back to the version before, with its agents exactly as they were', async () => {
      const t = await installed();
      await advance(t);
      const up = await t.manager.previewUpdate('pack_notes', { ref: 'v0.2.0' });
      await t.manager.update(
        'pack_notes',
        { previewId: up.previewId, manifestDigest: up.manifestDigest, consent },
        admin,
      );
      const nowSha = (await t.manager.get('pack_notes'))!.source.sha;

      const back = await t.manager.rollback('pack_notes', t.first.sha, admin);
      expect(back).toMatchObject({ version: '0.1.0', source: { sha: t.first.sha } });
      expect(back.source.sha).not.toBe(nowSha);
      // The agents come back at the commit the first version used, not at the repository's newer one.
      const lock = Object.values(await t.manager['o'].sources.lockfile());
      const writer = lock.find((l) => l.path === 'agents/writer')!;
      expect(writer.sha).toBe(
        (await t.manager.versions('pack_notes'))
          .find((v) => v.action === 'install')!
          .locks.find((l) => l.path === 'agents/writer')!.sha,
      );
      // Loaded fresh, by the commit it was put back to: the manifest and the agents are the first version's.
      expect(await t.manager.manifest('pack_notes')).toMatchObject({ version: '0.1.0' });
      expect((await t.manager.get('pack_notes'))!.source.ref).toBe('v0.1.0');
      expect((await t.manager.versions('pack_notes')).map((v) => v.action)).toEqual([
        'rollback',
        'update',
        'install',
      ]);
      await expect(t.manager.rollback('pack_notes', t.first.sha, admin)).rejects.toMatchObject({
        code: 'conflict',
      });
      await expect(t.manager.rollback('pack_notes', 'deadbeef', admin)).rejects.toMatchObject({
        code: 'not_found',
      });
    });

    it('leaves the pins alone when an install is refused because the source changed after the preview', async () => {
      const t = await set();
      const p = await t.manager.preview(t.src);
      // Between the preview and the install, the agents' branch moves.
      await t.agents.commit(
        { 'agents/writer/config.json': agentConfig('writer', { claude: { model: 'sneaky' } }) },
        'moved',
      );
      const before = await t.manager['o'].sources.lockfile();
      await expect(
        t.manager.install(
          { previewId: p.previewId, manifestDigest: p.manifestDigest, consent },
          admin,
        ),
      ).rejects.toMatchObject({ code: 'conflict' });
      expect(await t.manager['o'].sources.lockfile()).toEqual(before);
      expect(await t.manager.list()).toEqual([]);
    });
  });

  it('disables, enables and uninstalls', async () => {
    const t = await set();
    const p = await t.manager.preview(t.src);
    await t.manager.install(
      { previewId: p.previewId, manifestDigest: p.manifestDigest, consent },
      admin,
    );
    expect((await t.manager.setEnabled('pack_notes', false, admin)).status).toBe('disabled');
    expect((await t.manager.get('pack_notes'))!.status).toBe('disabled');
    expect((await t.manager.setEnabled('pack_notes', true, admin)).status).toBe('installed');
    await t.manager.uninstall('pack_notes', admin);
    expect(await t.manager.get('pack_notes')).toBeUndefined();
    await expect(t.manager.uninstall('pack_notes', admin)).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(t.audit.map((a) => a.kind)).toEqual([
      'pack.installed',
      'pack.disabled',
      'pack.enabled',
      'pack.uninstalled',
    ]);
  });

  it('serves the packs that ship with this build next to the installed ones, and will not install over one', async () => {
    const t = await set();
    const builtin = { id: 'pack_notes', name: 'notes', version: '9.9.9' } as unknown as Pack;
    const m = await t.open({ builtin: [builtin] });
    expect((await m.list()).map((p) => p.id)).toEqual(['pack_notes']);
    expect((await m.get('pack_notes'))!.version).toBe('9.9.9');
    const p = await m.preview(t.src);
    await expect(
      m.install({ previewId: p.previewId, manifestDigest: p.manifestDigest, consent }, admin),
    ).rejects.toMatchObject({ code: 'conflict' });
  });
});
