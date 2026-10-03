import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as schema from './schema.js';

/** A Drizzle database over PGlite or Postgres; the repositories only use the shared query API. */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;
export { schema };
