import type { Store } from '@kramahq/engine';
import type { Db } from './db.js';
import {
  PgArtifactCatalog,
  PgAudit,
  PgDecisions,
  PgProjects,
  PgRuns,
  PgSteps,
  PgUsage,
} from './repos.js';

/** `Store` over a Drizzle database. A transaction hands the callback a `Store` bound to that transaction. */
export class PgStore implements Store {
  readonly runs: PgRuns;
  readonly decisions: PgDecisions;
  readonly steps: PgSteps;
  readonly artifacts: PgArtifactCatalog;
  readonly projects: PgProjects;
  readonly audit: PgAudit;
  readonly usage: PgUsage;

  constructor(private readonly db: Db) {
    this.runs = new PgRuns(db);
    this.decisions = new PgDecisions(db);
    this.steps = new PgSteps(db);
    this.artifacts = new PgArtifactCatalog(db);
    this.projects = new PgProjects(db);
    this.audit = new PgAudit(db);
    this.usage = new PgUsage(db);
  }

  /** Nested calls become savepoints; an error anywhere rolls the whole transaction back. */
  transaction<T>(fn: (tx: Store) => Promise<T>): Promise<T> {
    return this.db.transaction((tx) => fn(new PgStore(tx as unknown as Db)));
  }
}
