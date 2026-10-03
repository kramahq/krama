import { describe, expect, it } from 'vitest';
import { runDemo } from '../src/demo/run.js';

// These start real child processes (the scripted agents) over a real embedded database, so they are slow on cold CI.
const SLOW = 120_000;

const quiet = { approve: 'auto' as const, out: () => undefined, timeoutMs: 100_000 };
const tokens = (u: { unit: string; quantity: number }[]) =>
  u.find((x) => x.unit === 'tokens')?.quantity ?? 0;

describe('the walking skeleton', () => {
  it(
    'runs a two-role pack to completion with the orchestrator calling workers itself (native)',
    async () => {
      const r = await runDemo({ ...quiet, mode: 'native' });
      expect(r.status).toBe('completed');
      // The reviewer asks for changes once, so both phases take two rounds.
      expect(r.phases).toEqual([
        { id: 'draft', status: 'completed', iteration: 2 },
        { id: 'review', status: 'completed', iteration: 2 },
      ]);
      const text = r.timeline.join('\n');
      expect(text).toContain('author (sub-agent)');
      expect(text).not.toContain('delegate_to_agent');
      expect(text).toContain('decision requested: Publish approval');
      expect(text).toContain('run completed');
      // Workers are called directly, so only the orchestrator's own usage reaches Krama.
      expect(tokens(r.orchestratorUsage)).toBe(560);
      expect(r.workerUsage).toEqual([]);
    },
    SLOW,
  );

  it(
    'runs the same pack with Krama relaying every delegation (krama) and sees worker usage per step',
    async () => {
      const r = await runDemo({ ...quiet, mode: 'krama' });
      expect(r.status).toBe('completed');
      expect(r.phases.map((p) => [p.id, p.status, p.iteration])).toEqual([
        ['draft', 'completed', 2],
        ['review', 'completed', 2],
      ]);
      const text = r.timeline.join('\n');
      expect(text).toContain('delegate_to_agent');
      expect(text).toContain('step completed in review');
      expect(tokens(r.orchestratorUsage)).toBe(560);
      // 2 drafts (200 each) + 2 reviews (190 each)
      expect(tokens(r.workerUsage)).toBe(780);
    },
    SLOW,
  );
});
