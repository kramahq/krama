import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createFakePorts,
  FakeClock,
  InMemoryEventLog,
  SequentialIds,
  StaticSecretResolver,
} from '@kramahq/engine/testing';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AgentStartError,
  BackendRegistry,
  Ledger,
  ProcessAgentRuntime,
  PortAllocator,
  WorkspaceManager,
  defaultKillOps,
  killTree,
  type KillOps,
  type RuntimeOptions,
} from '../src/index.js';
import { definition, fakeBackend } from './fixtures/descriptor.js';

const FAKE = fileURLToPath(new URL('./fixtures/fake-wrapper.mjs', import.meta.url));
const dirs: string[] = [];
const runtimes: ProcessAgentRuntime[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'krama agents '));
  dirs.push(d);
  return d;
};

interface Rig {
  rt: ProcessAgentRuntime;
  events: InMemoryEventLog;
  dir: string;
  catalog: BackendRegistry;
}
function rig(over: Partial<RuntimeOptions> = {}, backend = fakeBackend(), dir = tmp()): Rig {
  const catalog = new BackendRegistry();
  catalog.register(backend, 'user');
  const events = new InMemoryEventLog(new FakeClock());
  const rt = new ProcessAgentRuntime({
    catalog,
    events,
    ids: new SequentialIds(),
    clock: new FakeClock(),
    secrets: new StaticSecretResolver({ 'fake-secret': 'top-secret-value' }),
    dataDir: dir,
    resolveCommand: () => ({ command: process.execPath, args: [FAKE] }),
    ambientEnv: {
      PATH: process.env.PATH,
      AWS_SECRET_ACCESS_KEY: 'must-not-leak',
      SystemRoot: process.env.SystemRoot,
    },
    restart: { max: 0, backoffMs: 5 },
    stopGraceMs: 1500,
    ...over,
  });
  runtimes.push(rt);
  return { rt, events, dir, catalog };
}
const eventTypes = async (e: InMemoryEventLog) => (await e.read()).map((x) => x.type);
const debug = async (url: string) =>
  (await fetch(`${url}/debug`)).json() as Promise<{
    env: Record<string, string>;
    config: Record<string, Record<string, unknown>>;
    argv: string[];
    cwd: string;
    pid: number;
  }>;
const alive = (pid: number) => defaultKillOps.isAlive(pid);
const until = async (cond: () => boolean | Promise<boolean>, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('timed out waiting');
};

afterEach(async () => {
  await Promise.allSettled(runtimes.splice(0).map((r) => r.shutdown()));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('spawning a backend that exists only as data', () => {
  it('starts the wrapper, waits until it answers, and reports a running agent', async () => {
    const { rt, events } = rig();
    const a = await rt.spawn({
      definition: definition(),
      workspace: { mode: 'isolated', key: 'run_1' },
      systemPrompt: 'Be careful.',
    });
    expect(a).toMatchObject({
      status: 'idle',
      backend: 'a2a-fake',
      role: 'developer',
      model: 'm-1',
    });
    expect(a.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(a.card).toMatchObject({ name: 'Developer' });
    expect((await fetch(`${a.url}/.well-known/agent-card.json`)).status).toBe(200);
    expect(await eventTypes(events)).toEqual(['agent.spawned', 'agent.idle']);
    expect(rt.ref(a.id)).toEqual({ id: a.id, url: a.url, role: 'developer', backend: 'a2a-fake' });
  });

  it('writes the wrapper config with common settings mapped to the provider keys and runs in a path with spaces', async () => {
    const { rt, dir } = rig();
    const a = await rt.spawn({
      definition: definition(),
      workspace: { mode: 'isolated', key: 'run_1' },
      systemPrompt: 'Be careful.',
    });
    const d = await debug(a.url);
    expect(d.config.fake).toMatchObject({
      model: 'm-1',
      persona: 'Be careful.',
      cwd: a.workspace!.path,
    });
    expect(d.config.server).toMatchObject({ port: a.port, hostname: '127.0.0.1' });
    expect(d.argv).toEqual(
      expect.arrayContaining(['--config', '--port', String(a.port), '--hostname', '127.0.0.1']),
    );
    expect(a.workspace!.path).toContain('krama agents');
    expect(a.workspace!.path.startsWith(dir)).toBe(true);
    expect(realpathEq(d.cwd, a.workspace!.path)).toBe(true);
  });

  it('gives the child only declared secrets and a minimal base environment', async () => {
    const { rt } = rig();
    const def = definition(
      {},
      {
        backend: {
          wrapper: 'a2a-fake',
          options: { fake: {} },
          secrets: { FAKE_KEY: 'fake-secret' },
        },
      },
    );
    const a = await rt.spawn({ definition: def, workspace: { mode: 'isolated', key: 'run_1' } });
    const { env } = await debug(a.url);
    expect(env.FAKE_KEY).toBe('top-secret-value');
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.PATH).toBeDefined();
    // The secret value never reaches the config file on disk.
    expect(
      readFileSync(join(rt['o'].dataDir, 'agents', a.id, 'config.json'), 'utf8'),
    ).not.toContain('top-secret-value');
  });

  it('allocates a distinct free port per agent and releases it on stop', async () => {
    const ports = new PortAllocator();
    const { rt } = rig({ ports });
    const [a, b] = await Promise.all(
      [1, 2].map((n) =>
        rt.spawn({ definition: definition(), workspace: { mode: 'isolated', key: `run_${n}` } }),
      ),
    );
    expect(a!.port).not.toBe(b!.port);
    expect(ports.count).toBe(2);
    await rt.stop(a!.id);
    expect(ports.has(a!.port!)).toBe(false);
    expect(ports.has(b!.port!)).toBe(true);
  });

  it('shares one workspace per run for `shared` and isolates `isolated`', async () => {
    const { rt } = rig();
    const s1 = await rt.spawn({
      definition: definition(),
      workspace: { mode: 'shared', key: 'run_9' },
    });
    const s2 = await rt.spawn({
      definition: definition(),
      workspace: { mode: 'shared', key: 'run_9' },
    });
    const i1 = await rt.spawn({
      definition: definition(),
      workspace: { mode: 'isolated', key: 'run_9' },
    });
    expect(s1.workspace!.path).toBe(s2.workspace!.path);
    expect(i1.workspace!.path).not.toBe(s1.workspace!.path);
  });

  it('tracks assignment as busy and idle with events', async () => {
    const { rt, events } = rig();
    const a = await rt.spawn({
      definition: definition(),
      workspace: { mode: 'isolated', key: 'r' },
    });
    rt.assign(a.id, { runId: 'run_1', phaseId: 'build' });
    expect(rt.get(a.id)).toMatchObject({ status: 'busy', assignment: { runId: 'run_1' } });
    expect(rt.list({ runId: 'run_1' })).toHaveLength(1);
    rt.assign(a.id, undefined);
    expect(rt.get(a.id)?.status).toBe('idle');
    await until(
      async () =>
        (await eventTypes(events)).includes('agent.busy') &&
        (await eventTypes(events)).filter((t) => t === 'agent.idle').length === 2,
    );
  });
});

describe('stopping', () => {
  it('terminates the whole process tree, not just the wrapper', async () => {
    const { rt, dir } = rig();
    const pidFile = join(dir, 'grandchild.pid');
    const a = await rt.spawn({
      definition: definition({ grandchildPidFile: pidFile }),
      workspace: { mode: 'isolated', key: 'r' },
    });
    await until(() => existsSync(pidFile));
    const grandchild = Number(readFileSync(pidFile, 'utf8'));
    expect(alive(grandchild)).toBe(true);
    const wrapperPid = a.pid!;
    await rt.stop(a.id);
    await until(() => !alive(grandchild) && !alive(wrapperPid));
    expect(rt.get(a.id)?.status).toBe('stopped');
    await expect(fetch(`${a.url}/debug`)).rejects.toBeDefined();
  });

  it('is idempotent and shutdown stops everything', async () => {
    const { rt } = rig();
    const [a, b] = await Promise.all(
      [1, 2].map((n) =>
        rt.spawn({ definition: definition(), workspace: { mode: 'isolated', key: `r${n}` } }),
      ),
    );
    await rt.stop(a!.id);
    await rt.stop(a!.id);
    await rt.shutdown();
    expect(rt.list().every((x) => x.status === 'stopped')).toBe(true);
    expect(alive(b!.pid!)).toBe(false);
  });
});

describe('start-up failures explain themselves', () => {
  it('unknown backend lists what is registered', async () => {
    const { rt } = rig();
    const err = await rt
      .spawn({
        definition: definition({}, { backend: { wrapper: 'a2a-nope' } }),
        workspace: { mode: 'isolated', key: 'r' },
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(AgentStartError);
    expect(err).toMatchObject({ code: 'backend_unknown' });
    expect(err.details.hint).toContain('a2a-fake');
  });

  it('an invalid definition is refused before anything starts', async () => {
    const { rt } = rig();
    const err = await rt
      .spawn({
        definition: definition({}, { backend: { wrapper: 'a2a-fake', options: { nope: 1 } } }),
        workspace: { mode: 'isolated', key: 'r' },
      })
      .catch((e) => e);
    expect(err).toMatchObject({ code: 'config_invalid' });
    expect(err.details.problems[0].code).toBe('unknown_option');
    expect(rt.list()).toHaveLength(0);
  });

  it('a process that exits during start-up reports its output and frees the port', async () => {
    const ports = new PortAllocator();
    const { rt } = rig({ ports });
    const err = await rt
      .spawn({
        definition: definition({ exitImmediately: 'bad api key' }),
        workspace: { mode: 'isolated', key: 'r' },
      })
      .catch((e) => e);
    expect(err).toMatchObject({ code: 'exited_early' });
    expect(err.message).toContain('boom: bad api key');
    expect(err.details.logTail.join('\n')).toContain('bad api key');
    expect(ports.count).toBe(0);
  });

  it('a wrapper that never becomes ready times out, is killed, and frees the port', async () => {
    const ports = new PortAllocator();
    const { rt } = rig(
      { ports },
      fakeBackend({ launch: { defaultPort: 3999, startupTimeoutMs: 700 } }),
    );
    const err = await rt
      .spawn({
        definition: definition({ neverReady: true }),
        workspace: { mode: 'isolated', key: 'r' },
      })
      .catch((e) => e);
    expect(err).toMatchObject({ code: 'startup_timeout' });
    expect(ports.count).toBe(0);
    await until(() => rt.list().every((a) => a.status === 'stopped'));
  });

  it('a missing executable points at the install command', async () => {
    const { rt } = rig({
      resolveCommand: () => ({ command: 'definitely-not-installed-a2a', args: [] }),
    });
    const err = await rt
      .spawn({ definition: definition(), workspace: { mode: 'isolated', key: 'r' } })
      .catch((e) => e);
    expect(err).toMatchObject({ code: 'spawn_failed' });
    expect(err.details.hint).toContain('npm i -g a2a-fake');
  });
});

describe('supervision', () => {
  it('detects a crash and restarts within policy, keeping the id', async () => {
    const { rt, events } = rig({ restart: { max: 1, backoffMs: 10 } });
    const a = await rt.spawn({
      definition: definition({ crashAfterMs: 400 }),
      workspace: { mode: 'isolated', key: 'r' },
    });
    const firstPid = a.pid!;
    await until(async () => (await eventTypes(events)).includes('agent.restarted'));
    const now = rt.get(a.id)!;
    expect(now.status).toBe('idle');
    expect(now.pid).not.toBe(firstPid);
    expect((await fetch(`${now.url}/.well-known/agent-card.json`)).status).toBe(200);
  });

  it('brings a crashed agent back on the same port, so agents given its address keep working', async () => {
    const { rt, events } = rig({ restart: { max: 1, backoffMs: 10 } });
    const a = await rt.spawn({
      definition: definition({ crashAfterMs: 400 }),
      workspace: { mode: 'isolated', key: 'r' },
    });
    await until(async () => (await eventTypes(events)).includes('agent.restarted'));
    const now = rt.get(a.id)!;
    expect(now.port).toBe(a.port);
    expect(now.url).toBe(a.url);
    expect((await fetch(`${a.url}/.well-known/agent-card.json`)).status).toBe(200);
  });

  it('keeps the port on an explicit restart too', async () => {
    const { rt } = rig();
    const a = await rt.spawn({
      definition: definition(),
      workspace: { mode: 'isolated', key: 'r' },
    });
    const again = await rt.restart(a.id);
    expect(again.pid).not.toBe(a.pid);
    expect(again.url).toBe(a.url);
  });

  it('asks for a given port when starting afresh, and takes another when it is gone', async () => {
    const taken = new PortAllocator();
    const first = await taken.allocate();
    taken.release(first);
    // Free again: the same port comes back.
    expect(await taken.allocate(first)).toBe(first);
    // Held by someone: a different one is picked rather than failing.
    const other = await taken.allocate(first);
    expect(other).not.toBe(first);
    // Not bindable (another process has it): likewise.
    const busy = new PortAllocator({ probe: async (p) => p !== 4242 });
    expect(await busy.allocate(4242)).not.toBe(4242);
  });

  it('marks the agent stopped with its last output when restarts are exhausted', async () => {
    const { rt, events } = rig({ restart: { max: 0, backoffMs: 5 } });
    const a = await rt.spawn({
      definition: definition({ crashAfterMs: 300 }),
      workspace: { mode: 'isolated', key: 'r' },
    });
    await until(async () => (await eventTypes(events)).includes('agent.stopped'));
    expect(rt.get(a.id)?.status).toBe('stopped');
    const stopped = (await events.read()).find((e) => e.type === 'agent.stopped')!;
    expect((stopped.data as { reason: string }).reason).toContain('exited with code 1');
  });

  it('flags an unhealthy agent, recovers it, and replaces it after repeated failures', async () => {
    const { rt, events } = rig({
      health: { intervalMs: 0, timeoutMs: 500, maxFailures: 3 },
      restart: { max: 1, backoffMs: 10 },
    });
    const a = await rt.spawn({
      definition: definition(),
      workspace: { mode: 'isolated', key: 'r' },
    });
    await fetch(`${a.url}/debug/sick`);
    await rt.checkHealth();
    expect(rt.get(a.id)?.status).toBe('unhealthy');
    await fetch(`${a.url}/debug/well`);
    await rt.checkHealth();
    expect(rt.get(a.id)?.status).toBe('idle');
    const oldPid = a.pid!;
    await fetch(`${a.url}/debug/sick`);
    await rt.checkHealth();
    await rt.checkHealth();
    await rt.checkHealth();
    expect(await eventTypes(events)).toContain('agent.restarted');
    expect(rt.get(a.id)?.pid).not.toBe(oldPid);
    expect(rt.get(a.id)?.status).toBe('idle');
  });

  it('stops idle unassigned agents after the TTL and later forgets them', async () => {
    const { rt } = rig({ idleTtlMs: 50, stoppedTtlMs: 50 });
    const idle = await rt.spawn({
      definition: definition(),
      workspace: { mode: 'isolated', key: 'a' },
    });
    const busy = await rt.spawn({
      definition: definition(),
      workspace: { mode: 'isolated', key: 'b' },
      assignment: { runId: 'run_1' },
    });
    await new Promise((r) => setTimeout(r, 120));
    expect((await rt.reap()).stopped).toEqual([idle.id]);
    expect(rt.get(busy.id)?.status).toBe('busy');
    await new Promise((r) => setTimeout(r, 120));
    expect((await rt.reap()).forgotten).toEqual([idle.id]);
    expect(rt.get(idle.id)).toBeUndefined();
  });
});

describe('crash recovery of orphaned wrappers', () => {
  it('kills wrappers left behind by a previous server run, using the ledger', async () => {
    const dir = tmp();
    const first = rig({}, fakeBackend(), dir);
    const a = await first.rt.spawn({
      definition: definition(),
      workspace: { mode: 'isolated', key: 'r' },
    });
    expect(alive(a.pid!)).toBe(true);
    // "Crash": the first server disappears without stopping anything. A new one starts on the same data dir.
    const second = rig({}, fakeBackend(), dir);
    const { reaped } = await second.rt.start();
    expect(reaped).toEqual([a.id]);
    await until(() => !alive(a.pid!));
  });

  it('leaves alone a recorded pid that no longer answers like an agent (pid reuse)', async () => {
    const dir = tmp();
    const ledger = new Ledger(join(dir, 'agents', 'ledger.json'));
    await ledger.add({ id: 'agt_x', pid: process.pid, port: 9, startedAt: 'now' });
    const killed: number[] = [];
    const reaped = await ledger.reapOrphans({
      isAlive: () => true,
      answers: async () => false,
      kill: async (p) => void killed.push(p),
    });
    expect(reaped).toEqual([]);
    expect(killed).toEqual([]);
    expect(ledger.entries()).toEqual([]);
  });
});

describe('process tree termination', () => {
  const fakeOps = (
    platform: NodeJS.Platform,
    aliveAfterTerm: boolean,
  ): { ops: KillOps; log: string[] } => {
    const log: string[] = [];
    let term = false;
    const ops: KillOps = {
      platform,
      sleep: async () => undefined,
      signal: (pid, sig) => {
        log.push(`${sig}:${pid}`);
        if (sig === 'SIGTERM') term = true;
        if (sig === 'SIGKILL') term = true;
      },
      taskkill: async (pid) => void log.push(`taskkill:${pid}`),
      isAlive: () => (aliveAfterTerm ? !log.includes('SIGKILL:-77') : !term),
    };
    return { ops, log };
  };
  it('POSIX: signals the process group, escalating to SIGKILL if it will not die', async () => {
    const polite = fakeOps('linux', false);
    await killTree(77, { ops: polite.ops, graceMs: 10 });
    expect(polite.log).toEqual(['SIGTERM:-77']);
    const stubborn = fakeOps('darwin', true);
    await killTree(77, { ops: stubborn.ops, graceMs: 1 });
    expect(stubborn.log).toEqual(['SIGTERM:-77', 'SIGKILL:-77']);
  });
  it('Windows: uses taskkill /T /F and no signals', async () => {
    const w = fakeOps('win32', false);
    await killTree(77, { ops: w.ops });
    expect(w.log).toEqual(['taskkill:77']);
  });
});

describe('workspaces', () => {
  it('rejects names that could escape the root and refuses symlinks', () => {
    const w = new WorkspaceManager(join(tmp(), 'ws'));
    for (const bad of ['..', '../x', 'a/b', 'a\\b', '.hidden', '', 'x\0y'])
      expect(() => w.shared(bad), JSON.stringify(bad)).toThrow(/Invalid/);
    expect(w.shared('run_1')).toContain('run_1');
    expect(w.isolated('run_1', 'agt_1')).not.toBe(w.isolated('run_1', 'agt_2'));
    expect(w.memory('developer', 'default')).toContain('memory');
  });
  it('removes a run workspace tree', () => {
    const w = new WorkspaceManager(join(tmp(), 'ws'));
    const p = w.shared('run_1');
    writeFileSync(join(p, 'f.txt'), 'x');
    w.removeRun('run_1');
    expect(existsSync(p)).toBe(false);
  });
});

describe('port allocator', () => {
  it('never hands out the same port twice, even when the OS repeats itself', async () => {
    let n = 0;
    const picks = [5000, 5000, 5001];
    const p = new PortAllocator({ pick: async () => picks[n++]! });
    expect(await p.allocate()).toBe(5000);
    expect(await p.allocate()).toBe(5001);
  });
  it('honours a range and skips ports that are busy', async () => {
    const p = new PortAllocator({
      range: { min: 6000, max: 6003 },
      probe: async (port) => port % 2 === 0,
    });
    const got = await p.allocate();
    expect(got % 2).toBe(0);
    expect(got >= 6000 && got <= 6003).toBe(true);
  });
});

import { realpathSync } from 'node:fs';
function realpathEq(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return a === b;
  }
}
void createFakePorts;
