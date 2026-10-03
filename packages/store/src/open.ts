import { PGlite } from '@electric-sql/pglite';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import type { Db } from './db.js';
import { schema } from './db.js';
import { migrate } from './migrate.js';
import { PgMemory } from './repos.js';
import { PgStore } from './store.js';

export interface OpenedStore {
  store: PgStore;
  memory: PgMemory;
  db: Db;
  /** Migrations applied by this call (empty when already up to date). */
  applied: string[];
  close(): Promise<void>;
}

/**
 * Local, embedded Postgres (WASM, no native modules). `dataDir` omitted = in-memory.
 * One process owns a data directory at a time.
 */
export async function openPglite(dataDir?: string): Promise<OpenedStore> {
  const client = new PGlite(dataDir);
  await client.waitReady;
  const db = drizzlePglite(client, { schema }) as unknown as Db;
  const applied = await migrate(db);
  return {
    store: new PgStore(db),
    memory: new PgMemory(db),
    db,
    applied,
    close: () => client.close(),
  };
}

/** Hosted Postgres. */
export async function openPostgres(connectionString: string): Promise<OpenedStore> {
  const pool = new pg.Pool({ connectionString });
  const db = drizzlePg(pool, { schema }) as unknown as Db;
  const applied = await migrate(db);
  return { store: new PgStore(db), memory: new PgMemory(db), db, applied, close: () => pool.end() };
}
