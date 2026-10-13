import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BackendRegistry } from '@kramahq/agents';
import {
  API_BASE_PATH,
  operation,
  pack as packSchema,
  packPreview,
  type Operation,
  type Pack,
} from '@kramahq/contract';
import { Git } from '@kramahq/git';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApi, createKrama, loadConfig, type Krama } from '../src/index.js';

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
const slash = (p: string): string => p.replace(/\\/g, '/');
const TOKEN = 'test-token-0123456789abcdef';
const auth = { authorization: `Bearer ${TOKEN}` };
const V1 = API_BASE_PATH;

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'krama packs api '));
  dirs.push(d);
  return d;
};

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
      await git.run(['push', '-q', url, 'main'], { cwd: work });
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
    claude: { model: 'm' },
    ...extra,
  });
const packText = (agentsUrl: string, version: string, engine = '>=0.1.0') => `
name: notes
version: ${version}
description: Notes from agents in another repository.
engine: "${engine}"
orchestrator: planner
agents:
  planner:
    git: "${slash(agentsUrl)}@main#agents/planner"
    secrets: { SVC_TOKEN: notes-token }
    subAgents: [ { agent: writer, hint: Writes. } ]
  writer:
    git: "${slash(agentsUrl)}@main#agents/writer"
`;

let home: string;
let krama: Krama;
let agents: Awaited<ReturnType<typeof remote>>;
let packs: Awaited<ReturnType<typeof remote>>;
const apps: Record<string, FastifyInstance> = {};

const as = async (name: string, roles: string[]) => {
  const config = loadConfig({ argv: ['--home', home, '--token', TOKEN, '--port', '0'], env: {} });
  apps[name] = await buildApi({
    krama,
    config,
    validateResponses: true,
    autoStartRuns: false,
    principal: { id: `u_${name}`, name, roles, permissions: [] },
  });
  await apps[name]!.ready();
};

beforeAll(async () => {
  if (!hasGit) return;
  agents = await remote();
  packs = await remote();
  await agents.commit({
    'agents/planner/config.json': agentConfig('planner'),
    'agents/writer/config.json': agentConfig('writer'),
  });
  await packs.commit({ 'notes/krama-pack.yaml': packText(agents.url, '0.1.0') });
  await packs.tag('v0.1.0');
  home = tmp();
  krama = await createKrama({
    home,
    packs: [],
    definitions: [],
    backends: BackendRegistry.withBuiltins(),
    engineVersion: '0.3.0',
    sources: { git },
  });
  await as('admin', ['admin']);
  await as('author', ['author']);
  await as('viewer', ['viewer']);
}, 60_000);

afterAll(async () => {
  for (const a of Object.values(apps)) await a.close();
  await krama?.close();
  dirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
});

const call = (
  who: string,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) =>
  apps[who]!.inject({
    method,
    url: `${V1}${path}`,
    headers: { ...auth, ...headers },
    ...(body !== undefined ? { payload: body as object } : {}),
  });

/** Starts an operation and waits for it to finish. */
async function finished(
  who: string,
  res: { statusCode: number; json(): unknown },
): Promise<Operation> {
  expect(res.statusCode).toBe(202);
  const op = operation.parse(res.json());
  for (let i = 0; i < 400; i++) {
    const cur = operation.parse((await call(who, 'GET', `/operations/${op.id}`)).json());
    if (cur.status === 'succeeded' || cur.status === 'failed') return cur;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('the operation did not finish');
}
const preview = async (who: string, source: object) =>
  finished(who, await call(who, 'POST', '/packs/preview', { source }));
const src = () => ({ url: packs.url, ref: 'v0.1.0', path: 'notes' });
const consent = { granted: [], declined: [] };

describe.skipIf(!hasGit)('the pack routes', { timeout: 120_000 }, () => {
  it('previews as an operation, installs against that digest once, and then lists, shows and describes the pack', async () => {
    const op = await preview('admin', src());
    expect(op).toMatchObject({ status: 'succeeded', type: 'pack.preview' });
    const p = packPreview.parse(op.result);
    expect(p.manifest).toMatchObject({ id: 'pack_notes', status: 'available' });
    expect(p.permissions.some((x) => x.kind === 'secret_ref')).toBe(true);
    expect((await call('admin', 'GET', '/packs')).json()).toMatchObject({ items: [] });

    const bad = await call(
      'admin',
      'POST',
      '/packs',
      { previewId: p.previewId, manifestDigest: '0'.repeat(64), consent },
      { 'idempotency-key': 'k-bad' },
    );
    expect(bad.statusCode).toBe(409);
    expect(bad.json()).toMatchObject({ code: 'conflict' });

    const body = {
      previewId: p.previewId,
      manifestDigest: p.manifestDigest,
      consent: { granted: p.permissions.map((x) => x.id), declined: [] },
    };
    const done = await call('admin', 'POST', '/packs', body, { 'idempotency-key': 'k-install' });
    expect(done.statusCode).toBe(201);
    const installed = packSchema.parse(done.json());
    expect(installed).toMatchObject({
      id: 'pack_notes',
      status: 'installed',
      source: { sha: p.sha },
      trust: 'untrusted',
    });
    // The same request again is the same answer, not a second install and not a conflict.
    const again = await call('admin', 'POST', '/packs', body, { 'idempotency-key': 'k-install' });
    expect(again.statusCode).toBe(201);
    expect(again.json()).toEqual(done.json());

    expect(
      ((await call('viewer', 'GET', '/packs')).json() as { items: Pack[] }).items.map((x) => x.id),
    ).toEqual(['pack_notes']);
    expect((await call('viewer', 'GET', '/packs/pack_notes')).json()).toMatchObject({
      version: '0.1.0',
    });
    expect((await call('viewer', 'GET', '/packs/pack_notes/manifest')).json()).toMatchObject({
      name: 'notes',
      orchestrator: 'planner',
    });
    expect(
      (
        (await call('viewer', 'GET', '/packs/pack_notes/versions')).json() as {
          items: { current: boolean; action: string }[];
        }
      ).items,
    ).toEqual([expect.objectContaining({ version: '0.1.0', action: 'install', current: true })]);
  });

  it('refuses what it should, each with its own problem', async () => {
    // Not found, a pack that does not validate, one that needs a newer Krama, a source nobody allowed.
    expect((await call('admin', 'GET', '/packs/pack_nope')).statusCode).toBe(404);
    expect((await call('admin', 'POST', '/packs/pack_nope/disable')).statusCode).toBe(404);

    await packs.commit({
      'bad/krama-pack.yaml': packText(agents.url, '0.1.0').replace(
        'orchestrator: planner',
        'orchestrator: nobody',
      ),
    });
    const bad = packPreview.parse(
      (await preview('admin', { url: packs.url, ref: 'main', path: 'bad' })).result,
    );
    const res = await call(
      'admin',
      'POST',
      '/packs',
      { previewId: bad.previewId, manifestDigest: bad.manifestDigest, consent },
      { 'idempotency-key': 'k-invalid' },
    );
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({
      code: 'validation_failed',
      errors: [expect.objectContaining({ field: expect.stringContaining('orchestrator') })],
    });

    await packs.commit({
      'future/krama-pack.yaml': packText(agents.url, '0.1.0', '>=9.0.0').replace(
        'name: notes',
        'name: future',
      ),
    });
    const future = packPreview.parse(
      (await preview('admin', { url: packs.url, ref: 'main', path: 'future' })).result,
    );
    expect(future.engineCompatible).toBe(false);
    const inc = await call(
      'admin',
      'POST',
      '/packs',
      { previewId: future.previewId, manifestDigest: future.manifestDigest, consent },
      { 'idempotency-key': 'k-future' },
    );
    expect(inc.statusCode).toBe(409);
    expect(inc.json()).toMatchObject({ code: 'engine_incompatible' });

    // A source that cannot be found fails the operation with a problem, not a 500.
    const missing = await preview('admin', { url: join(tmp(), 'nope.git'), ref: 'main' });
    expect(missing.status).toBe('failed');
    expect(missing.error).toMatchObject({ code: 'validation_failed' });
  });

  it('keeps the roles apart: an author may preview, only an admin installs, a viewer does neither', async () => {
    expect((await call('viewer', 'POST', '/packs/preview', { source: src() })).statusCode).toBe(
      403,
    );
    const p = packPreview.parse((await preview('author', src())).result);
    const asAuthor = await call(
      'author',
      'POST',
      '/packs',
      { previewId: p.previewId, manifestDigest: p.manifestDigest, consent },
      { 'idempotency-key': 'k-author' },
    );
    expect(asAuthor.statusCode).toBe(403);
    for (const [m, path] of [
      ['POST', '/packs/pack_notes/disable'],
      ['POST', '/packs/pack_notes/rollback'],
      ['DELETE', '/packs/pack_notes'],
    ] as const)
      expect(
        (
          await call(
            'author',
            m,
            path,
            m === 'POST' && path.endsWith('rollback') ? { sha: 'x' } : undefined,
          )
        ).statusCode,
        path,
      ).toBe(403);
  });

  it('updates with a diff, rolls back, disables, enables and uninstalls, and every step is on the audit record', async () => {
    await agents.commit(
      { 'agents/writer/config.json': agentConfig('writer', { claude: { model: 'next' } }) },
      'writer moves on',
    );
    await packs.commit({ 'notes/krama-pack.yaml': packText(agents.url, '0.2.0') });
    await packs.tag('v0.2.0');

    const upOp = await finished(
      'admin',
      await call('admin', 'POST', '/packs/pack_notes/update/preview', { ref: 'v0.2.0' }),
    );
    expect(upOp.status).toBe('succeeded');
    const up = packPreview.parse(upOp.result);
    expect(up.diff!.changed).toEqual(
      expect.arrayContaining([{ path: 'version', summary: '0.1.0 to 0.2.0' }]),
    );
    const updated = await call('admin', 'POST', '/packs/pack_notes/update', {
      previewId: up.previewId,
      manifestDigest: up.manifestDigest,
      consent,
    });
    expect(updated.json()).toMatchObject({ version: '0.2.0' });
    const first = (
      (await call('admin', 'GET', '/packs/pack_notes/versions')).json() as {
        items: { sha: string; action: string }[];
      }
    ).items.find((v) => v.action === 'install')!;

    expect(
      (await call('admin', 'POST', '/packs/pack_notes/rollback', { sha: first.sha })).json(),
    ).toMatchObject({ version: '0.1.0' });
    expect(
      (await call('admin', 'POST', '/packs/pack_notes/rollback', { sha: first.sha })).statusCode,
    ).toBe(409);
    expect(
      (await call('admin', 'POST', '/packs/pack_notes/rollback', { sha: 'deadbeef' })).statusCode,
    ).toBe(404);
    expect((await call('admin', 'POST', '/packs/pack_notes/disable')).json()).toMatchObject({
      status: 'disabled',
    });
    expect((await call('admin', 'POST', '/packs/pack_notes/enable')).json()).toMatchObject({
      status: 'installed',
    });
    expect((await call('admin', 'DELETE', '/packs/pack_notes')).statusCode).toBe(204);
    expect((await call('admin', 'GET', '/packs/pack_notes')).statusCode).toBe(404);

    const trail = (
      (await call('admin', 'GET', '/audit?action=pack&limit=50')).json() as {
        items: { action: string; actor: { id: string }; subject: { id: string } }[];
      }
    ).items;
    expect(
      trail
        .filter((e) => e.subject.id === 'pack_notes')
        .map((e) => e.action)
        .reverse(),
    ).toEqual([
      'pack.installed',
      'pack.updated',
      'pack.rolled_back',
      'pack.disabled',
      'pack.enabled',
      'pack.uninstalled',
    ]);
    expect(trail.find((e) => e.action === 'pack.updated')!.actor.id).toBe('u_admin');
  });

  describe('browsing an installed pack', () => {
    const install = async () => {
      const p = packPreview.parse((await preview('admin', src())).result);
      await call(
        'admin',
        'POST',
        '/packs',
        { previewId: p.previewId, manifestDigest: p.manifestDigest, consent },
        { 'idempotency-key': `k-files-${Math.random()}` },
      );
    };

    it('lists a directory and reads a file, read-only', async () => {
      await install();
      const root = (await call('viewer', 'GET', '/packs/pack_notes/files')).json() as {
        entries: { name: string; type: string }[];
      };
      expect(root.entries).toEqual([
        { name: 'krama-pack.yaml', type: 'file', size: expect.any(Number) },
      ]);
      const file = (
        await call('viewer', 'GET', '/packs/pack_notes/files?path=krama-pack.yaml')
      ).json() as { content: string; type: string };
      expect(file.type).toBe('file');
      expect(file.content).toContain('name: notes');
      expect(
        (await call('viewer', 'GET', '/packs/pack_notes/files?path=missing.md')).statusCode,
      ).toBe(404);
    });

    it('will not leave the pack: parent paths, absolute paths and a link out are refused', async () => {
      for (const path of ['../', '..%2F..%2Fetc', '/etc/passwd', 'C:%5CWindows']) {
        const res = await call('viewer', 'GET', `/packs/pack_notes/files?path=${path}`);
        expect([404, 422], path).toContain(res.statusCode);
      }
      if (process.platform !== 'win32') {
        const outside = tmp();
        writeFileSync(join(outside, 'secret.txt'), 'outside the pack');
        const link = await remote();
        await link.commit({
          'p/krama-pack.yaml': packText(agents.url, '0.3.0').replace('name: notes', 'name: linked'),
        });
        symlinkSync(outside, join(link.work, 'p', 'escape'));
        await git.run(['add', '-A'], { cwd: link.work });
        await git.run(['commit', '-q', '-m', 'a link'], { cwd: link.work, env: id });
        await git.run(['push', '-q', link.url, 'main'], { cwd: link.work });
        const p = packPreview.parse(
          (await preview('admin', { url: link.url, ref: 'main', path: 'p' })).result,
        );
        await call(
          'admin',
          'POST',
          '/packs',
          { previewId: p.previewId, manifestDigest: p.manifestDigest, consent },
          { 'idempotency-key': 'k-link' },
        );
        const listed = (await call('viewer', 'GET', '/packs/pack_linked/files')).json() as {
          entries: { name: string; type: string }[];
        };
        expect(listed.entries.find((e) => e.name === 'escape')).toMatchObject({ type: 'link' });
        const read = await call('viewer', 'GET', '/packs/pack_linked/files?path=escape/secret.txt');
        expect(read.statusCode).toBe(422);
        expect(JSON.stringify(read.json())).not.toContain('outside the pack"');
      }
    });
  });
});
