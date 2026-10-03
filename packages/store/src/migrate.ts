import { sql } from 'drizzle-orm';
import type { Db } from './db.js';
import { MIGRATIONS, type Migration } from './migrations.generated.js';

const TABLE = 'krama_migrations';

/**
 * Applies embedded migrations that have not run yet, each in its own transaction.
 * Safe to call on every start and from several processes (Postgres advisory lock).
 */
export async function migrate(
  db: Db,
  migrations: readonly Migration[] = MIGRATIONS,
): Promise<string[]> {
  const applied: string[] = [];
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(727274)`);
    await tx.execute(
      sql.raw(
        `create table if not exists ${TABLE} (name text primary key, applied_at text not null)`,
      ),
    );
    const res = (await tx.execute(sql.raw(`select name from ${TABLE}`))) as unknown as {
      rows: { name: unknown }[];
    };
    const done = new Set(res.rows.map((r) => String(r.name)));
    for (const m of migrations) {
      if (done.has(m.name)) continue;
      for (const stmt of m.statements) await tx.execute(sql.raw(stmt));
      await tx.execute(
        sql`insert into krama_migrations (name, applied_at) values (${m.name}, ${new Date().toISOString()})`,
      );
      applied.push(m.name);
    }
  });
  return applied;
}
