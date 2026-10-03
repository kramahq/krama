import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const dir = join(dirname(require.resolve('@kramahq/contract/package.json')), 'fixtures');

/** Reads a JSON fixture shipped with `@kramahq/contract`. */
export const fixture = <T = unknown>(file: string): T =>
  JSON.parse(readFileSync(join(dir, file), 'utf8')) as T;
