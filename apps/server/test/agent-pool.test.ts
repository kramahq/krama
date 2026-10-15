import { rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { BackendRegistry, validateOptions } from '@kramahq/agents';
import { agentPreview, agentDefinition, type AgentPreview } from '@kramahq/contract';
import { Sources } from '@kramahq/git';
import { afterAll, describe, expect, it } from 'vitest';
import { AgentPool, type AgentPoolOptions } from '../src/agents/pool.js';
import { admin, agentConfig, cleanup, git, hasGit, remote, tmp } from './agent-pool-fixture.js';
const all = (p: AgentPreview) => ({
  previewId: p.previewId,
  manifestDigest: p.manifestDigest,
  consent: { granted: p.permissions.map((p) => p.id), declined: [] as string[] },
});
const empty = { granted: [] as string[], declined: [] as string[] };
const set = async (over: Partial<AgentPoolOptions> = {}) => {
  const remoteRepo = await remote();
  const first = await remoteRepo.commit({
    'reviewer/config.json': agentConfig('reviewer', {
      memory: { instructions: 'instructions.md' },
      mcp: {
        svc: {
          type: 'http',
          url: 'https://svc.example/mcp',
          headers: { Authorization: 'Bearer ${SVC_TOKEN}' },
        },
      },
      subAgents: {
        agents: [
          { name: 'peer', agentCardUrl: 'https://peer.example/.well-known/agent-card.json' },
        ],
      },
    }),
    'reviewer/instructions.md': 'Review carefully.',
  });
  const home = tmp();
  const sources = await Sources.open({ root: join(home, 'sources'), git });
  const audit: { kind: string; actor: string }[] = [];
  const options: AgentPoolOptions = {
    dir: join(home, 'pool'),
    sources,
    backends: BackendRegistry.withBuiltins(),
    secrets: { resolve: async () => 'bound-value' },
    checkProviderConfig: (d, s) => validateOptions(d, s, { workspaceProvided: true }),
    audit: async (kind, actor) => {
      audit.push({ kind, actor: actor.id });
    },
    ...over,
  };
  const pool = await AgentPool.open(options);
  const request = {
    id: 'reviewer/default',
    source: { url: remoteRepo.url, ref: 'main', path: 'reviewer' },
    secrets: { SVC_TOKEN: 'svc-token' },
  };
  const preview = () => pool.preview(request);
  return { pool, options, sources, remoteRepo, first, request, preview, home, audit };
};

describe.skipIf(!hasGit)('standalone Git agents', { timeout: 120_000 }, () => {
  it('previews the backend, tools, secret references and declared peers without installing or pinning', async () => {
    const s = await set();
    const p = agentPreview.parse(await s.preview());
    expect(p.definition).toMatchObject({
      id: 'reviewer/default',
      backend: { wrapper: 'a2a-claude' },
      capabilities: ['reviewer'],
      source: { type: 'git', sha: s.first },
    });
    expect(p.permissions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'mcp_server', subject: 'svc' }),
        expect.objectContaining({ kind: 'secret_ref', subject: 'svc-token' }),
        expect.objectContaining({ id: `source:${s.remoteRepo.url}` }),
      ]),
    );
    expect(p.secretsToBind).toEqual([
      { ref: 'svc-token', description: expect.any(String), bound: true },
    ]);
    expect(p.declaredSubAgents).toEqual([
      { name: 'peer', agentCardUrl: 'https://peer.example/.well-known/agent-card.json' },
    ]);
    expect(p.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'config.subAgents', severity: 'warn' }),
      ]),
    );
    expect(s.pool.list()).toEqual([]);
    expect(await s.sources.snapshot()).toEqual({});
    expect(JSON.stringify(p)).not.toContain('bound-value');
  });

  it('installs once at the reviewed commit, resolves file paths and returns copies of catalogue data', async () => {
    const s = await set();
    const p = await s.preview();
    const def = agentDefinition.parse(await s.pool.install(all(p), admin));
    expect(s.pool.list()).toEqual([def]);
    const config = s.pool.config(def)!.json;
    expect(config.claude).toMatchObject({ model: 'claude-sonnet-5-5' });
    const instruction = (config.memory as { instructions: string }).instructions;
    expect(isAbsolute(instruction)).toBe(true);
    expect(await readFile(instruction, 'utf8')).toBe('Review carefully.');
    expect(await readFile(join(s.home, 'pool', 'registry.json'), 'utf8')).not.toContain(
      'bound-value',
    );
    s.pool.list()[0]!.name = 'changed';
    expect(s.pool.get(def.id)!.name).toBe('reviewer');
    const duplicate = await s.preview();
    await expect(s.pool.install(all(duplicate), admin)).rejects.toMatchObject({ code: 'conflict' });
    expect(s.audit).toEqual([{ kind: 'agent_definition.installed', actor: 'u_admin' }]);
  });

  it('refuses incomplete or declined consent, mismatched digests and expired previews without consuming them', async () => {
    let now = 0;
    const s = await set({ now: () => new Date(now), previewTtlMs: 100 });
    const p = await s.preview();
    await expect(
      s.pool.install({ ...all(p), manifestDigest: 'wrong' }, admin),
    ).rejects.toMatchObject({ code: 'conflict' });
    await expect(s.pool.install({ ...all(p), consent: empty }, admin)).rejects.toMatchObject({
      code: 'invalid',
    });
    await expect(
      s.pool.install(
        { ...all(p), consent: { granted: [], declined: [p.permissions[0]!.id] } },
        admin,
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      s.pool.install({ ...all(p), consent: { granted: ['invented'], declined: [] } }, admin),
    ).rejects.toMatchObject({ code: 'invalid' });
    expect(await s.sources.snapshot()).toEqual({});
    now = 100;
    await expect(s.pool.install(all(p), admin)).rejects.toMatchObject({ code: 'conflict' });
    const fresh = await s.preview();
    expect((await s.pool.install(all(fresh), admin)).id).toBe(s.request.id);
  });

  it('refuses a source that moved after preview, leaving installed definitions and existing pins alone', async () => {
    const s = await set();
    await s.sources.resolve(s.request.source);
    const snapshot = await s.sources.snapshot();
    const p = await s.preview();
    await s.remoteRepo.commit({ 'reviewer/instructions.md': 'New instructions.' });
    await expect(s.pool.install(all(p), admin)).rejects.toMatchObject({ code: 'conflict' });
    expect(s.pool.list()).toEqual([]);
    expect(await s.sources.snapshot()).toEqual(snapshot);
  });

  it('updates with a permission diff, rejects stale update previews, and rolls back offline without moving a pack pin', async () => {
    const s = await set();
    await s.sources.resolve(s.request.source); // A pack may already pin this same ref.
    const packPin = await s.sources.pinned([s.request.source]);
    const p = await s.preview();
    await s.pool.install(all(p), admin);
    await s.remoteRepo.commit({
      'reviewer/config.json': agentConfig('reviewer', {
        claude: { model: 'next' },
        mcp: { svc: { type: 'http', url: 'https://new.example/mcp' } },
      }),
    });
    await s.remoteRepo.tag('v2');
    const update = await s.pool.previewUpdate(s.request.id, { ref: 'v2' });
    expect(update.diff!.changed).not.toEqual([]);
    expect(update.diff!.permissionChanges).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'mcp_server', subject: 'svc' })]),
    );
    await expect(
      s.pool.update(s.request.id, { ...all(update), consent: empty }, admin),
    ).rejects.toMatchObject({ code: 'invalid' });
    expect((await s.pool.update(s.request.id, all(update), admin)).backend.model).toBe('next');
    await expect(s.pool.update(s.request.id, all(update), admin)).rejects.toMatchObject({
      code: 'conflict',
    });
    expect(await s.sources.pinned([s.request.source])).toEqual(packPin);
    rmSync(s.remoteRepo.url, { recursive: true });
    const reopened = await AgentPool.open(s.options);
    expect(reopened.get(s.request.id)!.backend.model).toBe('next');
    expect(reopened.versions(s.request.id)[0]!.current).toBe(true);
    expect((await reopened.rollback(s.request.id, s.first, admin)).backend.model).toBe(
      'claude-sonnet-5-5',
    );
    expect(reopened.versions(s.request.id).map((v) => v.action)).toEqual([
      'rollback',
      'update',
      'install',
    ]);
    expect(await s.sources.pinned([s.request.source])).toEqual(packPin);
    expect(s.audit.map((a) => a.kind)).toEqual([
      'agent_definition.installed',
      'agent_definition.updated',
      'agent_definition.rolled_back',
    ]);
    const again = await AgentPool.open(s.options);
    expect(again.get(s.request.id)!.source.sha).toBe(s.first);
    await again.uninstall(s.request.id, admin);
    expect((await AgentPool.open(s.options)).list()).toEqual([]);
  });

  it('blocks changing or removing an agent while a run may use it', async () => {
    const s = await set({ inUse: async () => true });
    await s.pool.install(all(await s.preview()), admin);
    await s.remoteRepo.commit({ 'reviewer/instructions.md': 'Next' });
    const update = await s.pool.previewUpdate(s.request.id);
    await expect(s.pool.update(s.request.id, all(update), admin)).rejects.toMatchObject({
      code: 'conflict',
    });
    await expect(s.pool.rollback(s.request.id, s.first, admin)).rejects.toMatchObject({
      code: 'conflict',
    });
    await expect(s.pool.uninstall(s.request.id, admin)).rejects.toMatchObject({ code: 'conflict' });
  });

  it('does not overwrite a built-in definition, and serializes competing installs', async () => {
    const s = await set();
    const p = await s.preview();
    const builtInPool = await AgentPool.open({
      ...s.options,
      dir: join(s.home, 'other'),
      builtin: [p.definition!],
    });
    const bp = await builtInPool.preview(s.request);
    await expect(builtInPool.install(all(bp), admin)).rejects.toMatchObject({ code: 'conflict' });
    const outcomes = await Promise.allSettled([
      s.pool.install(all(p), admin),
      s.pool.install(all(p), admin),
    ]);
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    expect((await AgentPool.open(s.options)).list()).toHaveLength(1);
  });

  it('checks backend policy, JSON and variables, accepts config.json paths, and rejects traversal', async () => {
    const s = await set({ allowedBackends: ['a2a-codex'] });
    const bad = await s.preview();
    expect(bad.definition).toBeUndefined();
    expect(bad.issues.some((i) => i.message.includes('not an allowed backend'))).toBe(true);
    await expect(s.pool.install(all(bad), admin)).rejects.toMatchObject({ code: 'invalid' });
    const normal = await AgentPool.open({ ...s.options, allowedBackends: [] });
    const file = await normal.preview({
      ...s.request,
      source: { ...s.request.source, path: 'reviewer/config.json' },
    });
    expect(file.definition!.backend.wrapper).toBe('a2a-claude');
    for (const path of ['../outside', '/etc', 'C:\\Windows', 'reviewer/../other'])
      await expect(
        normal.preview({ ...s.request, source: { ...s.request.source, path } }),
      ).rejects.toThrow();
    await s.remoteRepo.commit({ 'reviewer/config.json': '{broken' });
    const invalid = await normal.preview(s.request);
    expect(invalid.definition).toBeUndefined();
    expect(invalid.issues[0]!.path).toBe('config.json');
    await s.remoteRepo.commit({
      'reviewer/config.json': agentConfig('reviewer', {
        mcp: { svc: { command: 'tool', env: { TOKEN: '${MISSING}' } } },
      }),
    });
    expect(
      (await normal.preview(s.request)).issues.some((i) => i.message.includes('MISSING')),
    ).toBe(true);
  });
  it('does not publish a catalogue change when its audit write fails', async () => {
    const s = await set({
      audit: async () => {
        throw new Error('audit unavailable');
      },
    });
    const p = await s.preview();
    await expect(s.pool.install(all(p), admin)).rejects.toThrow('audit unavailable');
    expect(s.pool.list()).toEqual([]);
    expect((await AgentPool.open(s.options)).list()).toEqual([]);
  });
  it('reviews new secret bindings and can restore the exact earlier consent at the same commit', async () => {
    const s = await set({ trusted: ['*'] });
    const first = await s.preview();
    expect(first.trust).toBe('trusted');
    expect(first.permissions.some((p) => p.requestedBy === 'source')).toBe(false);
    await s.pool.install(all(first), admin);
    const update = await s.pool.previewUpdate(s.request.id, {
      secrets: { SVC_TOKEN: 'new-reference' },
    });
    expect(update.sha).toBe(first.sha);
    expect(update.diff!.permissionChanges).toEqual(
      expect.arrayContaining([expect.objectContaining({ subject: 'new-reference' })]),
    );
    await s.pool.update(s.request.id, all(update), admin);
    expect(s.pool.get(s.request.id)!.backend.secrets).toEqual({ SVC_TOKEN: 'new-reference' });
    await s.pool.rollback(s.request.id, s.first, admin, first.manifestDigest);
    const reopened = await AgentPool.open(s.options);
    expect(reopened.get(s.request.id)!.backend.secrets).toEqual(s.request.secrets);
    expect((await reopened.previewUpdate(s.request.id)).secretsToBind.map((s) => s.ref)).toEqual([
      'svc-token',
    ]);
    const def = reopened.get(s.request.id)!;
    const changedModel = { ...def, backend: { ...def.backend, model: 'override' } };
    expect(reopened.config(changedModel)!.json.claude).toMatchObject({ model: 'override' });
    expect(reopened.config(def)!.json.claude).toMatchObject({ model: 'claude-sonnet-5-5' });
    expect(reopened.config(def)!.json.subAgents).toEqual({ enabled: false, agents: [] });
    expect(() =>
      reopened.config({ ...def, backend: { ...def.backend, wrapper: 'a2a-codex' } }),
    ).toThrow('backend');
  });
});

afterAll(cleanup);
