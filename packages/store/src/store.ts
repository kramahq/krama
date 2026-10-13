import type { Store } from '@kramahq/engine';
import type { PgAuditLedger } from './audit.js';
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
  readonly ledger: PgAuditLedger | undefined;

  constructor(
    private readonly db: Db,
    ledger?: PgAuditLedger,
  ) {
    this.ledger = ledger;
    this.runs = new PgRuns(db);
    this.decisions = new PgDecisions(db);
    this.steps = new PgSteps(db);
    this.artifacts = new PgArtifactCatalog(db);
    this.projects = new PgProjects(db);
    this.audit = new PgAudit(db);
    this.usage = new PgUsage(db);
  }

  /**
   * Nested calls become savepoints; an error anywhere rolls the whole transaction back. The store's ledger joins it:
   * records written inside commit or roll back with the change, and subscribers hear of them after the outermost commit.
   */
  async transaction<T>(fn: (tx: Store) => Promise<T>): Promise<T> {
    const outer = this.ledger?.pending;
    // Each transaction (a savepoint when nested) holds its own notifications, so a nested one that rolls back takes
    // its announcements with it; a successful one hands them to the transaction around it.
    const mine: (() => void)[] = [];
    const out = await this.db.transaction((tx) =>
      fn(new PgStore(tx as unknown as Db, this.ledger?.bind(tx as unknown as Db, mine))),
    );
    if (outer) outer.push(...mine);
    else for (const notify of mine) notify();
    return out;
  }
}
