import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { matchDefinitions, resolveRoster } from '@kramahq/engine';
import { afterEach, describe, expect, it } from 'vitest';
import { BackendRegistry, loadDefinitions } from '../src/index.js';

const dirs: string[] = [];
const root = () => {
  const d = mkdtempSync(join(tmpdir(), 'krama defs '));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const put = (base: string, rel: string, content: string) => {
  const p = join(base, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, content);
};
const catalog = BackendRegistry.withBuiltins();

const dev = `
name: Developer
description: Implements units of work and writes tests.
backend:
  wrapper: a2a-codex
  model: gpt-5-codex
  options:
    sandboxMode: workspace-write
  secrets:
    OPENAI_API_KEY: openai-main
capabilities: [code, tests]
mcpServers: [git]
permissions:
  tools: { shell: ask, write: allow }
memory:
  enabled: true
  scopes: [{ scope: project, access: propose }]
costHint:
  perMillionTokens: { amount: 6, currency: USD }
`;

describe('loading agent definitions from a folder', () => {
  it('reads role/variant folders, derives the id, and keeps the prompt and context text', () => {
    const r = root();
    put(r, 'developer/default/agent.yaml', dev);
    put(r, 'developer/default/prompt.md', 'You are a careful senior engineer.');
    put(r, 'developer/default/context.md', '# Repo notes');
    put(
      r,
      'reviewer/strict/agent.json',
      JSON.stringify({
        name: 'Reviewer',
        description: 'Reviews.',
        backend: { wrapper: 'a2a-claude' },
        capabilities: ['code-review'],
      }),
    );
    const res = loadDefinitions(r, catalog, { type: 'pack', packId: 'pack_x', sha: 'abc' });
    expect(res.problems).toEqual([]);
    expect(res.bundles.map((b) => b.definition.id)).toEqual([
      'developer/default',
      'reviewer/strict',
    ]);
    const d = res.bundles[0]!;
    expect(d.definition).toMatchObject({
      role: 'developer',
      variant: 'default',
      source: { type: 'pack', packId: 'pack_x' },
      capabilities: ['code', 'tests'],
      backend: { wrapper: 'a2a-codex', options: { sandboxMode: 'workspace-write' } },
    });
    expect(d.systemPrompt).toBe('You are a careful senior engineer.');
    expect(d.context).toBe('# Repo notes');
    expect(res.bundles[1]!.definition.memory).toEqual({ enabled: false, scopes: [] }); // sensible defaults
    expect(res.bundles[1]!.systemPrompt).toBe('');
  });

  it('reports exactly what is wrong, with the path, and still loads the good ones', () => {
    const r = root();
    put(r, 'developer/default/agent.yaml', dev);
    put(
      r,
      'ghost/default/agent.yaml',
      'name: G\ndescription: d\nbackend: { wrapper: a2a-unknown }\n',
    );
    put(
      r,
      'typo/default/agent.yaml',
      'name: T\ndescription: d\nbackend: { wrapper: a2a-codex, options: { sandboxMod: x, networkAccessEnabled: "yes" } }\n',
    );
    put(r, 'broken/default/agent.yaml', 'name: [unclosed');
    put(r, 'nobackend/default/agent.yaml', 'name: N\ndescription: d\n');
    put(r, 'empty/default/readme.txt', 'nothing here');
    put(r, 'Bad_Role/default/agent.yaml', dev);
    const res = loadDefinitions(r, catalog);
    expect(res.bundles.map((b) => b.definition.id)).toEqual(['developer/default']);
    const by = (frag: string) => res.problems.find((p) => p.path.includes(frag))!;
    expect(by('ghost').errors[0]).toContain('"a2a-unknown" is not registered');
    expect(by('ghost').errors[0]).toContain('a2a-codex');
    expect(by('typo').errors.join('\n')).toMatch(/backend\.options\.sandboxMod: .*not an option/);
    expect(by('typo').errors.join('\n')).toContain('networkAccessEnabled');
    expect(by('broken').errors[0]).toContain('could not parse');
    expect(by('nobackend').errors.join('\n')).toContain('backend');
    expect(by('empty').errors[0]).toContain('no agent.yaml');
    expect(by('Bad_Role').errors[0]).toContain('lowercase');
  });

  it('warns, without failing, about a secret binding the backend never reads', () => {
    const r = root();
    put(
      r,
      'developer/default/agent.yaml',
      dev.replace('OPENAI_API_KEY: openai-main', 'ANTHROPIC_API_KEY: wrong'),
    );
    const res = loadDefinitions(r, catalog);
    expect(res.bundles).toHaveLength(1);
    expect(res.problems).toEqual([
      expect.objectContaining({
        errors: [],
        warnings: [expect.stringContaining('does not read this variable')],
      }),
    ]);
  });

  it('works with a backend that only exists as a descriptor file', () => {
    const custom = new BackendRegistry();
    custom.register({
      id: 'a2a-newcli',
      label: 'New',
      package: { name: 'a2a-newcli', bin: 'a2a-newcli', install: 'npm i -g a2a-newcli' },
      launch: { defaultPort: 3055 },
      providerKey: 'newcli',
      mapping: { workspace: 'cwd' },
      options: [
        { key: 'cwd', type: 'string', description: 'd' },
        { key: 'mode', type: 'enum', values: ['safe'], description: 'd' },
      ],
      env: [],
      prerequisites: [],
      capabilities: {
        canOrchestrate: false,
        cost: 'unknown',
        sideband: true,
        resumableSessions: false,
      },
    });
    const r = root();
    put(
      r,
      'tester/default/agent.yaml',
      'name: Tester\ndescription: d\nbackend: { wrapper: a2a-newcli, options: { mode: safe } }\ncapabilities: [testing]\n',
    );
    expect(loadDefinitions(r, custom).bundles.map((b) => b.definition.id)).toEqual([
      'tester/default',
    ]);
    expect(loadDefinitions(r, catalog).problems[0]?.errors[0]).toContain('not registered');
  });

  it('a missing folder is empty, not an error', () => {
    expect(loadDefinitions(join(root(), 'nope'), catalog)).toEqual({ bundles: [], problems: [] });
  });
});

describe('definitions to a resolved roster, end to end', () => {
  it('loads, matches by capability, backend and cost, and resolves a pack roster', () => {
    const r = root();
    put(r, 'developer/codex/agent.yaml', dev);
    put(
      r,
      'developer/claude/agent.yaml',
      'name: D2\ndescription: d\nbackend: { wrapper: a2a-claude }\ncapabilities: [code, tests, refactor]\ncostHint: { perMillionTokens: { amount: 15, currency: USD } }\n',
    );
    put(
      r,
      'reviewer/default/agent.yaml',
      'name: R\ndescription: d\nbackend: { wrapper: a2a-claude }\ncapabilities: [code-review]\n',
    );
    const defs = loadDefinitions(r, catalog).bundles.map((b) => b.definition);
    const usable = (b: string) => catalog.has(b);
    const ranked = matchDefinitions(
      defs,
      { role: 'developer', capabilities: ['code', 'tests'], backend: 'a2a-claude' },
      (d) => usable(d.backend.wrapper),
    );
    expect(ranked.map((c) => c.definition.id)).toEqual(['developer/claude', 'developer/codex']);
    const res = resolveRoster(
      [
        { role: 'developer', select: { capabilities: ['code'], backend: 'a2a-codex' } },
        { role: 'reviewer', select: { capabilities: ['code-review'] } },
      ],
      defs,
      { backendUsable: usable },
    );
    expect(res.resolved.map((x) => `${x.role}:${x.definition.id}@${x.backend}`)).toEqual([
      'developer:developer/codex@a2a-codex',
      'reviewer:reviewer/default@a2a-claude',
    ]);
  });
});
