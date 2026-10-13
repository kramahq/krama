import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BackendDescriptor } from '@kramahq/contract';
import { parse, stringify } from 'yaml';
import { afterAll, describe, expect, it } from 'vitest';
import { loadPackDir, loadPackText, parseGitSource, type PackLoadEnv } from '../src/index.js';

const descriptor = (id: string, providerKey: string, over: object = {}): BackendDescriptor =>
  ({
    id,
    providerKey,
    env: [{ name: `${providerKey.toUpperCase()}_API_KEY`, required: false, secret: true }],
    capabilities: {
      canOrchestrate: true,
      cost: 'reported',
      sideband: true,
      resumableSessions: true,
    },
    options: [],
    ...over,
  }) as unknown as BackendDescriptor;

const BACKENDS = [
  descriptor('a2a-claude', 'claude'),
  descriptor('a2a-codex', 'codex'),
  descriptor('a2a-opencode', 'opencode', {
    capabilities: {
      canOrchestrate: false,
      cost: 'not_reported',
      sideband: true,
      resumableSessions: false,
    },
  }),
];
const env = (over: Partial<PackLoadEnv> = {}): PackLoadEnv => ({
  backends: { list: () => BACKENDS, get: (id) => BACKENDS.find((b) => b.id === id) },
  ...over,
});

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'krama pack '));
  dirs.push(d);
  return d;
};
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** PACK-FORMAT §9.1: an orchestrator and two workers, all embedded. */
const MINIMAL = `
name: release-notes
version: 0.1.0
description: Drafts release notes and has them reviewed.
engine: ">=0.1.0"
orchestrator: planner
agents:
  planner:
    config:
      agentCard: { name: planner, description: Plans the work and delegates it }
      claude:
        model: claude-sonnet-5-5
        systemPromptAppend: You coordinate a small team that produces release notes.
    subAgents:
      - agent: author
        hint: Use to write or revise the draft.
      - agent: reviewer
        hint: Use after every draft.
  author:
    role: author
    config:
      agentCard:
        name: author
        description: Writes release notes
        skills: [ { id: write-notes, name: Write notes, description: Drafts notes } ]
      codex: { model: gpt-5.2, developerInstructions: You write concise notes. }
  reviewer:
    role: reviewer
    config:
      agentCard:
        name: reviewer
        description: Reviews release notes
        skills: [ { id: review-notes, name: Review notes, description: Replies APPROVED or CHANGES REQUESTED } ]
      claude: { model: claude-sonnet-5-5, systemPromptAppend: Review the draft. }
`;

const codes = (l: { issues: { code: string }[] }) => l.issues.map((i) => i.code);
const errors = (l: { issues: { severity: string; code: string; path: string }[] }) =>
  l.issues.filter((i) => i.severity === 'error').map((i) => `${i.code} @ ${i.path}`);

/** The §9.1 sample, edited as plain data, as YAML text. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = Record<string, any>;
const edit = (f: (p: Doc) => void): string => {
  const p = parse(MINIMAL) as Doc;
  f(p);
  return stringify(p);
};

describe('a valid pack', () => {
  it('validates the minimal sample and detects each agent’s backend', async () => {
    const r = await loadPackText(MINIMAL, undefined, env());
    expect(errors(r)).toEqual([]);
    expect(r.ok).toBe(true);
    expect(Object.fromEntries(Object.values(r.agents).map((a) => [a.id, a.backend]))).toEqual({
      planner: 'a2a-claude',
      author: 'a2a-codex',
      reviewer: 'a2a-claude',
    });
    expect(r.agents['reviewer']).toMatchObject({ kind: 'config', role: 'reviewer' });
    expect(r.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('validates an external agent as a leaf, with its token bound', async () => {
    const text = edit((p) => {
      p.agents['vendor'] = {
        description: 'A vendor research service',
        external: {
          name: 'vendor',
          agentCardUrl: 'https://research.example.com/.well-known/agent-card.json',
          auth: { mode: 'bearer', token: '${VENDOR_TOKEN}' },
        },
        secrets: { VENDOR_TOKEN: 'vendor-token' },
      };
      p.agents.author.subAgents = [{ agent: 'vendor', hint: 'Market data.' }];
    });
    const r = await loadPackText(text, undefined, env());
    expect(errors(r)).toEqual([]);
    expect(r.agents['vendor']!.kind).toBe('external');
  });

  it('has the same digest for the same pack and another when anything changes', async () => {
    const a = await loadPackText(MINIMAL, undefined, env());
    const b = await loadPackText(MINIMAL, undefined, env());
    const c = await loadPackText(MINIMAL.replace('write or revise', 'write'), undefined, env());
    expect(a.digest).toBe(b.digest);
    expect(c.digest).not.toBe(a.digest);
  });
});

describe('what makes a pack invalid, each with the path that causes it', () => {
  it('an unknown agent id in a reference', async () => {
    const r = await loadPackText(
      edit((p) => (p.agents.planner.subAgents[0].agent = 'nobody')),
      undefined,
      env(),
    );
    expect(errors(r)).toContain('graph @ agents.planner.subAgents[0].agent');
  });

  it('a cycle', async () => {
    const r = await loadPackText(
      edit((p) => (p.agents.author.subAgents = [{ agent: 'planner' }])),
      undefined,
      env(),
    );
    expect(r.issues.find((i) => i.code === 'graph')?.message).toMatch(
      /Cycle: planner -> author -> planner/,
    );
  });

  it('an external orchestrator', async () => {
    const text = edit((p) => {
      p.agents.ext = {
        description: 'remote',
        external: { name: 'ext', agentCardUrl: 'https://x.example/card.json' },
      };
      p.orchestrator = 'ext';
    });
    expect(errors(await loadPackText(text, undefined, env()))).toContain('graph @ orchestrator');
  });

  it('a secret written into a config, without echoing it', async () => {
    const secret = 'sk-' + 'a'.repeat(40);
    const text = edit(
      (p) =>
        (p.agents.author.config.mcp = {
          tools: {
            type: 'http',
            url: 'https://t.example',
            headers: { Authorization: `Bearer ${secret}` },
          },
        }),
    );
    const r = await loadPackText(text, undefined, env());
    expect(errors(r)).toContain(
      'secret_in_config @ agents.author.config.mcp.tools.headers.Authorization',
    );
    expect(JSON.stringify(r.issues)).not.toContain(secret);
    const literal = edit(
      (p) =>
        (p.agents.author.config.mcp = {
          t: { type: 'stdio', command: 'x', env: { API_TOKEN: 'abc123' } },
        }),
    );
    expect(errors(await loadPackText(literal, undefined, env()))).toContain(
      'secret_in_config @ agents.author.config.mcp.t.env.API_TOKEN',
    );
  });

  it('a ${VAR} that is not bound, and one that is', async () => {
    const mk = (secrets?: object) =>
      edit((p) => {
        p.agents.author.config.mcp = {
          t: {
            type: 'http',
            url: 'https://t.example',
            headers: { Authorization: 'Bearer ${SERVICE_TOKEN}' },
          },
        };
        if (secrets) p.agents.author.secrets = secrets;
      });
    expect(errors(await loadPackText(mk(), undefined, env()))).toContain(
      'unbound_variable @ agents.author.config.mcp.t.headers.Authorization',
    );
    expect(errors(await loadPackText(mk({ SERVICE_TOKEN: 'svc' }), undefined, env()))).toEqual([]);
    // Krama's own variable and the backend's own key need no binding.
    const own = edit(
      (p) =>
        (p.agents.author.config.mcp = {
          t: {
            type: 'http',
            url: 'https://t',
            headers: { A: '${KRAMA_MCP_TOKEN}', B: '${CODEX_API_KEY}' },
          },
        }),
    );
    expect(errors(await loadPackText(own, undefined, env()))).toEqual([]);
  });

  it('an external token that is a literal, or a variable nobody bound', async () => {
    const ext = (token: string, secrets?: object) =>
      edit((p) => {
        p.agents.vendor = {
          description: 'v',
          external: {
            name: 'vendor',
            agentCardUrl: 'https://v.example/card.json',
            auth: { mode: 'bearer', token },
          },
          ...(secrets ? { secrets } : {}),
        };
        p.agents.author.subAgents = [{ agent: 'vendor' }];
      });
    expect(errors(await loadPackText(ext('plain-token'), undefined, env()))).toContain(
      'secret_in_config @ agents.vendor.external.auth.token',
    );
    expect(errors(await loadPackText(ext('${VT}'), undefined, env()))).toContain(
      'unbound_variable @ agents.vendor.external.auth.token',
    );
    expect(errors(await loadPackText(ext('${VT}', { VT: 's' }), undefined, env()))).toEqual([]);
  });

  it('a referenced agent that advertises no skill (but not an unreferenced one)', async () => {
    const r = await loadPackText(
      edit((p) => delete p.agents.author.config.agentCard.skills),
      undefined,
      env(),
    );
    expect(errors(r)).toContain('no_skills @ agents.author.config.agentCard.skills');
    const lone = edit((p) => {
      p.agents.stray = { config: { agentCard: { name: 's', description: 'd' }, claude: {} } };
    });
    const l = await loadPackText(lone, undefined, env());
    expect(errors(l)).toEqual([]);
    expect(codes(l)).toContain('unreachable_agent');
  });

  it('a backend policy does not allow, a config for no backend, and an orchestrator that cannot orchestrate', async () => {
    expect(
      errors(await loadPackText(MINIMAL, undefined, env({ allowedBackends: ['a2a-claude'] }))),
    ).toContain('backend_not_allowed @ agents.author.config');
    const none = edit(
      (p) =>
        (p.agents.author.config = { agentCard: p.agents.author.config.agentCard, mystery: {} }),
    );
    expect(errors(await loadPackText(none, undefined, env()))).toContain(
      'backend_unknown @ agents.author.config',
    );
    const both = edit((p) => (p.agents.author.config.claude = {}));
    expect(errors(await loadPackText(both, undefined, env()))).toContain(
      'backend_ambiguous @ agents.author.config',
    );
    const weak = edit(
      (p) =>
        (p.agents.planner.config = { agentCard: p.agents.planner.config.agentCard, opencode: {} }),
    );
    expect(errors(await loadPackText(weak, undefined, env()))).toContain(
      'cannot_orchestrate @ agents.planner',
    );
  });

  it('the shape of the file: two sources, no source, an unknown field, bad yaml', async () => {
    const two = edit((p) => (p.agents.author.git = 'github.com/a/b@v1#x'));
    expect(errors(await loadPackText(two, undefined, env()))).toContain(
      'agent_source @ agents.author',
    );
    const none = edit((p) => (p.agents.author = { role: 'author' }));
    expect(errors(await loadPackText(none, undefined, env()))).toContain(
      'agent_source @ agents.author',
    );
    const unknown = edit((p) => (p.methodology = { phases: [] }));
    expect(errors(await loadPackText(unknown, undefined, env()))).toContain(
      'unknown_field @ methodology',
    );
    const typo = edit((p) => (p.agents.author.subAgent = []));
    expect(errors(await loadPackText(typo, undefined, env()))).toContain(
      'unknown_field @ agents.author.subAgent',
    );
    expect((await loadPackText('name: [unclosed', undefined, env())).issues[0]).toMatchObject({
      code: 'invalid_yaml',
    });
  });

  it('a hint over 500 characters (the schema’s own limit), the reserved MCP key, and warnings for what Krama replaces', async () => {
    const long = edit((p) => (p.agents.planner.subAgents[0].hint = 'x'.repeat(501)));
    expect(errors(await loadPackText(long, undefined, env()))).toContain(
      'invalid_field @ agents.planner.subAgents[0].hint',
    );
    const reserved = edit(
      (p) => (p.agents.author.config.mcp = { 'a2a-subagents': { type: 'http', url: 'https://x' } }),
    );
    expect(errors(await loadPackText(reserved, undefined, env()))).toContain(
      'reserved_mcp_key @ agents.author.config.mcp.a2a-subagents',
    );
    const replaced = edit((p) => {
      p.agents.author.config.events = { enabled: true };
      p.agents.author.config.subAgents = { agents: [] };
    });
    const r = await loadPackText(replaced, undefined, env());
    expect(r.ok).toBe(true);
    expect(codes(r)).toEqual(expect.arrayContaining(['events_overridden', 'sub_agents_replaced']));
  });

  it('whatever the host says is wrong with a provider section, at its path', async () => {
    const r = await loadPackText(
      MINIMAL,
      undefined,
      env({
        checkProviderConfig: (d, section) =>
          d.id === 'a2a-codex' && 'model' in section
            ? [{ path: 'model', message: 'not a known model' }]
            : [],
      }),
    );
    expect(errors(r)).toEqual(['provider_config @ agents.author.config.codex.model']);
  });
});

describe('files a pack points at', () => {
  const withFiles = (config: object) => edit((p) => Object.assign(p.agents.author.config, config));

  it('asks for a directory when a text pack names a file, and checks the file when there is one', async () => {
    const text = withFiles({ memory: { instructions: 'agents/author/instructions.md' } });
    expect(errors(await loadPackText(text, undefined, env()))).toContain(
      'files_need_directory @ agents.author.config.memory.instructions',
    );

    const dir = tmp();
    expect(errors(await loadPackText(text, dir, env()))).toContain(
      'file_missing @ agents.author.config.memory.instructions',
    );
    mkdirSync(join(dir, 'agents/author'), { recursive: true });
    writeFileSync(join(dir, 'agents/author/instructions.md'), 'Be brief.');
    expect(errors(await loadPackText(text, dir, env()))).toEqual([]);
  });

  it('wants a skill directory to hold a SKILL.md with a name and a description', async () => {
    const dir = tmp();
    const text = withFiles({ memory: { skills: ['skills/checklist'] } });
    mkdirSync(join(dir, 'skills/checklist'), { recursive: true });
    expect(errors(await loadPackText(text, dir, env()))).toContain(
      'invalid_skill @ agents.author.config.memory.skills[0]',
    );
    writeFileSync(join(dir, 'skills/checklist/SKILL.md'), '# no frontmatter');
    expect(
      (await loadPackText(text, dir, env())).issues.find((i) => i.code === 'invalid_skill')
        ?.message,
    ).toMatch(/no frontmatter/);
    writeFileSync(
      join(dir, 'skills/checklist/SKILL.md'),
      '---\nname: checklist\ndescription: Check things\n---\nSteps.',
    );
    expect(errors(await loadPackText(text, dir, env()))).toEqual([]);
  });

  it('loads a pack from its directory, with a path that has spaces, and says when the file is missing', async () => {
    const dir = tmp();
    expect(errors(await loadPackDir(dir, env()))).toEqual(['missing_pack_file @ krama-pack.yaml']);
    writeFileSync(join(dir, 'krama-pack.yaml'), MINIMAL);
    expect((await loadPackDir(dir, env())).ok).toBe(true);
  });
});

describe('git agents', () => {
  const GIT = `
name: with-git
version: 0.1.0
description: A pack with a git agent
orchestrator: planner
agents:
  planner:
    git: github.com/acme/agents@v1.2.0#orchestrators/planner
    subAgents: [ { agent: helper } ]
  helper:
    git: { url: git@github.com:acme/agents.git, ref: v1.2.0, path: workers/helper }
`;

  it('parses every way of writing a git source', () => {
    expect(parseGitSource('github.com/acme/agents@v1.2.0#workers/author')).toEqual({
      url: 'github.com/acme/agents',
      ref: 'v1.2.0',
      path: 'workers/author',
    });
    expect(parseGitSource('git@github.com:acme/agents.git@v1#a/b')).toEqual({
      url: 'git@github.com:acme/agents.git',
      ref: 'v1',
      path: 'a/b',
    });
    expect(parseGitSource('github.com/acme/agents@main')).toEqual({
      url: 'github.com/acme/agents',
      ref: 'main',
      path: '',
    });
    expect(parseGitSource({ url: 'u', ref: 'r', path: '/x/' })).toEqual({
      url: 'u',
      ref: 'r',
      path: 'x',
    });
    expect(parseGitSource('github.com/acme/agents#dir')).toHaveProperty('error');
    expect(parseGitSource({ url: 'u' })).toHaveProperty('error');
  });

  it('warns, not fails, when nothing can fetch a source, so a pack validates offline', async () => {
    const r = await loadPackText(GIT, undefined, env());
    expect(r.ok).toBe(true);
    expect(r.issues.filter((i) => i.code === 'git_source_unresolved')).toHaveLength(2);
  });

  it('checks the fetched config like an embedded one, and keeps the commit it came from', async () => {
    const dir = tmp();
    mkdirSync(join(dir, 'helper'), { recursive: true });
    writeFileSync(
      join(dir, 'helper/config.json'),
      JSON.stringify({ agentCard: { name: 'helper', description: 'h' }, claude: {} }),
    );
    mkdirSync(join(dir, 'planner'), { recursive: true });
    writeFileSync(
      join(dir, 'planner/config.json'),
      JSON.stringify({ agentCard: { name: 'planner', description: 'p' }, claude: {} }),
    );
    const r = await loadPackText(
      GIT,
      undefined,
      env({
        resolveGit: async (s) => ({ dir: join(dir, s.path.split('/').at(-1)!), sha: 'abc1234' }),
      }),
    );
    // The helper is called by the planner but advertises no skill.
    expect(errors(r)).toEqual(['no_skills @ agents.helper.git(config).agentCard.skills']);
    expect(r.agents['helper']).toMatchObject({
      kind: 'git',
      backend: 'a2a-claude',
      sha: 'abc1234',
    });
  });

  it('reports a source that cannot be fetched or has no config.json', async () => {
    const dir = tmp();
    const failing = await loadPackText(
      GIT,
      undefined,
      env({
        resolveGit: async () => {
          throw new Error('auth failed');
        },
      }),
    );
    expect(errors(failing)).toContain('git_source_failed @ agents.planner.git');
    expect(JSON.stringify(failing.issues)).toContain('auth failed');
    const empty = await loadPackText(
      GIT,
      undefined,
      env({ resolveGit: async () => ({ dir, sha: 's' }) }),
    );
    expect(errors(empty)).toContain('agent_config_unreadable @ agents.planner.git');
    const missing = await loadPackText(GIT, undefined, env({ resolveGit: async () => undefined }));
    expect(errors(missing)).toContain('git_source_missing @ agents.helper.git');
  });
});
