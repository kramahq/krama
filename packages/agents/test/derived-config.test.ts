import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FakeClock,
  InMemoryEventLog,
  SequentialIds,
  StaticSecretResolver,
} from '@kramahq/engine/testing';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AgentStartError,
  BackendRegistry,
  ProcessAgentRuntime,
  deepMerge,
  deriveLaunch,
  type RuntimeContext,
} from '../src/index.js';
import { definition, fakeBackend } from './fixtures/descriptor.js';

const FAKE = fileURLToPath(new URL('./fixtures/fake-wrapper.mjs', import.meta.url));
const dirs: string[] = [];
const runtimes: ProcessAgentRuntime[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'krama derived '));
  dirs.push(d);
  return d;
};
afterEach(async () => {
  await Promise.allSettled(runtimes.splice(0).map((r) => r.shutdown()));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const descriptor = new BackendRegistry();
descriptor.register(fakeBackend(), 'user');
const fake = descriptor.get('a2a-fake')!;

const rt = (over: Partial<RuntimeContext> = {}): RuntimeContext => ({
  port: 4100,
  workspace: '/work/run_1',
  configPath: '/cfg/config.json',
  agentName: 'reviewer',
  agentDescription: 'Reviews',
  ambientEnv: {},
  ...over,
});

describe('deepMerge', () => {
  it('merges objects key by key, replaces arrays and scalars, and changes neither input', () => {
    const base = { a: { x: 1, y: { z: [1, 2] } }, keep: true };
    const over = { a: { y: { z: [9] }, w: 2 }, extra: 'e' };
    const out = deepMerge(base, over);
    expect(out).toEqual({ a: { x: 1, y: { z: [9] }, w: 2 }, keep: true, extra: 'e' });
    expect(base).toEqual({ a: { x: 1, y: { z: [1, 2] } }, keep: true });
    expect(over).toEqual({ a: { y: { z: [9] }, w: 2 }, extra: 'e' });
  });
});

describe('deriveLaunch', () => {
  const own = {
    agentCard: { name: 'reviewer', skills: [{ id: 'review' }] },
    fake: { persona: 'You review drafts.', model: 'm-2' },
    memory: { instructions: 'memory/instructions.md' },
  };

  it('keeps the agent config as it is and overlays only what belongs to this run', () => {
    const plan = deriveLaunch(fake, own, {}, rt(), {
      subAgents: { agents: [{ name: 'researcher', agentCardUrl: 'http://127.0.0.1:1/card' }] },
    });
    expect(plan.ok).toBe(true);
    expect(plan.config).toMatchObject({
      agentCard: { name: 'reviewer', skills: [{ id: 'review' }] },
      memory: { instructions: 'memory/instructions.md' },
      server: { port: 4100, hostname: '127.0.0.1', advertiseHost: '127.0.0.1' },
      fake: { model: 'm-2', cwd: '/work/run_1' },
      subAgents: { agents: [{ name: 'researcher', agentCardUrl: 'http://127.0.0.1:1/card' }] },
    });
    expect(own.fake).toEqual({ persona: 'You review drafts.', model: 'm-2' }); // the input is untouched
  });

  it('appends prompt text to the one the agent already has', () => {
    const plan = deriveLaunch(fake, own, {}, rt({ systemPrompt: '## Agents you can call\n- x' }));
    expect((plan.config.fake as { persona: string }).persona).toBe(
      'You review drafts.\n\n## Agents you can call\n- x',
    );
  });

  it('sets the prompt when the agent has none, and passes the config path and port to the wrapper', () => {
    const plan = deriveLaunch(fake, { fake: {} }, {}, rt({ systemPrompt: 'Hello' }));
    expect((plan.config.fake as { persona: string }).persona).toBe('Hello');
    expect(plan.args.slice(0, 4)).toEqual(['--config', '/cfg/config.json', '--port', '4100']);
  });

  it('lets overrides win over the agent config', () => {
    const plan = deriveLaunch(fake, { ...own, events: { transport: 'a2a' } }, {}, rt(), {
      events: { transport: 'http', httpUrl: 'http://127.0.0.1:1/agent-events' },
    });
    expect(plan.config.events).toEqual({
      transport: 'http',
      httpUrl: 'http://127.0.0.1:1/agent-events',
    });
  });

  it('reports a config without the backend section and an option the backend does not know', () => {
    const none = deriveLaunch(fake, { agentCard: {} }, {}, rt());
    expect(none.ok).toBe(false);
    expect(none.problems[0]).toMatchObject({ code: 'no_provider_section', path: 'fake' });
    const bad = deriveLaunch(fake, { fake: { nonsense: 1 } }, {}, rt());
    expect(bad.problems[0]).toMatchObject({ code: 'unknown_option', path: 'fake.nonsense' });
  });
});

describe('spawning from an agent config', () => {
  const runtime = (dir = tmp()) => {
    const catalog = new BackendRegistry();
    catalog.register(fakeBackend(), 'user');
    const rtm = new ProcessAgentRuntime({
      catalog,
      events: new InMemoryEventLog(new FakeClock()),
      ids: new SequentialIds(),
      clock: new FakeClock(),
      secrets: new StaticSecretResolver({}),
      dataDir: dir,
      resolveCommand: () => ({ command: process.execPath, args: [FAKE] }),
      ambientEnv: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
      restart: { max: 0, backoffMs: 5 },
      stopGraceMs: 1500,
    });
    runtimes.push(rtm);
    return rtm;
  };
  const debug = async (url: string) =>
    (await fetch(`${url}/debug`)).json() as Promise<{
      config: Record<string, Record<string, unknown>>;
      argv: string[];
    }>;

  it('starts an embedded config with the overrides applied, and the wrapper reads it with --config', async () => {
    const rtm = runtime();
    const agent = await rtm.spawn({
      definition: definition(),
      workspace: { mode: 'shared', key: 'run_1' },
      baseConfig: { json: { agentCard: { name: 'reviewer' }, fake: { persona: 'Review.' } } },
      systemPrompt: '## Agents you can call\n- researcher',
      overrides: { subAgents: { agents: [{ name: 'researcher', agentCardUrl: 'http://x/card' }] } },
    });
    const seen = await debug(agent.url);
    expect(seen.argv).toContain('--config');
    expect(seen.config.subAgents).toEqual({
      agents: [{ name: 'researcher', agentCardUrl: 'http://x/card' }],
    });
    expect(seen.config.fake?.persona).toBe('Review.\n\n## Agents you can call\n- researcher');
    expect(seen.config.agentCard).toEqual({ name: 'reviewer' });
  });

  it('writes the derived file next to a directory config, leaves the original alone, and removes it on stop', async () => {
    const rtm = runtime();
    const agentDir = tmp();
    const original = JSON.stringify({ fake: { persona: 'Original.' }, memory: { skills: ['a'] } });
    writeFileSync(join(agentDir, 'config.json'), original);

    const agent = await rtm.spawn({
      definition: definition(),
      workspace: { mode: 'shared', key: 'run_2' },
      baseConfig: { dir: agentDir },
      overrides: { events: { transport: 'http', httpHeaders: { Authorization: 'Bearer t' } } },
    });
    const derived = join(agentDir, `config.krama.${agent.id}.json`);
    expect((await debug(agent.url)).argv).toContain(derived);
    expect(JSON.parse(readFileSync(derived, 'utf8'))).toMatchObject({
      memory: { skills: ['a'] },
      events: { httpHeaders: { Authorization: 'Bearer t' } },
    });
    expect(readFileSync(join(agentDir, 'config.json'), 'utf8')).toBe(original);
    if (process.platform !== 'win32') expect(statSync(derived).mode & 0o777).toBe(0o600);

    await rtm.stop(agent.id);
    expect(existsSync(derived)).toBe(false);
    expect(readFileSync(join(agentDir, 'config.json'), 'utf8')).toBe(original);
  });

  it('refuses to start from an unreadable directory or a config the backend cannot use', async () => {
    const rtm = runtime();
    await expect(
      rtm.spawn({
        definition: definition(),
        workspace: { mode: 'shared', key: 'run_3' },
        baseConfig: { dir: join(tmp(), 'missing') },
      }),
    ).rejects.toMatchObject({ code: 'config_invalid' });
    const err = await rtm
      .spawn({
        definition: definition(),
        workspace: { mode: 'shared', key: 'run_3' },
        baseConfig: { json: { agentCard: {} } },
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentStartError);
    expect((err as AgentStartError).details.problems?.[0]?.code).toBe('no_provider_section');
  });
});
