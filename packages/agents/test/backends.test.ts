import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backendDescriptor, type BackendDescriptor } from '@kramahq/contract';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BackendRegistry,
  buildLaunch,
  checkBackend,
  extractOptions,
  validateOptions,
  type Prober,
  type RuntimeContext,
} from '../src/index.js';

const rt = (over: Partial<RuntimeContext> = {}): RuntimeContext => ({
  port: 41001,
  workspace: '/work/agent one',
  configPath: '/tmp/agent one/config.json',
  agentName: 'Dev',
  agentDescription: 'Developer agent',
  systemPrompt: 'Be careful.',
  ambientEnv: {},
  ...over,
});

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'krama backends '));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('built-in backends', () => {
  const reg = BackendRegistry.withBuiltins();

  it('ships claude, codex, copilot, opencode and antigravity', () => {
    expect(reg.list().map((d) => d.id)).toEqual([
      'a2a-antigravity',
      'a2a-claude',
      'a2a-codex',
      'a2a-copilot',
      'a2a-opencode',
    ]);
    expect(reg.list().every((d) => d.origin === 'builtin')).toBe(true);
  });

  it('every descriptor is internally consistent', () => {
    for (const d of reg.list()) {
      expect(backendDescriptor.safeParse(d).success, d.id).toBe(true);
      expect(d.id, d.id).toBe(`a2a-${d.providerKey}`);
      expect(d.options.length, d.id).toBeGreaterThan(5);
      const keys = d.options.map((o) => o.key);
      expect(new Set(keys).size, d.id).toBe(keys.length);
      for (const k of [d.mapping.workspace, d.mapping.model, d.mapping.systemPrompt].filter(
        Boolean,
      ))
        expect(keys, `${d.id} maps to ${k}`).toContain(k);
      expect(
        d.prerequisites.some((p) => p.id === 'wrapper'),
        d.id,
      ).toBe(true);
      expect(d.package.install, d.id).toContain(d.package.name);
    }
  });

  it('records the real per-provider differences behind one common model', () => {
    const by = (id: string) => reg.get(id)!;
    expect(by('a2a-claude').mapping).toMatchObject({
      workspace: 'workingDirectory',
      systemPrompt: 'systemPromptAppend',
    });
    expect(by('a2a-codex').mapping.systemPrompt).toBe('developerInstructions');
    expect(by('a2a-copilot').mapping).toMatchObject({
      workspace: 'workspaceDirectory',
      systemPrompt: 'systemPrompt',
    });
    expect(by('a2a-opencode').mapping.workspace).toBe('projectDirectory');
    expect(by('a2a-antigravity').mapping.systemPrompt).toBe('systemInstructions');
    expect(by('a2a-antigravity').prerequisites.map((p) => p.id)).toContain('python');
    expect(by('a2a-opencode').prerequisites.map((p) => p.id)).toContain('server');
    // Dangerous switches are flagged for the consent screen.
    expect(
      by('a2a-claude').options.find((o) => o.key === 'dangerouslyAllowBypassPermissions')?.risk,
    ).toBe('high');
    expect(by('a2a-codex').options.find((o) => o.key === 'sandboxMode')?.values).toContain(
      'danger-full-access',
    );
  });

  it('stays in sync with the wrapper schemas when the wrapper checkout is available', () => {
    const wrapper = process.env.A2A_WRAPPER_DIR;
    if (!wrapper || !existsSync(wrapper)) return; // set A2A_WRAPPER_DIR to a checkout of a2a-wrapper to enable
    for (const d of reg.list()) {
      const file = join(wrapper, d.id, 'schemas', 'agent-config.schema.json');
      if (!existsSync(file)) continue;
      const fromSchema = extractOptions(JSON.parse(readFileSync(file, 'utf8')), d.providerKey).map(
        (o) => o.key,
      );
      const drift = {
        missingInDescriptor: fromSchema.filter((k) => !d.options.some((o) => o.key === k)),
        removedFromWrapper: d.options.map((o) => o.key).filter((k) => !fromSchema.includes(k)),
      };
      expect(drift, `${d.id}: re-run scaffold to refresh options`).toEqual({
        missingInDescriptor: [],
        removedFromWrapper: [],
      });
    }
  });
});

describe('adding a provider needs only a descriptor file', () => {
  const newBackend = {
    id: 'a2a-newcli',
    label: 'New CLI',
    package: { name: 'a2a-newcli', bin: 'a2a-newcli', install: 'npm i -g a2a-newcli' },
    launch: { defaultPort: 3055 },
    providerKey: 'newcli',
    mapping: { workspace: 'cwd', systemPrompt: 'persona' },
    options: [
      { key: 'cwd', type: 'string', description: 'Workspace directory.' },
      { key: 'model', type: 'string', description: 'Model.' },
      { key: 'persona', type: 'string', description: 'System prompt.' },
      { key: 'mode', type: 'enum', values: ['safe', 'fast'], description: 'Run mode.' },
      { key: 'apiKey', type: 'string', secret: true, description: 'Key.' },
    ],
    env: [{ name: 'NEWCLI_API_KEY', description: 'API key', required: true, secret: true }],
    prerequisites: [
      {
        id: 'wrapper',
        description: 'a2a-newcli installed',
        kind: 'binary',
        check: { command: ['a2a-newcli', '--version'] },
      },
    ],
    capabilities: {
      canOrchestrate: false,
      cost: 'unknown',
      sideband: true,
      resumableSessions: false,
    },
  };

  it('loads from a directory, validates, and works through the whole pipeline with no code change', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'newcli.json'), JSON.stringify(newBackend));
    const reg = BackendRegistry.withBuiltins();
    const res = reg.loadDir(dir, 'user');
    expect(res).toEqual({ loaded: ['a2a-newcli'], problems: [] });
    const d = reg.get('a2a-newcli')!;
    expect(d.origin).toBe('user');
    expect(d.launch.readyPath).toBe('/.well-known/agent-card.json'); // defaults applied
    const out = buildLaunch(
      d,
      { model: 'x-1', options: { mode: 'safe' }, secrets: { NEWCLI_API_KEY: 'newcli-key' } },
      rt({ secretValues: { 'newcli-key': 's3cret' } }),
    );
    expect(out.ok).toBe(true);
    expect(out.command).toBe('a2a-newcli');
    expect(out.config.newcli).toEqual({
      mode: 'safe',
      cwd: '/work/agent one',
      model: 'x-1',
      persona: 'Be careful.',
    });
    expect(out.env).toEqual({ NEWCLI_API_KEY: 's3cret' });
    expect(JSON.stringify(out.config)).not.toContain('s3cret');
  });

  it('reports a bad file with a readable message and still loads the good ones', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'good.json'), JSON.stringify(newBackend));
    writeFileSync(join(dir, 'broken.json'), '{ not json');
    writeFileSync(join(dir, 'invalid.json'), JSON.stringify({ id: 'Bad Id', label: 'x' }));
    writeFileSync(
      join(dir, 'dupe.json'),
      JSON.stringify({
        ...newBackend,
        id: 'a2a-dupe',
        options: [...newBackend.options, newBackend.options[0]],
      }),
    );
    const reg = new BackendRegistry();
    const res = reg.loadDir(dir);
    expect(res.loaded).toEqual(['a2a-newcli']);
    expect(res.problems.map((p) => p.file.split(/[\\/]/).pop()).sort()).toEqual([
      'broken.json',
      'dupe.json',
      'invalid.json',
    ]);
    expect(res.problems.find((p) => p.file.endsWith('broken.json'))?.errors[0]).toContain(
      'not valid JSON',
    );
    expect(res.problems.find((p) => p.file.endsWith('invalid.json'))?.errors[0]).toContain('id');
    expect(res.problems.find((p) => p.file.endsWith('dupe.json'))?.errors[0]).toContain(
      'duplicate keys',
    );
  });

  it('lets a user file replace a built-in and records the override', () => {
    const dir = tmp();
    writeFileSync(
      join(dir, 'codex.json'),
      JSON.stringify({ ...newBackend, id: 'a2a-codex', label: 'Codex (patched)' }),
    );
    const reg = BackendRegistry.withBuiltins();
    reg.loadDir(dir, 'user');
    expect(reg.get('a2a-codex')?.label).toBe('Codex (patched)');
    expect(reg.overrides).toEqual([{ id: 'a2a-codex', from: 'builtin', by: 'user' }]);
  });

  it('treats a missing directory as empty', () => {
    expect(new BackendRegistry().loadDir(join(tmp(), 'nope'))).toEqual({
      loaded: [],
      problems: [],
    });
  });
});

describe('launch plans per provider', () => {
  const reg = BackendRegistry.withBuiltins();
  const plan = (id: string, def = {}, ctx: Partial<RuntimeContext> = {}) =>
    buildLaunch(reg.get(id)!, def, rt(ctx));

  it('claude: system prompt appends, workspace and model land in the claude section, key comes from the binding', () => {
    const out = plan(
      'a2a-claude',
      {
        model: 'claude-opus-5-5',
        options: { maxTurns: 40, permissionMode: 'acceptEdits' },
        secrets: { ANTHROPIC_API_KEY: 'anthropic' },
      },
      { secretValues: { anthropic: 'sk-ant-x' }, allowedTools: ['Read', 'Edit'] },
    );
    expect(out.ok).toBe(true);
    expect(out.config.claude).toEqual({
      maxTurns: 40,
      permissionMode: 'acceptEdits',
      workingDirectory: '/work/agent one',
      model: 'claude-opus-5-5',
      systemPromptAppend: 'Be careful.',
      allowedTools: ['Read', 'Edit'],
    });
    expect(out.env).toEqual({ ANTHROPIC_API_KEY: 'sk-ant-x' });
    expect(out.args).toEqual([
      '--config',
      '/tmp/agent one/config.json',
      '--port',
      '41001',
      '--hostname',
      '127.0.0.1',
      '--advertise-host',
      '127.0.0.1',
    ]);
    expect(out.command).toBe('a2a-claude');
  });

  it('codex: developer instructions and the sandbox enum', () => {
    const out = plan(
      'a2a-codex',
      { options: { sandboxMode: 'workspace-write', networkAccessEnabled: false } },
      { ambientEnv: { OPENAI_API_KEY: 'sk-x' } },
    );
    expect(out.config.codex).toMatchObject({
      sandboxMode: 'workspace-write',
      developerInstructions: 'Be careful.',
      workingDirectory: '/work/agent one',
    });
    expect(out.env.OPENAI_API_KEY).toBe('sk-x');
  });

  it('copilot: a different workspace key; token is optional because `gh` can authenticate', () => {
    const out = plan('a2a-copilot', { model: 'gpt-4.1' });
    expect(out.ok).toBe(true);
    expect(out.config.copilot).toMatchObject({
      workspaceDirectory: '/work/agent one',
      systemPrompt: 'Be careful.',
      model: 'gpt-4.1',
    });
  });

  it('opencode: project directory; antigravity: system instructions', () => {
    expect(plan('a2a-opencode').config.opencode).toMatchObject({
      projectDirectory: '/work/agent one',
    });
    expect(plan('a2a-antigravity').config.antigravity).toMatchObject({
      workingDirectory: '/work/agent one',
      systemInstructions: 'Be careful.',
    });
  });

  it('shared settings go to the shared sections; provider-only keys are rejected there', () => {
    const ok = plan(
      'a2a-codex',
      { common: { timeouts: { delegationMs: 1_800_000 }, logging: { level: 'debug' } } },
      { ambientEnv: { OPENAI_API_KEY: 'k' } },
    );
    expect(ok.config.timeouts).toEqual({ delegationMs: 1_800_000 });
    const bad = plan(
      'a2a-codex',
      { common: { sandboxMode: 'read-only' } },
      { ambientEnv: { OPENAI_API_KEY: 'k' } },
    );
    expect(bad.problems.map((p) => p.code)).toContain('unknown_common');
    expect(bad.ok).toBe(false);
  });

  it('reports a missing required credential instead of starting a doomed agent', () => {
    const out = plan('a2a-claude');
    expect(out.problems).toEqual([
      expect.objectContaining({
        code: 'missing_env',
        message: expect.stringContaining('ANTHROPIC_API_KEY'),
      }),
    ]);
    expect(out.ok).toBe(false);
  });

  it('reports a binding whose secret cannot be resolved', () => {
    const out = plan(
      'a2a-claude',
      { secrets: { ANTHROPIC_API_KEY: 'gone' } },
      { secretValues: {} },
    );
    expect(out.problems.map((p) => p.code)).toEqual(
      expect.arrayContaining(['unresolved_secret', 'missing_env']),
    );
  });

  it('passes only the declared variables to the child, not the whole parent environment', () => {
    const out = plan(
      'a2a-claude',
      {},
      { ambientEnv: { ANTHROPIC_API_KEY: 'k', AWS_SECRET_ACCESS_KEY: 'nope', PATH: '/bin' } },
    );
    expect(Object.keys(out.env)).toEqual(['ANTHROPIC_API_KEY']);
  });

  it('binds to loopback unless told otherwise', () => {
    expect((plan('a2a-opencode').config.server as { hostname: string }).hostname).toBe('127.0.0.1');
    expect(
      (plan('a2a-opencode', {}, { hostname: '0.0.0.0' }).config.server as { advertiseHost: string })
        .advertiseHost,
    ).toBe('localhost');
  });
});

describe('option validation', () => {
  const claude = BackendRegistry.withBuiltins().get('a2a-claude')!;
  const codes = (o: Record<string, unknown>) =>
    validateOptions(claude, o).map((i) => `${i.code}:${i.path}`);

  it('accepts valid options', () => {
    expect(
      codes({ maxTurns: 10, fallbackModel: 'claude-sonnet-5-5', allowedTools: ['Read'] }),
    ).toEqual([]);
  });
  it('rejects unknown keys with a hint, wrong types and bad enum values', () => {
    expect(codes({ maxTurnz: 3 })).toEqual(['unknown_option:maxTurnz']);
    expect(validateOptions(claude, { maxTurnz: 3 })[0]?.message).toContain('Known:');
    expect(codes({ maxTurns: 'ten' })).toEqual(['wrong_type:maxTurns']);
    expect(codes({ permissionMode: 'yolo' })).toEqual(['bad_value:permissionMode']);
  });
  it('flags enum violations where the wrapper enumerates', () => {
    const codex = BackendRegistry.withBuiltins().get('a2a-codex')!;
    expect(validateOptions(codex, { sandboxMode: 'everything' }).map((i) => i.code)).toEqual([
      'bad_value',
    ]);
    expect(validateOptions(codex, { sandboxMode: 'read-only' })).toEqual([]);
  });
  it('keeps secrets out of config files but allows ${ENV} references', () => {
    const copilot = BackendRegistry.withBuiltins().get('a2a-copilot')!;
    expect(validateOptions(copilot, { githubToken: 'ghp_literal' }).map((i) => i.code)).toEqual([
      'secret_in_config',
    ]);
    expect(validateOptions(copilot, { githubToken: '${GITHUB_TOKEN}' })).toEqual([]);
  });
});

describe('doctor', () => {
  const reg = BackendRegistry.withBuiltins();
  const prober = (ok: Record<string, boolean>, out: Record<string, string> = {}): Prober => ({
    run: async (c) => ({
      ok: ok[c[0]!] ?? false,
      output: out[c[0]!] ?? (ok[c[0]!] ? 'ok' : 'command not found'),
    }),
    get: async (u) => ({ ok: ok[u] ?? false, output: ok[u] ? 'HTTP 200' : 'connect ECONNREFUSED' }),
  });

  it('passes when everything is present', async () => {
    const r = await checkBackend(
      reg.get('a2a-claude')!,
      prober({ node: true, 'a2a-claude': true }, { node: 'v22.1.0' }),
      { env: { ANTHROPIC_API_KEY: 'k' } },
    );
    expect(r.ok).toBe(true);
  });

  it('fails with an OS-specific fix when the wrapper or runtime is missing', async () => {
    const r = await checkBackend(
      reg.get('a2a-antigravity')!,
      prober({ node: true, 'a2a-antigravity': false, python3: false }, { node: 'v22.1.0' }),
      { platform: 'win32' },
    );
    expect(r.ok).toBe(false);
    expect(r.items.find((i) => i.id === 'python')).toMatchObject({
      ok: false,
      fix: 'winget install Python.Python.3.12',
    });
    expect(r.items.find((i) => i.id === 'wrapper')?.fix).toBe('npm i -g a2a-antigravity');
  });

  it('rejects a Node that is too old and a Python that is too old', async () => {
    const r = await checkBackend(
      reg.get('a2a-antigravity')!,
      prober(
        { node: true, 'a2a-antigravity': true, python3: true },
        { node: 'v18.0.0', python3: 'Python 3.9.1' },
      ),
    );
    expect(
      r.items
        .filter((i) => !i.ok && !i.optional)
        .map((i) => i.id)
        .sort(),
    ).toEqual(['node', 'python']);
  });

  it('probes a service by URL and treats optional prerequisites as non-blocking', async () => {
    const down = await checkBackend(
      reg.get('a2a-opencode')!,
      prober({ node: true, 'a2a-opencode': true }, { node: 'v22.0.0' }),
    );
    expect(down.ok).toBe(false);
    expect(down.items.find((i) => i.id === 'server')?.ok).toBe(false);
    const up = await checkBackend(
      reg.get('a2a-opencode')!,
      prober(
        { node: true, 'a2a-opencode': true, 'http://localhost:4096/': true },
        { node: 'v22.0.0' },
      ),
    );
    expect(up.ok).toBe(true);
    const copilot = await checkBackend(
      reg.get('a2a-copilot')!,
      prober({ node: true, 'a2a-copilot': true, gh: false }, { node: 'v22.0.0' }),
    );
    expect(copilot.ok).toBe(true); // gh is optional (a token works instead)
  });

  it('requires one credential of a group when the group is required', async () => {
    const d: BackendDescriptor = {
      ...reg.get('a2a-claude')!,
      env: [
        { name: 'A_KEY', description: 'a', required: true, secret: true, group: 'auth' },
        { name: 'B_KEY', description: 'b', required: false, secret: true, group: 'auth' },
      ],
    };
    const none = await checkBackend(
      d,
      prober({ node: true, 'a2a-claude': true }, { node: 'v22.0.0' }),
      { env: {} },
    );
    expect(none.items.find((i) => i.id === 'env:auth')?.ok).toBe(false);
    const alt = await checkBackend(
      d,
      prober({ node: true, 'a2a-claude': true }, { node: 'v22.0.0' }),
      { env: { B_KEY: 'x' } },
    );
    expect(alt.items.find((i) => i.id === 'env:auth')?.ok).toBe(true);
  });
});

describe('scaffold from a wrapper schema', () => {
  it('extracts typed options, enums, defaults, risk and secret flags', () => {
    const schema = {
      $ref: '#/definitions/Cfg',
      definitions: {
        Cfg: { type: 'object', properties: { acme: { $ref: '#/definitions/Acme' } } },
        Acme: {
          type: 'object',
          required: ['workspace'],
          properties: {
            workspace: { type: 'string', description: 'Where to work. More text.' },
            retries: { type: 'integer', default: 3, description: 'Retry count.' },
            mode: { type: 'string', enum: ['a', 'b'], description: 'Mode.' },
            effort: {
              anyOf: [{ enum: ['low', 'high'] }, { type: 'null' }],
              description: 'Effort.',
            },
            apiToken: { type: 'string', description: 'Token.' },
            dangerouslySkipChecks: { type: 'boolean', description: 'Skips checks.' },
            dirs: { type: 'array', items: { type: 'string' }, description: 'Dirs.' },
          },
        },
      },
    };
    const byKey = Object.fromEntries(extractOptions(schema, 'acme').map((o) => [o.key, o]));
    expect(byKey.workspace).toMatchObject({
      type: 'string',
      required: true,
      description: 'Where to work.',
    });
    expect(byKey.retries).toMatchObject({ type: 'number', default: 3 });
    expect(byKey.mode).toMatchObject({ type: 'enum', values: ['a', 'b'] });
    expect(byKey.effort).toMatchObject({ type: 'enum', values: ['low', 'high'] });
    expect(byKey.apiToken?.secret).toBe(true);
    expect(byKey.dangerouslySkipChecks?.risk).toBe('high');
    expect(byKey.dirs?.type).toBe('string[]');
  });
});
