import type { Decision, Run } from '@kramahq/contract';
import { openDecision } from '../domain/decision.js';
import {
  CursorGoneError,
  VersionConflictError,
  type ArtifactStore,
  type EventLog,
  type RunRecord,
  type Store,
} from '../ports/index.js';

/** The slice of a test framework the suites need; vitest's `describe`, `it` and `expect` satisfy it. */
export interface Expectation {
  toBe(v: unknown): void;
  toEqual(v: unknown): void;
  toMatchObject(v: unknown): void;
  toBeUndefined(): void;
  toBeDefined(): void;
  toHaveLength(n: number): void;
  toBeGreaterThan(n: number): void;
  toContain(v: unknown): void;
  not: { toBe(v: unknown): void };
  rejects: { toThrow(e?: unknown): Promise<void> };
}
export interface Harness {
  describe(name: string, fn: () => void): void;
  it(name: string, fn: () => unknown): void;
  expect(v: unknown): Expectation;
}

const at = '2026-10-03T09:00:00.000Z';
const actor = { type: 'user', id: 'u1', name: 'U1' } as const;

export const sampleRun = (id: string, over: Partial<Run> = {}): RunRecord => ({
  run: {
    id: id as Run['id'],
    title: `Run ${id}`,
    input: { text: 'x' },
    pack: { id: 'pack_a', version: '1.0.0', sha: 'abc' },
    status: 'running',
    mode: 'review',
    orchestrator: { definitionId: 'orchestrator/default', backend: 'a2a-claude' },
    budget: { max: { amount: 10, currency: 'USD' }, spent: null, warnAtPct: 80, onExceed: 'pause' },
    currentPhaseIds: [],
    pendingDecisions: 0,
    trigger: { type: 'manual' },
    labels: [],
    createdBy: actor,
    createdAt: at,
    updatedAt: at,
    links: {},
    ...over,
  },
  loops: {},
});

const sampleDecision = (id: string, runId: string, over: Partial<Decision> = {}) =>
  openDecision({
    decision: {
      id: id as Decision['id'],
      kind: 'approval',
      runId: runId as Run['id'],
      title: 'Approve',
      question: 'Ok?',
      options: [
        { id: 'approve', label: 'Approve', style: 'primary' },
        { id: 'reject', label: 'Reject', style: 'danger' },
      ],
      createdAt: at,
      links: {},
      ...over,
    },
  });

const rejects = async (h: Harness, p: Promise<unknown>, type: unknown) =>
  h.expect(p).rejects.toThrow(type);

/** Every `Store` adapter (in-memory, PGlite, Postgres) must pass this suite. */
export function storeContract(h: Harness, make: () => Store | Promise<Store>): void {
  const { describe, it, expect } = h;
  describe('Store contract', () => {
    describe('runs', () => {
      it('creates, reads back and versions', async () => {
        const s = await make();
        const v1 = await s.runs.put(sampleRun('run_1'));
        expect(v1.version).toBe(1);
        const got = await s.runs.get('run_1');
        expect(got?.value.run.title).toBe('Run run_1');
        const v2 = await s.runs.put(
          { ...v1.value, run: { ...v1.value.run, title: 'Renamed' } },
          v1.version,
        );
        expect(v2.version).toBe(2);
        expect((await s.runs.get('run_1'))?.value.run.title).toBe('Renamed');
      });
      it('returns undefined for unknown ids', async () => {
        expect(await (await make()).runs.get('run_nope')).toBeUndefined();
      });
      it('rejects creating twice and stale versions (optimistic concurrency)', async () => {
        const s = await make();
        const v1 = await s.runs.put(sampleRun('run_1'));
        await rejects(h, s.runs.put(sampleRun('run_1')), VersionConflictError);
        await s.runs.put(v1.value, v1.version);
        await rejects(h, s.runs.put(v1.value, v1.version), VersionConflictError);
      });
      it('does not alias stored data', async () => {
        const s = await make();
        const v = await s.runs.put(sampleRun('run_1'));
        v.value.run.title = 'mutated';
        expect((await s.runs.get('run_1'))?.value.run.title).toBe('Run run_1');
      });
      it('filters by status, pack, project and text, newest first, with paging', async () => {
        const s = await make();
        await s.runs.put(
          sampleRun('run_1', { status: 'running', createdAt: '2026-10-01T00:00:00.000Z' }),
        );
        await s.runs.put(
          sampleRun('run_2', {
            status: 'paused',
            projectId: 'proj_a',
            title: 'Pricing page',
            createdAt: '2026-10-02T00:00:00.000Z',
          }),
        );
        await s.runs.put(
          sampleRun('run_3', {
            status: 'running',
            pack: { id: 'pack_b', version: '1', sha: 'x' },
            createdAt: '2026-10-03T00:00:00.000Z',
          }),
        );
        expect((await s.runs.list()).items.map((i) => i.value.run.id)).toEqual([
          'run_3',
          'run_2',
          'run_1',
        ]);
        expect((await s.runs.list({ status: ['running'] })).items).toHaveLength(2);
        expect((await s.runs.list({ packId: 'pack_b' })).items).toHaveLength(1);
        expect((await s.runs.list({ projectId: 'proj_a' })).items[0]?.value.run.id).toBe('run_2');
        expect((await s.runs.list({ q: 'pricing' })).items).toHaveLength(1);
        const p1 = await s.runs.list({ limit: 2 });
        expect(p1.items).toHaveLength(2);
        expect(p1.nextCursor).toBeDefined();
        const p2 = await s.runs.list({
          limit: 2,
          ...(p1.nextCursor ? { cursor: p1.nextCursor } : {}),
        });
        expect(p2.items.map((i) => i.value.run.id)).toEqual(['run_1']);
      });
      it('finds a run by idempotency key', async () => {
        const s = await make();
        await s.runs.put({ ...sampleRun('run_1'), idempotencyKey: 'k1' });
        expect((await s.runs.findByIdempotencyKey('k1'))?.value.run.id).toBe('run_1');
        expect(await s.runs.findByIdempotencyKey('nope')).toBeUndefined();
      });
    });

    describe('decisions', () => {
      it('stores decisions with their effect map and filters them', async () => {
        const s = await make();
        await s.decisions.put(sampleDecision('dec_1', 'run_1'));
        await s.decisions.put(
          sampleDecision('dec_2', 'run_2', {
            kind: 'review',
            status: 'resolved',
          } as Partial<Decision>),
        );
        const got = await s.decisions.get('dec_1');
        expect(got?.value.effects).toEqual({ approve: 'advance', reject: 'halt' });
        expect((await s.decisions.list({ runId: 'run_1' })).items).toHaveLength(1);
        expect((await s.decisions.list({ kind: ['approval'] })).items).toHaveLength(1);
      });
      it('enforces optimistic versions', async () => {
        const s = await make();
        const v = await s.decisions.put(sampleDecision('dec_1', 'run_1'));
        await s.decisions.put(v.value, v.version);
        await rejects(h, s.decisions.put(v.value, v.version), VersionConflictError);
      });
    });

    describe('steps, projects, audit, usage', () => {
      it('lists steps by run', async () => {
        const s = await make();
        const step = {
          id: 'step_1',
          runId: 'run_1',
          phaseId: 'p',
          agent: { id: 'agt_1', role: 'dev', backend: 'b' },
          summary: 's',
          status: 'working',
          a2a: { resumed: false },
        } as never;
        await s.steps.put(step);
        expect(await s.steps.listByRun('run_1')).toHaveLength(1);
        expect(await s.steps.listByRun('run_2')).toHaveLength(0);
      });
      it('keeps projects sorted by name', async () => {
        const s = await make();
        await s.projects.put({ id: 'proj_b', name: 'b', createdAt: at, links: {} } as never);
        await s.projects.put({ id: 'proj_a', name: 'a', createdAt: at, links: {} } as never);
        expect((await s.projects.list()).items.map((i) => i.value.name)).toEqual(['a', 'b']);
      });
      it('appends audit entries, newest first, filterable', async () => {
        const s = await make();
        await s.audit.append({
          id: 'aud_1',
          at,
          actor,
          action: 'a',
          subject: { type: 'run', id: 'run_1' },
        });
        await s.audit.append({
          id: 'aud_2',
          at,
          actor,
          action: 'b',
          subject: { type: 'run', id: 'run_1' },
        });
        expect((await s.audit.list()).items.map((e) => e.id)).toEqual(['aud_2', 'aud_1']);
        expect((await s.audit.list({ action: 'a' })).items).toHaveLength(1);
      });
      it('records usage with nullable cost (never estimated)', async () => {
        const s = await make();
        await s.usage.append({
          runId: 'run_1',
          at,
          cost: null,
          usage: [{ unit: 'tokens', quantity: 5 }],
        });
        await s.usage.append({
          runId: 'run_1',
          at,
          cost: { amount: 1.5, currency: 'USD' },
          usage: [],
        });
        const rows = await s.usage.forRun('run_1');
        expect(rows).toHaveLength(2);
        expect(rows[0]?.cost === null).toBe(true);
      });
    });

    describe('artifact catalog', () => {
      const art = (id: string, over: object = {}) =>
        ({
          id,
          runId: 'run_1',
          phaseId: 'p1',
          name: 'a.md',
          type: 'doc',
          mediaType: 'text/markdown',
          size: 1,
          sha256: 'x',
          version: 1,
          status: 'draft',
          producer: actor,
          renditions: [],
          createdAt: at,
          links: {},
          ...over,
        }) as never;
      it('upserts, reads back, lists by run with filters and finds the superseding version', async () => {
        const s = await make();
        await s.artifacts.put(art('art_1'));
        await s.artifacts.put(
          art('art_2', { phaseId: 'p2', type: 'patch', supersedes: 'art_1', version: 2 }),
        );
        await s.artifacts.put(art('art_3', { runId: 'run_2' }));
        await s.artifacts.put(art('art_1', { status: 'superseded' }));
        expect((await s.artifacts.get('art_1'))?.status).toBe('superseded');
        expect(await s.artifacts.get('art_nope')).toBeUndefined();
        expect((await s.artifacts.listByRun('run_1')).map((a) => a.id)).toEqual(['art_1', 'art_2']);
        expect(await s.artifacts.listByRun('run_1', { phaseId: 'p2' })).toHaveLength(1);
        expect(await s.artifacts.listByRun('run_1', { type: 'doc' })).toHaveLength(1);
        expect((await s.artifacts.findSuperseding('art_1'))?.id).toBe('art_2');
        expect(await s.artifacts.findSuperseding('art_2')).toBeUndefined();
      });
    });

    describe('transactions', () => {
      it('commits on success and rolls back everything on failure', async () => {
        const s = await make();
        await s.transaction(async (tx) => {
          await tx.runs.put(sampleRun('run_ok'));
        });
        expect(await s.runs.get('run_ok')).toBeDefined();
        await rejects(
          h,
          s.transaction(async (tx) => {
            await tx.runs.put(sampleRun('run_bad'));
            await tx.audit.append({
              id: 'aud_x',
              at,
              actor,
              action: 'x',
              subject: { type: 'run', id: 'run_bad' },
            });
            throw new Error('boom');
          }),
          'boom',
        );
        expect(await s.runs.get('run_bad')).toBeUndefined();
        expect((await s.audit.list({ action: 'x' })).items).toHaveLength(0);
        await rejects(
          h,
          s.transaction(async (tx) => {
            await tx.artifacts.put({
              id: 'art_rb',
              runId: 'run_1',
              name: 'a',
              type: 't',
              mediaType: 'm',
              size: 1,
              sha256: 'x',
              version: 1,
              status: 'draft',
              producer: actor,
              renditions: [],
              createdAt: at,
              links: {},
            } as never);
            throw new Error('boom2');
          }),
          'boom2',
        );
        expect(await s.artifacts.get('art_rb')).toBeUndefined();
      });
    });
  });
}

/** Every `EventLog` adapter must pass this suite. `make` may accept a retention window to test `410 gone`. */
export function eventLogContract(
  h: Harness,
  make: (opts?: { retain?: number }) => EventLog | Promise<EventLog>,
  opts: { supportsRetention?: boolean } = {},
): void {
  const { describe, it, expect } = h;
  const draft = (type: string, runId?: string) => ({
    type,
    subject: { type: 'run', id: runId ?? 'x' },
    ...(runId ? { runId: runId as Run['id'] } : {}),
    data: {},
  });
  describe('EventLog contract', () => {
    it('assigns strictly increasing cursors and timestamps', async () => {
      const log = await make();
      const a = await log.append(draft('run.created', 'run_1'));
      const b = await log.append(draft('run.updated', 'run_1'));
      expect(Number(b.id)).toBeGreaterThan(Number(a.id));
      expect(a.schema).toBe(1);
      expect(await log.latestCursor()).toBe(b.id);
    });
    it('replays exactly the events after a cursor', async () => {
      const log = await make();
      const a = await log.append(draft('run.created', 'run_1'));
      await log.append(draft('run.updated', 'run_1'));
      await log.append(draft('run.completed', 'run_1'));
      expect((await log.read({ after: a.id })).map((e) => e.type)).toEqual([
        'run.updated',
        'run.completed',
      ]);
      expect((await log.read({ limit: 1 })).map((e) => e.type)).toEqual(['run.created']);
    });
    it('filters by topic with no cross-run leakage', async () => {
      const log = await make();
      await log.append(draft('run.updated', 'run_1'));
      await log.append(draft('run.updated', 'run_2'));
      await log.append({
        type: 'decision.requested',
        subject: { type: 'decision', id: 'dec_1' },
        runId: 'run_1' as Run['id'],
        data: {},
      });
      expect((await log.read({ topics: ['run:run_1'] })).map((e) => e.runId)).toEqual([
        'run_1',
        'run_1',
      ]);
      expect((await log.read({ topics: ['run:run_2'] })).map((e) => e.runId)).toEqual(['run_2']);
      expect((await log.read({ topics: ['inbox'] })).map((e) => e.type)).toEqual([
        'decision.requested',
      ]);
      expect((await log.read({ topics: ['runs'] })).map((e) => e.type)).toEqual([
        'run.updated',
        'run.updated',
      ]);
    });
    it('delivers live events to subscribers until they unsubscribe', async () => {
      const log = await make();
      const seen: string[] = [];
      const off = log.subscribe((e) => seen.push(e.type), ['run:run_1']);
      await log.append(draft('run.created', 'run_1'));
      await log.append(draft('run.created', 'run_2'));
      off();
      await log.append(draft('run.updated', 'run_1'));
      expect(seen).toEqual(['run.created']);
    });
    if (opts.supportsRetention) {
      it('answers a too-old cursor with CursorGoneError', async () => {
        const log = await make({ retain: 3 });
        const first = await log.append(draft('run.created', 'run_1'));
        for (let i = 0; i < 6; i++) await log.append(draft('run.updated', 'run_1'));
        await rejects(h, log.read({ after: first.id }), CursorGoneError);
        expect((await log.read({ after: await log.latestCursor() })).length).toBe(0);
      });
    }
  });
}

/** Every `ArtifactStore` adapter must pass this suite. */
export function artifactStoreContract(
  h: Harness,
  make: () => ArtifactStore | Promise<ArtifactStore>,
): void {
  const { describe, it, expect } = h;
  const enc = (s: string) => new TextEncoder().encode(s);
  const put = (s: ArtifactStore, text: string, over: object = {}) =>
    s.put({
      runId: 'run_1',
      phaseId: 'p1',
      name: 'a.md',
      type: 'doc',
      mediaType: 'text/markdown',
      producer: actor,
      bytes: enc(text),
      ...over,
    });
  describe('ArtifactStore contract', () => {
    it('stores bytes with size and sha256, and reads them back', async () => {
      const s = await make();
      const a = await put(s, 'hello');
      expect(a.size).toBe(5);
      expect(a.sha256).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
      expect(a.version).toBe(1);
      const c = await s.read(a.id);
      expect(new TextDecoder().decode(c?.bytes)).toBe('hello');
      expect(c?.mediaType).toBe('text/markdown');
      expect(await s.get('art_nope')).toBeUndefined();
      expect(await s.read('art_nope')).toBeUndefined();
    });
    it('serves byte ranges and reports the total size', async () => {
      const s = await make();
      const a = await put(s, '0123456789');
      const c = await s.read(a.id, { start: 2, end: 5 });
      expect(new TextDecoder().decode(c?.bytes)).toBe('2345');
      expect(c?.size).toBe(10);
      expect(c?.range).toEqual({ start: 2, end: 5 });
      expect(new TextDecoder().decode((await s.read(a.id, { start: 8, end: 99 }))?.bytes)).toBe(
        '89',
      );
    });
    it('keeps a version chain and marks superseded versions', async () => {
      const s = await make();
      const v1 = await put(s, 'v1');
      const v2 = await put(s, 'v2', { supersedes: v1.id });
      expect(v2.version).toBe(2);
      expect(v2.supersedes).toBe(v1.id);
      expect((await s.get(v1.id))?.status).toBe('superseded');
      expect((await s.versions(v2.id)).map((a) => a.version)).toEqual([1, 2]);
      expect((await s.versions(v1.id)).map((a) => a.version)).toEqual([1, 2]);
    });
    it('lists by run with filters and updates status', async () => {
      const s = await make();
      const a = await put(s, 'a');
      await put(s, 'b', { phaseId: 'p2', type: 'patch' });
      await put(s, 'c', { runId: 'run_2' });
      expect(await s.listByRun('run_1')).toHaveLength(2);
      expect(await s.listByRun('run_1', { phaseId: 'p2' })).toHaveLength(1);
      expect(await s.listByRun('run_1', { type: 'doc' })).toHaveLength(1);
      expect((await s.setStatus(a.id, 'final')).status).toBe('final');
    });
    it('stores identical bytes once but as separate artifacts', async () => {
      const s = await make();
      const a = await put(s, 'same');
      const b = await put(s, 'same');
      expect(a.id === b.id).toBe(false);
      expect(a.sha256).toBe(b.sha256);
    });
  });
}
