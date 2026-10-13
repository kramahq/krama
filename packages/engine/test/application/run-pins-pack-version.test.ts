import { describe, expect, it } from 'vitest';
import { createEngine } from '../../src/index.js';
import { authorReviewerPack, createFakePorts } from '../../src/testing/index.js';
import { priya } from './helpers.js';

describe('a run keeps the pack version it started with', () => {
  it('asks for its own commit when it reads the pack again, and not for whatever is current', async () => {
    const v1 = authorReviewerPack();
    const v2 = {
      ...v1,
      version: '2.0.0',
      source: { ...v1.source, sha: 'b'.repeat(40) },
    };
    const p = createFakePorts([v1]);
    const engine = createEngine(p, {}, { delivery: { sleep: async () => undefined } });
    const run = await engine.runs.create({ packId: v1.id, input: { text: 'go' } }, priya);
    expect(run.pack).toMatchObject({ version: v1.version, sha: v1.source.sha });

    // The pack is updated while the run is still going.
    const asked: (string | undefined)[] = [];
    const get = p.packs.get.bind(p.packs);
    p.packs.get = async (id: string, sha?: string) => {
      asked.push(sha);
      return get(id, sha);
    };
    (p.packs as unknown as { packs: unknown[] }).packs.push(v2);

    expect(await p.packs.get(v1.id)).toMatchObject({ version: '2.0.0' });
    asked.length = 0;
    // This pack declares its own phases, so the plan is refused; what matters is which version was read to decide.
    await engine.runs.setPlan(run.id, [{ id: 'one', label: 'One' }]).catch(() => undefined);
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every((s) => s === v1.source.sha)).toBe(true);
  });
});
