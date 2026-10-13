import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pack as packSchema, type BackendDescriptor } from '@kramahq/contract';
import { afterAll, describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';
import {
  diffLoads,
  engineCompatible,
  loadPackText,
  permissionSurface,
  secretRefs,
  toPack,
  type PackLoadEnv,
} from '../src/index.js';

const descriptor = (id: string, providerKey: string, options: object[] = []): BackendDescriptor =>
  ({
    id,
    providerKey,
    env: [],
    options,
    capabilities: {
      canOrchestrate: true,
      cost: 'reported',
      sideband: true,
      resumableSessions: true,
    },
  }) as unknown as BackendDescriptor;
const BACKENDS = [
  descriptor('a2a-claude', 'claude'),
  descriptor('a2a-codex', 'codex', [
    { key: 'sandboxMode', type: 'enum', default: 'workspace-write', risk: 'high' },
    { key: 'model', type: 'string' },
  ]),
];
const catalog = { list: () => BACKENDS, get: (id: string) => BACKENDS.find((b) => b.id === id) };
const env: PackLoadEnv = { backends: catalog };

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

type Doc = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const BASE = `
name: release-notes
version: 0.1.0
description: Drafts release notes.
engine: ">=0.1.0"
tags: [writing]
orchestrator: planner
memoryScopes: [ { scope: project, access: read } ]
agents:
  planner:
    config:
      agentCard: { name: planner, description: Plans }
      claude: { model: m }
      mcp:
        tracker: { type: http, url: "https://tracker.example/mcp", headers: { Authorization: "Bearer \${TRACKER_TOKEN}" } }
        local: { type: stdio, command: node, args: [server.js] }
    secrets: { TRACKER_TOKEN: tracker-token }
    subAgents: [ { agent: author, hint: Writes } ]
  author:
    config:
      agentCard:
        name: author
        description: Writes
        skills: [ { id: write, name: Write, description: Writes notes } ]
      codex: { model: gpt, sandboxMode: danger-full-access }
`;
const load = (f?: (d: Doc) => void, baseDir?: string) => {
  const d = parse(BASE) as Doc;
  f?.(d);
  return loadPackText(stringify(d), baseDir, env);
};
const info = (over: object = {}) => ({
  source: {
    url: 'github.com/acme/packs',
    ref: 'v0.1.0',
    sha: 'a'.repeat(40),
    path: 'release-notes',
  },
  trust: 'untrusted' as const,
  status: 'installed' as const,
  permissions: [],
  engineVersion: '0.3.0',
  ...over,
});

describe('a loaded pack as the catalogue shows it', () => {
  it('is a valid contract Pack with its agents, source, requirements and engine compatibility', async () => {
    const l = await load();
    expect(l.ok).toBe(true);
    const p = toPack(
      l,
      info({
        installedAt: '2026-10-13T00:00:00.000Z',
        permissions: await permissionSurface(l, catalog),
      }),
    );
    expect(packSchema.parse(p)).toBeTruthy();
    expect(p).toMatchObject({
      id: 'pack_release-notes',
      version: '0.1.0',
      tags: ['writing'],
      orchestrator: 'planner',
      status: 'installed',
      trust: 'untrusted',
      source: { type: 'git', url: 'github.com/acme/packs', ref: 'v0.1.0', path: 'release-notes' },
      engine: { requires: '>=0.1.0', compatible: true },
      requirements: {
        secrets: ['tracker-token'],
        mcpServers: expect.arrayContaining(['tracker', 'local']),
      },
      installedAt: '2026-10-13T00:00:00.000Z',
    });
    expect(p.methodology).toBeUndefined();
    expect(p.agents!['author']!.config).toBeDefined();
    expect(p.agents!['planner']!.subAgents).toEqual([{ agent: 'author', hint: 'Writes' }]);
    expect(() => toPack({ ...l, ok: false }, info())).toThrow(/did not load/);
  });

  it('says whether this Krama fits the pack’s engine range', () => {
    expect(engineCompatible('>=0.1.0', '0.3.0')).toBe(true);
    expect(engineCompatible('^0.3.0', '0.3.5')).toBe(true);
    expect(engineCompatible('>=1.0.0', '0.3.0')).toBe(false);
    expect(engineCompatible(undefined, '0.3.0')).toBe(true);
    expect(engineCompatible('not a range', '0.3.0')).toBe(false);
  });
});

describe('what a person is asked to allow', () => {
  it('lists MCP servers (a process is riskier than a remote one), hosts, secrets, scopes and loosened sandboxes, each with who asks', async () => {
    const l = await load();
    const perms = await permissionSurface(l, catalog);
    const by = (kind: string) => perms.filter((p) => p.kind === kind);
    expect(
      by('mcp_server')
        .map((p) => [p.subject, p.risk, p.requestedBy])
        .sort(),
    ).toEqual([
      ['local', 'high', 'planner'],
      ['tracker', 'medium', 'planner'],
    ]);
    expect(by('network')).toEqual([
      expect.objectContaining({ subject: 'tracker.example', risk: 'low', requestedBy: 'planner' }),
    ]);
    expect(by('secret_ref')).toEqual([
      expect.objectContaining({ subject: 'tracker-token', access: 'as TRACKER_TOKEN' }),
    ]);
    expect(by('memory_scope')).toEqual([
      expect.objectContaining({ subject: 'project', access: 'read' }),
    ]);
    // Only the setting the backend marks risky, and only because it was moved from its default.
    expect(by('workspace')).toEqual([
      expect.objectContaining({
        subject: 'codex.sandboxMode',
        access: 'danger-full-access',
        risk: 'high',
        requestedBy: 'author',
      }),
    ]);
    expect(new Set(perms.map((p) => p.id)).size).toBe(perms.length);
  });

  it('flags an external agent, and plain http as riskier', async () => {
    const add = (url: string) => (d: Doc) => {
      d.agents.vendor = { description: 'v', external: { name: 'vendor', agentCardUrl: url } };
      d.agents.author.subAgents = [{ agent: 'vendor' }];
    };
    const https = await permissionSurface(await load(add('https://v.example/card.json')), catalog);
    const http = await permissionSurface(await load(add('http://v.example/card.json')), catalog);
    expect(https.find((p) => p.subject === 'v.example')).toMatchObject({
      kind: 'network',
      risk: 'medium',
      requestedBy: 'vendor',
    });
    expect(http.find((p) => p.subject === 'v.example')).toMatchObject({ risk: 'high' });
  });

  it('flags a skill that ships scripts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'krama surface '));
    dirs.push(dir);
    mkdirSync(join(dir, 'skills/check/scripts'), { recursive: true });
    writeFileSync(
      join(dir, 'skills/check/SKILL.md'),
      '---\nname: check\ndescription: Checks\n---\n',
    );
    mkdirSync(join(dir, 'skills/plain'), { recursive: true });
    writeFileSync(
      join(dir, 'skills/plain/SKILL.md'),
      '---\nname: plain\ndescription: Plain\n---\n',
    );
    const l = await load(
      (d) => (d.agents.author.config.memory = { skills: ['skills/check', 'skills/plain'] }),
      dir,
    );
    expect(l.ok).toBe(true);
    const scripts = (await permissionSurface(l, catalog)).filter(
      (p) => p.kind === 'script_execution',
    );
    expect(scripts.map((p) => p.subject)).toEqual(['skills/check']);
  });

  it('lists each secret to bind once, with everyone who needs it', async () => {
    const l = await load((d) => (d.agents.author.secrets = { OTHER: 'tracker-token' }));
    expect(secretRefs(l)).toEqual([
      {
        ref: 'tracker-token',
        description: expect.stringMatching(/planner \(TRACKER_TOKEN\).*author \(OTHER\)/),
      },
    ]);
  });
});

describe('what an update would change', () => {
  it('names agents added and removed, config and wiring that changed, the version, and the new permissions only', async () => {
    const before = await load();
    const after = await load((d) => {
      d.version = '0.2.0';
      d.agents.author.config.codex.model = 'gpt-next';
      d.agents.reviewer = { config: { agentCard: { name: 'r', description: 'r' }, claude: {} } };
      d.agents.planner.subAgents = [{ agent: 'author', hint: 'Writes, faster' }];
      d.agents.planner.config.mcp.crm = { type: 'http', url: 'https://crm.example/mcp' };
    });
    const diff = diffLoads(
      before,
      after,
      await permissionSurface(before, catalog),
      await permissionSurface(after, catalog),
    );
    expect(diff.added).toEqual(['agents.reviewer']);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toEqual(
      expect.arrayContaining([
        { path: 'version', summary: '0.1.0 to 0.2.0' },
        { path: 'agents.author', summary: 'its configuration changed' },
        { path: 'agents.planner.subAgents', summary: 'its sub-agents or their hints changed' },
        { path: 'agents.planner', summary: 'its configuration changed' },
      ]),
    );
    expect(diff.permissionChanges.map((p) => p.subject).sort()).toEqual(['crm', 'crm.example']);
    // The other way round, the pack asks for less and nothing new.
    const back = diffLoads(
      after,
      before,
      await permissionSurface(after, catalog),
      await permissionSurface(before, catalog),
    );
    expect(back.removed).toEqual(['agents.reviewer']);
    expect(back.permissionChanges).toEqual([]);
  });

  it('is empty for the same pack', async () => {
    const l = await load();
    const p = await permissionSurface(l, catalog);
    expect(diffLoads(l, l, p, p)).toEqual({
      added: [],
      removed: [],
      changed: [],
      permissionChanges: [],
    });
  });
});
