import type { Artifact, AuditEntry, MemoryRecord, Project, Step } from '@kramahq/contract';
import {
  VersionConflictError,
  type ArtifactCatalog,
  type AuditLog,
  type DecisionQuery,
  type DecisionRecord,
  type DecisionRepository,
  type ListOptions,
  type MemoryQuery,
  type MemoryStore,
  type Page,
  type ProjectRepository,
  type RunQuery,
  type RunRecord,
  type RunRepository,
  type StepRepository,
  type UsageEntry,
  type UsageLedger,
  type Versioned,
} from '@kramahq/engine';
import { and, asc, desc, eq, ilike, inArray, sql, type SQL } from 'drizzle-orm';
import type { Db } from './db.js';
import {
  artifacts,
  audit,
  decisions,
  memoryRecords,
  projects,
  runs,
  steps,
  usageEntries,
} from './schema.js';

const DEFAULT_LIMIT = 50;
const where = (...c: (SQL | undefined)[]) => and(...c.filter((x): x is SQL => x !== undefined));
const likeEscape = (q: string) => q.replace(/[\\%_]/g, (m) => `\\${m}`);

async function page<T>(
  rows: (limit: number, offset: number) => Promise<T[]>,
  o: ListOptions = {},
): Promise<Page<T>> {
  const limit = o.limit ?? DEFAULT_LIMIT;
  const offset = Number(o.cursor ?? 0) || 0;
  const got = await rows(limit + 1, offset);
  return {
    items: got.slice(0, limit),
    ...(got.length > limit ? { nextCursor: String(offset + limit) } : {}),
  };
}

/**
 * Optimistic write shared by the versioned entities: `expected === undefined` inserts (fails if present),
 * otherwise the row must still be at `expected`. Returns the new version or throws `VersionConflictError`.
 */
async function versionedWrite(
  id: string,
  expected: number | undefined,
  insert: () => Promise<{ version: number }[]>,
  update: (nextVersion: number) => Promise<{ version: number }[]>,
  current: () => Promise<number | undefined>,
): Promise<number> {
  const rows = expected === undefined ? await insert() : await update(expected + 1);
  const got = rows[0];
  if (!got) throw new VersionConflictError(id, expected, await current());
  return got.version;
}

export class PgRuns implements RunRepository {
  constructor(private readonly db: Db) {}
  private cols = (r: RunRecord, version: number) => ({
    version,
    status: r.run.status,
    packId: r.run.pack.id,
    projectId: r.run.projectId ?? null,
    title: r.run.title,
    createdAt: r.run.createdAt,
    idempotencyKey: r.idempotencyKey ?? null,
    data: r,
  });
  private async version(id: string) {
    return (await this.db.select({ v: runs.version }).from(runs).where(eq(runs.id, id)))[0]?.v;
  }

  async get(id: string): Promise<Versioned<RunRecord> | undefined> {
    const row = (await this.db.select().from(runs).where(eq(runs.id, id)))[0];
    return row ? { value: row.data as RunRecord, version: row.version } : undefined;
  }
  async put(r: RunRecord, expected?: number): Promise<Versioned<RunRecord>> {
    const id = r.run.id;
    const version = await versionedWrite(
      id,
      expected,
      () =>
        this.db
          .insert(runs)
          .values({ id, ...this.cols(r, 1) })
          .onConflictDoNothing({ target: runs.id })
          .returning({ version: runs.version }),
      (next) =>
        this.db
          .update(runs)
          .set(this.cols(r, next))
          .where(and(eq(runs.id, id), eq(runs.version, next - 1)))
          .returning({ version: runs.version }),
      () => this.version(id),
    );
    return { value: structuredClone(r), version };
  }
  async findByIdempotencyKey(key: string) {
    const row = (await this.db.select().from(runs).where(eq(runs.idempotencyKey, key)))[0];
    return row ? { value: row.data as RunRecord, version: row.version } : undefined;
  }
  async list(q: RunQuery = {}): Promise<Page<Versioned<RunRecord>>> {
    const cond = where(
      q.status?.length ? inArray(runs.status, q.status) : undefined,
      q.packId ? eq(runs.packId, q.packId) : undefined,
      q.projectId ? eq(runs.projectId, q.projectId) : undefined,
      q.q ? ilike(runs.title, `%${likeEscape(q.q)}%`) : undefined,
    );
    return page(
      async (limit, offset) =>
        (
          await this.db
            .select()
            .from(runs)
            .where(cond)
            .orderBy(desc(runs.createdAt), desc(runs.id))
            .limit(limit)
            .offset(offset)
        ).map((r) => ({ value: r.data as RunRecord, version: r.version })),
      q,
    );
  }
}

export class PgDecisions implements DecisionRepository {
  constructor(private readonly db: Db) {}
  private cols = (r: DecisionRecord, version: number) => ({
    version,
    runId: r.decision.runId ?? null,
    kind: r.decision.kind,
    status: r.decision.status,
    createdAt: r.decision.createdAt,
    data: r,
  });
  private async version(id: string) {
    return (
      await this.db.select({ v: decisions.version }).from(decisions).where(eq(decisions.id, id))
    )[0]?.v;
  }

  async get(id: string) {
    const row = (await this.db.select().from(decisions).where(eq(decisions.id, id)))[0];
    return row ? { value: row.data as DecisionRecord, version: row.version } : undefined;
  }
  async put(r: DecisionRecord, expected?: number) {
    const id = r.decision.id;
    const version = await versionedWrite(
      id,
      expected,
      () =>
        this.db
          .insert(decisions)
          .values({ id, ...this.cols(r, 1) })
          .onConflictDoNothing({ target: decisions.id })
          .returning({ version: decisions.version }),
      (next) =>
        this.db
          .update(decisions)
          .set(this.cols(r, next))
          .where(and(eq(decisions.id, id), eq(decisions.version, next - 1)))
          .returning({ version: decisions.version }),
      () => this.version(id),
    );
    return { value: structuredClone(r), version };
  }
  async list(q: DecisionQuery = {}) {
    const cond = where(
      q.status?.length ? inArray(decisions.status, q.status) : undefined,
      q.kind?.length ? inArray(decisions.kind, q.kind) : undefined,
      q.runId ? eq(decisions.runId, q.runId) : undefined,
    );
    return page(
      async (limit, offset) =>
        (
          await this.db
            .select()
            .from(decisions)
            .where(cond)
            .orderBy(asc(decisions.createdAt), asc(decisions.id))
            .limit(limit)
            .offset(offset)
        ).map((r) => ({ value: r.data as DecisionRecord, version: r.version })),
      q,
    );
  }
}

export class PgSteps implements StepRepository {
  constructor(private readonly db: Db) {}
  private cols = (s: Step, version: number) => ({ version, runId: s.runId, data: s });
  private async version(id: string) {
    return (await this.db.select({ v: steps.version }).from(steps).where(eq(steps.id, id)))[0]?.v;
  }
  async get(id: string) {
    const row = (await this.db.select().from(steps).where(eq(steps.id, id)))[0];
    return row ? { value: row.data as Step, version: row.version } : undefined;
  }
  async put(s: Step, expected?: number) {
    const version = await versionedWrite(
      s.id,
      expected,
      () =>
        this.db
          .insert(steps)
          .values({ id: s.id, ...this.cols(s, 1) })
          .onConflictDoNothing({ target: steps.id })
          .returning({ version: steps.version }),
      (next) =>
        this.db
          .update(steps)
          .set(this.cols(s, next))
          .where(and(eq(steps.id, s.id), eq(steps.version, next - 1)))
          .returning({ version: steps.version }),
      () => this.version(s.id),
    );
    return { value: structuredClone(s), version };
  }
  async listByRun(runId: string) {
    return (
      await this.db.select().from(steps).where(eq(steps.runId, runId)).orderBy(asc(steps.id))
    ).map((r) => r.data as Step);
  }
}

export class PgProjects implements ProjectRepository {
  constructor(private readonly db: Db) {}
  private cols = (p: Project, version: number) => ({ version, name: p.name, data: p });
  private async version(id: string) {
    return (
      await this.db.select({ v: projects.version }).from(projects).where(eq(projects.id, id))
    )[0]?.v;
  }
  async get(id: string) {
    const row = (await this.db.select().from(projects).where(eq(projects.id, id)))[0];
    return row ? { value: row.data as Project, version: row.version } : undefined;
  }
  async put(p: Project, expected?: number) {
    const version = await versionedWrite(
      p.id,
      expected,
      () =>
        this.db
          .insert(projects)
          .values({ id: p.id, ...this.cols(p, 1) })
          .onConflictDoNothing({ target: projects.id })
          .returning({ version: projects.version }),
      (next) =>
        this.db
          .update(projects)
          .set(this.cols(p, next))
          .where(and(eq(projects.id, p.id), eq(projects.version, next - 1)))
          .returning({ version: projects.version }),
      () => this.version(p.id),
    );
    return { value: structuredClone(p), version };
  }
  async list(o?: ListOptions) {
    return page(
      async (limit, offset) =>
        (
          await this.db
            .select()
            .from(projects)
            .orderBy(asc(projects.name), asc(projects.id))
            .limit(limit)
            .offset(offset)
        ).map((r) => ({ value: r.data as Project, version: r.version })),
      o,
    );
  }
}

export class PgArtifactCatalog implements ArtifactCatalog {
  constructor(private readonly db: Db) {}
  async put(a: Artifact) {
    const v = {
      runId: a.runId ?? null,
      phaseId: a.phaseId ?? null,
      type: a.type,
      status: a.status,
      supersedes: a.supersedes ?? null,
      createdAt: a.createdAt,
      data: a,
    };
    await this.db
      .insert(artifacts)
      .values({ id: a.id, ...v })
      .onConflictDoUpdate({ target: artifacts.id, set: v });
  }
  async get(id: string) {
    return (await this.db.select().from(artifacts).where(eq(artifacts.id, id)))[0]?.data as
      Artifact | undefined;
  }
  async findSuperseding(id: string) {
    return (await this.db.select().from(artifacts).where(eq(artifacts.supersedes, id)).limit(1))[0]
      ?.data as Artifact | undefined;
  }
  async listByRun(
    runId: string,
    f: { phaseId?: string; type?: string; status?: Artifact['status'] } = {},
  ) {
    const cond = where(
      eq(artifacts.runId, runId),
      f.phaseId ? eq(artifacts.phaseId, f.phaseId) : undefined,
      f.type ? eq(artifacts.type, f.type) : undefined,
      f.status ? eq(artifacts.status, f.status) : undefined,
    );
    return (
      await this.db
        .select()
        .from(artifacts)
        .where(cond)
        .orderBy(asc(artifacts.createdAt), asc(artifacts.id))
    ).map((r) => r.data as Artifact);
  }
}

export class PgAudit implements AuditLog {
  constructor(private readonly db: Db) {}
  async append(e: AuditEntry) {
    await this.db
      .insert(audit)
      .values({ id: e.id, at: e.at, actorId: e.actor.id, action: e.action, data: e });
  }
  async list(o: ListOptions & { actor?: string; action?: string } = {}) {
    const cond = where(
      o.actor ? eq(audit.actorId, o.actor) : undefined,
      o.action ? eq(audit.action, o.action) : undefined,
    );
    return page(
      async (limit, offset) =>
        (
          await this.db
            .select()
            .from(audit)
            .where(cond)
            .orderBy(desc(audit.seq))
            .limit(limit)
            .offset(offset)
        ).map((r) => r.data as AuditEntry),
      o,
    );
  }
}

export class PgUsage implements UsageLedger {
  constructor(private readonly db: Db) {}
  async append(e: UsageEntry) {
    await this.db.insert(usageEntries).values({ runId: e.runId, at: e.at, data: e });
  }
  async forRun(runId: string) {
    return (
      await this.db
        .select()
        .from(usageEntries)
        .where(eq(usageEntries.runId, runId))
        .orderBy(asc(usageEntries.seq))
    ).map((r) => r.data as UsageEntry);
  }
}

export class PgMemory implements MemoryStore {
  constructor(private readonly db: Db) {}
  private cols = (m: MemoryRecord, version: number) => ({
    version,
    scopeType: m.scope.type,
    scopeId: m.scope.id,
    status: m.status,
    createdAt: m.createdAt,
    data: m,
  });
  private async version(id: string) {
    return (
      await this.db
        .select({ v: memoryRecords.version })
        .from(memoryRecords)
        .where(eq(memoryRecords.id, id))
    )[0]?.v;
  }
  async get(id: string) {
    const row = (await this.db.select().from(memoryRecords).where(eq(memoryRecords.id, id)))[0];
    return row ? { value: row.data as MemoryRecord, version: row.version } : undefined;
  }
  async put(m: MemoryRecord, expected?: number) {
    const version = await versionedWrite(
      m.id,
      expected,
      () =>
        this.db
          .insert(memoryRecords)
          .values({ id: m.id, ...this.cols(m, 1) })
          .onConflictDoNothing({ target: memoryRecords.id })
          .returning({ version: memoryRecords.version }),
      (next) =>
        this.db
          .update(memoryRecords)
          .set(this.cols(m, next))
          .where(and(eq(memoryRecords.id, m.id), eq(memoryRecords.version, next - 1)))
          .returning({ version: memoryRecords.version }),
      () => this.version(m.id),
    );
    return { value: structuredClone(m), version };
  }
  async search(q: MemoryQuery) {
    const cond = where(
      q.scope
        ? and(eq(memoryRecords.scopeType, q.scope.type), eq(memoryRecords.scopeId, q.scope.id))
        : undefined,
      q.status?.length ? inArray(memoryRecords.status, q.status) : undefined,
      q.tag ? sql`${memoryRecords.data} -> 'tags' ? ${q.tag}` : undefined,
      q.q ? sql`${memoryRecords.data} ->> 'content' ilike ${`%${likeEscape(q.q)}%`}` : undefined,
    );
    return page(
      async (limit, offset) =>
        (
          await this.db
            .select()
            .from(memoryRecords)
            .where(cond)
            .orderBy(desc(memoryRecords.createdAt), asc(memoryRecords.id))
            .limit(limit)
            .offset(offset)
        ).map((r) => ({ value: r.data as MemoryRecord, version: r.version })),
      q,
    );
  }
}
