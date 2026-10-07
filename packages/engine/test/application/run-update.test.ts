import { describe, expect, it } from 'vitest';
import { VersionConflictError } from '../../src/index.js';
import { arjun, priya, setup, types } from './helpers.js';

const input = { text: 'notes' };

describe('changing a run (PATCH)', () => {
  it('changes title, labels, mode and the budget cap, records it and announces it', async () => {
    const { engine, p } = setup();
    const run = await engine.runs.create({ packId: 'pack_demo', input }, priya);

    const out = await engine.runs.update(
      run.id,
      { title: 'New title', labels: ['a', 'a', 'b'], mode: 'autopilot', budget: { max: 99 } },
      arjun,
    );

    expect(out.run).toMatchObject({ title: 'New title', labels: ['a', 'b'], mode: 'autopilot' });
    expect(out.run.budget.max).toEqual({ amount: 99, currency: 'USD' });
    expect(out.version).toBe((await p.store.runs.get(run.id))!.version);
    expect((await types(p, run.id)).filter((t) => t === 'run.updated')).toHaveLength(1);

    const audit = (await p.store.audit.list()).items.find((a) => a.action === 'run.updated');
    expect(audit).toMatchObject({
      actor: { id: 'u_arjun' },
      subject: { id: run.id },
      detail: { changed: ['title', 'labels', 'mode', 'budget'] },
    });
  });

  it('leaves what is not in the patch alone, and lets the budget warning fire again', async () => {
    const { engine, p } = setup();
    const run = await engine.runs.create({ packId: 'pack_demo', input, labels: ['keep'] }, priya);
    const cur = (await p.store.runs.get(run.id))!;
    await p.store.runs.put({ ...cur.value, warned: true }, cur.version);

    const out = await engine.runs.update(run.id, { mode: 'autopilot' }, priya);
    expect(out.run.labels).toEqual(['keep']);
    expect(out.run.title).toBe(run.title);
    expect((await p.store.runs.get(run.id))!.value.warned).toBe(true);

    await engine.runs.update(run.id, { budget: { max: 5 } }, priya);
    expect((await p.store.runs.get(run.id))!.value.warned).toBe(false);
  });

  it('applies only against the version the caller saw', async () => {
    const { engine, p } = setup();
    const run = await engine.runs.create({ packId: 'pack_demo', input }, priya);
    const seen = (await p.store.runs.get(run.id))!.version;

    const first = await engine.runs.update(run.id, { title: 'one' }, priya, seen);
    expect(first.version).toBe(seen + 1);
    await expect(engine.runs.update(run.id, { title: 'two' }, priya, seen)).rejects.toBeInstanceOf(
      VersionConflictError,
    );
    expect((await p.store.runs.get(run.id))!.value.run.title).toBe('one');
  });

  it('refuses an unknown run', async () => {
    const { engine } = setup();
    await expect(engine.runs.update('run_nope', { title: 'x' }, priya)).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});
