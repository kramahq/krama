import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FakeClock,
  InMemoryEventLog,
  SequentialIds,
  StaticSecretResolver,
} from '@kramahq/engine/testing';
import { afterAll, describe, expect, it } from 'vitest';
import { A2AGateway, BackendRegistry, ProcessAgentRuntime } from '../src/index.js';
import { definition } from './fixtures/descriptor.js';

/**
 * Real-wrapper smoke test. Costs a few tokens, so it never runs in default CI.
 *
 *   KRAMA_SMOKE=1 KRAMA_SMOKE_BACKEND=a2a-claude ANTHROPIC_API_KEY=... pnpm -F @kramahq/agents test smoke
 *
 * The wrapper must be installed (`npm i -g a2a-claude`); `krama doctor` checks this.
 */
const enabled = process.env.KRAMA_SMOKE === '1';
const backend = process.env.KRAMA_SMOKE_BACKEND ?? 'a2a-claude';

describe.skipIf(!enabled)(`smoke: ${backend}`, () => {
  const dir = mkdtempSync(join(tmpdir(), 'krama smoke '));
  const clock = new FakeClock();
  const runtime = new ProcessAgentRuntime({
    catalog: BackendRegistry.withBuiltins(),
    events: new InMemoryEventLog(clock),
    ids: new SequentialIds(),
    clock,
    secrets: new StaticSecretResolver(),
    dataDir: dir,
    ambientEnv: process.env,
    restart: { max: 0, backoffMs: 0 },
  });
  afterAll(async () => {
    await runtime.shutdown();
    rmSync(dir, { recursive: true, force: true });
  });

  it('starts the real wrapper, answers a prompt over A2A, reports usage when available, and stops cleanly', async () => {
    const def = definition(
      {},
      {
        backend: {
          wrapper: backend,
          ...(process.env.KRAMA_SMOKE_MODEL ? { model: process.env.KRAMA_SMOKE_MODEL } : {}),
          options: backend === 'a2a-codex' ? { skipGitRepoCheck: true } : {},
        },
      },
    );
    const agent = await runtime.spawn({
      definition: def,
      workspace: { mode: 'isolated', key: 'smoke' },
    });
    expect(agent.status).toBe('idle');

    const gw = new A2AGateway();
    const events = [];
    for await (const e of gw.send(runtime.ref(agent.id)!, {
      text: 'Reply with exactly the single word: pong',
      timeoutMs: 150_000,
    }))
      events.push(e);

    const last = events.filter((e) => e.kind === 'state').at(-1);
    expect(last).toMatchObject({ state: 'completed' });
    const answer = events
      .filter((e) => e.kind === 'artifact')
      .map((e) => (e.kind === 'artifact' && e.bytes ? new TextDecoder().decode(e.bytes) : ''))
      .join(' ')
      .toLowerCase();
    expect(answer).toContain('pong');
    console.log(
      `[smoke] ${backend}: ${events.length} events, usage=${JSON.stringify(events.find((e) => e.kind === 'usage') ?? 'not reported')}`,
    );

    await runtime.stop(agent.id);
    expect(runtime.get(agent.id)?.status).toBe('stopped');
  }, 240_000);
});
