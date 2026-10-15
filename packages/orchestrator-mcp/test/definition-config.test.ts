import type { BackendDescriptor } from '@kramahq/contract';
import { afterEach, describe, expect, it } from 'vitest';
import { pack } from './rig.js';
import {
  call,
  newRun,
  playOrchestrator,
  statusOf,
  system,
  until,
  worker,
  type System,
} from './runner-rig.js';

const live: System[] = [];
afterEach(async () => {
  await Promise.allSettled(live.splice(0).map((s) => s.stop()));
});

describe('Git-installed definition configs', () => {
  it.each(['native', 'krama'] as const)(
    'preserves original configs for the orchestrator and workers (%s)',
    async (mode) => {
      const configs = new Map<string, Record<string, unknown>>();
      const s = await system(
        undefined,
        { defaultDelegation: mode },
        [pack()],
        false,
        undefined,
        (definition) => {
          const config = {
            agentCard: {
              name: definition.name,
              skills: [{ id: 'work', name: 'Work', description: 'Work' }],
            },
            [definition.backend.wrapper === 'a2a-codex' ? 'codex' : 'claude']: {
              model: 'pinned-model',
            },
            memory: { instructions: '/pinned/instructions.md' },
          };
          configs.set(definition.id, config);
          return { json: config };
        },
      );
      live.push(s);
      const backends = ['claude', 'codex'].map(
        (providerKey) =>
          ({
            id: `a2a-${providerKey}`,
            providerKey,
            mapping: { model: 'model' },
          }) as BackendDescriptor,
      );
      s.p.backends = { list: () => backends, get: (id) => backends.find((b) => b.id === id) };
      const runId = await newRun(s);
      s.p.gateway.queue('author', worker('Draft'));
      s.p.gateway.queue('reviewer', worker('Approved'));
      s.p.gateway.queue(
        'orchestrator',
        playOrchestrator(s, async (client) => {
          for (const [phaseId, role] of [
            ['draft', 'author'],
            ['review', 'reviewer'],
          ]) {
            if (mode === 'krama')
              await call(client, 'delegate_to_agent', { phaseId, role, task: 'Work' });
            await call(client, 'record_phase_outcome', {
              phaseId,
              status: 'success',
              reason: 'done',
              gating: 'continue',
            });
          }
        }),
      );
      await s.runner.start(runId);
      await until(async () => (await statusOf(s, runId)) === 'awaiting_decision');
      expect(s.p.agents.spawned.map((spec) => spec.definition.id).sort()).toEqual([
        'author/default',
        'orchestrator/default',
        'reviewer/default',
      ]);
      for (const spec of s.p.agents.spawned)
        expect(spec.baseConfig).toEqual({ json: configs.get(spec.definition.id) });
      expect(s.errors).toEqual([]);
    },
  );
});
