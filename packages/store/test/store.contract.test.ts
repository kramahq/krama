import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEngine, VersionConflictError, type RunRecord } from '@kramahq/engine';
import {
  authorReviewerPack,
  createFakePorts,
  eventLogContract,
  sampleRun,
  storeContract,
} from '@kramahq/engine/testing';
import { afterAll, describe, expect, it } from 'vitest';
import { openPglite, openPostgres, type OpenedStore } from '../src/index.js';

const open: OpenedStore[] = [];
const track = async (p: Promise<OpenedStore>) => {
  const o = await p;
  open.push(o);
  return o;
};
afterAll(async () => {
  await Promise.all(open.map((o) => o.close()));
});

describe('PGlite (in-memory)', () => {
  storeContract({ describe, it, expect } as never, async () => (await track(openPglite())).store);
});

// Same suite against hosted Postgres. Set KRAMA_TEST_POSTGRES_URL (CI provides a service container).
const pgUrl = process.env.KRAMA_TEST_POSTGRES_URL;
describe.skipIf(!pgUrl)('Postgres', () => {
  storeContract({ describe, it, expect } as never, async () => {
    const o = await track(openPostgres(pgUrl!));
    await o.db.execute(
      (await import('drizzle-orm')).sql.raw(
        'truncate runs, decisions, steps, projects, artifacts, audit, usage_entries, memory_records restart identity',
      ),
    );
    return o.store;
  });
});

describe('PGlite event log', () => {
  eventLogContract(
    { describe, it, expect } as never,
    async (o) =>
      (await track(openPglite(undefined, { retainCount: o?.retain ?? 100_000, retainMs: 0 })))
        .events,
    { supportsRetention: true },
  );
});

describe.skipIf(!pgUrl)('Postgres event log', () => {
  eventLogContract(
    { describe, it, expect } as never,
    async (o) => {
      const opened = await track(
        openPostgres(pgUrl!, { retainCount: o?.retain ?? 100_000, retainMs: 0 }),
      );
      await opened.db.execute(
        (await import('drizzle-orm')).sql.raw('truncate events restart identity'),
      );
      return opened.events;
    },
    { supportsRetention: true },
  );
});

describe('persistence', () => {
  it('survives a restart, including in a data directory whose path has spaces', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'krama store with spaces-'));
    try {
      const a = await openPglite(dir);
      expect(a.applied).toEqual(['0000_init', '0001_events', '0002_audit_ledger']);
      await a.store.runs.put(sampleRun('run_1'));
      await a.store.audit.append({
        id: 'aud_1',
        at: '2026-10-03T00:00:00.000Z',
        actor: { type: 'user', id: 'u1' },
        action: 'x',
        subject: { type: 'run', id: 'run_1' },
      });
      await a.events.append({
        type: 'run.created',
        subject: { type: 'run', id: 'run_1' },
        runId: 'run_1' as never,
        actor: { type: 'user', id: 'u1' },
        data: { status: 'planning' },
      });
      await a.close();

      const b = await openPglite(dir);
      expect(b.applied).toEqual([]); // migrations are idempotent
      expect((await b.store.runs.get('run_1'))?.value.run.title).toBe('Run run_1');
      expect((await b.store.audit.list()).items).toHaveLength(1);
      // Events survive a restart with their cursor, actor and data; new events continue the sequence.
      expect(await b.events.read()).toEqual([
        expect.objectContaining({
          id: '000000001',
          type: 'run.created',
          runId: 'run_1',
          actor: { type: 'user', id: 'u1' },
          data: { status: 'planning' },
        }),
      ]);
      expect(
        (
          await b.events.append({
            type: 'run.updated',
            subject: { type: 'run', id: 'run_1' },
            data: {},
          })
        ).id,
      ).toBe('000000002');
      await b.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('starts quickly once the data directory exists', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'krama-start-'));
    try {
      await (await openPglite(dir)).close();
      const t = performance.now();
      const o = await openPglite(dir);
      const ms = performance.now() - t;
      await o.close();
      expect(ms).toBeLessThan(30_000); // generous: CI runners (Windows) start the WASM database slowly
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('concurrency', () => {
  it('lets exactly one of many concurrent writers win an optimistic update', async () => {
    const { store } = await track(openPglite());
    const v1 = await store.runs.put(sampleRun('run_1'));
    const attempts = await Promise.allSettled(
      Array.from({ length: 12 }, (_, i) =>
        store.runs.put({ ...v1.value, run: { ...v1.value.run, title: `writer ${i}` } }, v1.version),
      ),
    );
    expect(attempts.filter((a) => a.status === 'fulfilled')).toHaveLength(1);
    expect(
      attempts
        .filter((a) => a.status === 'rejected')
        .every((a) => (a as PromiseRejectedResult).reason instanceof VersionConflictError),
    ).toBe(true);
    expect((await store.runs.get('run_1'))?.version).toBe(2);
  });

  it('serialises concurrent transactions without losing updates', async () => {
    const { store } = await track(openPglite());
    await store.runs.put(sampleRun('run_1', { pendingDecisions: 0 }));
    const bump = () =>
      store.transaction(async (tx) => {
        const cur = (await tx.runs.get('run_1'))!;
        const rec: RunRecord = structuredClone(cur.value);
        rec.run.pendingDecisions += 1;
        await tx.runs.put(rec, cur.version);
      });
    await Promise.all(Array.from({ length: 10 }, bump));
    expect((await store.runs.get('run_1'))?.value.run.pendingDecisions).toBe(10);
  });

  it('reports the current version in a conflict', async () => {
    const { store } = await track(openPglite());
    const v1 = await store.runs.put(sampleRun('run_1'));
    await store.runs.put(v1.value, v1.version);
    await expect(store.runs.put(v1.value, v1.version)).rejects.toMatchObject({
      expected: 1,
      actual: 2,
    });
    await expect(store.runs.put(sampleRun('run_1'))).rejects.toMatchObject({
      expected: undefined,
      actual: 2,
    });
  });
});

describe('engine on the real store', () => {
  it('runs a full plan → gate → resolve → complete on PGlite', async () => {
    const { store } = await track(openPglite());
    const p = { ...createFakePorts([authorReviewerPack()]), store };
    const engine = createEngine(p);
    const me = { type: 'user' as const, id: 'u1', name: 'U1' };
    const run = await engine.runs.create({ packId: 'pack_demo', input: { text: 'x' } }, me);
    await engine.runs.plan(run.id);
    const ok = { status: 'success' as const, reason: 'fine', gating: 'continue' as const };
    await engine.runs.recordPhaseOutcome(run.id, 'draft', ok);
    const gated = await engine.runs.recordPhaseOutcome(run.id, 'review', ok);
    expect(gated.status).toBe('awaiting_decision');
    const dec = (await store.decisions.list({ runId: run.id, status: ['pending'] })).items[0]!.value
      .decision;
    await engine.decisions.resolve(dec.id, { optionId: 'approve' }, me);
    const done = (await store.runs.get(run.id))!.value.run;
    expect(done.status).toBe('completed');
    expect((await store.audit.list()).items.map((a) => a.action)).toContain('decision.resolved');
  });
});

describe('memory placeholder', () => {
  it('stores and searches records by scope, status, tag and text', async () => {
    const o = await track(openPglite());
    const rec = (id: string, over: object) =>
      ({
        id,
        scope: { type: 'project', id: 'proj_1' },
        type: 'semantic',
        content: 'Use make test-integration',
        tags: ['testing'],
        status: 'active',
        trust: 'trusted',
        confidence: { initial: 1, current: 1 },
        provenance: { method: 'human' },
        contentHash: 'h',
        version: 1,
        access: { read: [], write: [] },
        createdAt: `2026-10-0${id.slice(-1)}T00:00:00.000Z`,
        updatedAt: 't',
        links: {},
        ...over,
      }) as never;
    await o.memory.put(rec('mem_1', {}));
    await o.memory.put(
      rec('mem_2', { status: 'proposed', tags: ['deploy'], content: 'Deploys need two approvers' }),
    );
    await o.memory.put(rec('mem_3', { scope: { type: 'org', id: 'org_1' } }));
    expect(
      (await o.memory.search({ scope: { type: 'project', id: 'proj_1' } })).items,
    ).toHaveLength(2);
    expect((await o.memory.search({ status: ['proposed'] })).items).toHaveLength(1);
    expect((await o.memory.search({ tag: 'deploy' })).items[0]?.value.id).toBe('mem_2');
    expect((await o.memory.search({ q: 'two approvers' })).items).toHaveLength(1);
  });
});
