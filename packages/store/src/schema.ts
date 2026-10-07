import {
  bigserial,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * One schema for PGlite (local) and Postgres (hosted). Entities are stored as `jsonb` documents
 * (the contract shape is the source of truth); only columns we filter or sort on are promoted.
 * Timestamps are ISO-8601 UTC text, which sorts correctly and round-trips exactly.
 */
export const runs = pgTable(
  'runs',
  {
    id: text('id').primaryKey(),
    version: integer('version').notNull(),
    status: text('status').notNull(),
    packId: text('pack_id').notNull(),
    projectId: text('project_id'),
    title: text('title').notNull(),
    createdAt: text('created_at').notNull(),
    idempotencyKey: text('idempotency_key'),
    data: jsonb('data').notNull(),
  },
  (t) => [
    index('runs_status_idx').on(t.status),
    index('runs_pack_idx').on(t.packId),
    index('runs_project_idx').on(t.projectId),
    index('runs_created_idx').on(t.createdAt),
    uniqueIndex('runs_idem_idx').on(t.idempotencyKey),
  ],
);

export const decisions = pgTable(
  'decisions',
  {
    id: text('id').primaryKey(),
    version: integer('version').notNull(),
    runId: text('run_id'),
    kind: text('kind').notNull(),
    status: text('status').notNull(),
    createdAt: text('created_at').notNull(),
    data: jsonb('data').notNull(),
  },
  (t) => [index('decisions_run_idx').on(t.runId), index('decisions_status_idx').on(t.status)],
);

export const steps = pgTable(
  'steps',
  {
    id: text('id').primaryKey(),
    version: integer('version').notNull(),
    runId: text('run_id').notNull(),
    data: jsonb('data').notNull(),
  },
  (t) => [index('steps_run_idx').on(t.runId)],
);

export const projects = pgTable('projects', {
  id: text('id').primaryKey(),
  version: integer('version').notNull(),
  name: text('name').notNull(),
  data: jsonb('data').notNull(),
});

export const artifacts = pgTable(
  'artifacts',
  {
    id: text('id').primaryKey(),
    runId: text('run_id'),
    phaseId: text('phase_id'),
    type: text('type').notNull(),
    status: text('status').notNull(),
    supersedes: text('supersedes'),
    createdAt: text('created_at').notNull(),
    data: jsonb('data').notNull(),
  },
  (t) => [
    index('artifacts_run_idx').on(t.runId),
    index('artifacts_supersedes_idx').on(t.supersedes),
  ],
);

export const audit = pgTable(
  'audit',
  {
    seq: bigserial('seq', { mode: 'number' }).primaryKey(),
    id: text('id').notNull(),
    at: text('at').notNull(),
    actorId: text('actor_id').notNull(),
    action: text('action').notNull(),
    data: jsonb('data').notNull(),
  },
  (t) => [index('audit_action_idx').on(t.action), index('audit_actor_idx').on(t.actorId)],
);

export const usageEntries = pgTable(
  'usage_entries',
  {
    seq: bigserial('seq', { mode: 'number' }).primaryKey(),
    runId: text('run_id').notNull(),
    at: text('at').notNull(),
    data: jsonb('data').notNull(),
  },
  (t) => [index('usage_run_idx').on(t.runId)],
);

export const memoryRecords = pgTable(
  'memory_records',
  {
    id: text('id').primaryKey(),
    version: integer('version').notNull(),
    scopeType: text('scope_type').notNull(),
    scopeId: text('scope_id').notNull(),
    status: text('status').notNull(),
    createdAt: text('created_at').notNull(),
    data: jsonb('data').notNull(),
  },
  (t) => [
    index('memory_scope_idx').on(t.scopeType, t.scopeId),
    index('memory_status_idx').on(t.status),
  ],
);

/** Persisted event log. `seq` is the monotonic cursor (SSE id); retention is by count and age. */
export const events = pgTable(
  'events',
  {
    seq: bigserial('seq', { mode: 'number' }).primaryKey(),
    type: text('type').notNull(),
    at: text('at').notNull(),
    runId: text('run_id'),
    subjectType: text('subject_type').notNull(),
    subjectId: text('subject_id').notNull(),
    data: jsonb('data').notNull(),
  },
  (t) => [
    index('events_run_idx').on(t.runId, t.seq),
    index('events_type_idx').on(t.type, t.seq),
    index('events_subject_idx').on(t.subjectType, t.subjectId, t.seq),
  ],
);

/**
 * The hash-chained audit record (ADR-0013). Append-only: triggers refuse UPDATE, DELETE and TRUNCATE (migration
 * 0002). `record` is the whole record as canonical JSON text, not jsonb, so what is hashed is exactly what is stored
 * (jsonb would reorder keys and rewrite numbers); the other columns are copies kept for filtering.
 */
export const auditRecords = pgTable(
  'audit_records',
  {
    chain: text('chain').notNull(),
    seq: integer('seq').notNull(),
    id: text('id').notNull(),
    at: text('at').notNull(),
    kind: text('kind').notNull(),
    actorId: text('actor_id').notNull(),
    runId: text('run_id'),
    sourceEventId: text('source_event_id'),
    record: text('record').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.chain, t.seq] }),
    uniqueIndex('audit_records_source_idx').on(t.chain, t.sourceEventId),
    index('audit_records_at_idx').on(t.chain, t.at),
    index('audit_records_kind_idx').on(t.kind, t.at),
  ],
);

/** The latest position of each chain. It serialises writers (the row is locked while a record is appended) and is what `verify` compares the chain's end with. It only moves forward. */
export const auditHeads = pgTable('audit_heads', {
  chain: text('chain').primaryKey(),
  seq: integer('seq').notNull(),
  hash: text('hash').notNull(),
});
