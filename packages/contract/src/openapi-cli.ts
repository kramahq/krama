import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { backendDescriptor } from './schemas/backends.js';
import { buildOpenApi } from './openapi.js';

const out = fileURLToPath(new URL('../openapi.json', import.meta.url));
const doc = buildOpenApi();
writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`);
console.log(`Wrote ${out} (${Object.keys(doc.paths).length} paths)`);

// JSON Schema for backend descriptor files, so editors can validate and autocomplete them.
const schemaOut = fileURLToPath(
  new URL('../schemas/backend-descriptor.schema.json', import.meta.url),
);
const schema = z.toJSONSchema(backendDescriptor, {
  target: 'draft-2020-12',
  io: 'input',
  unrepresentable: 'any',
});
mkdirSync(dirname(schemaOut), { recursive: true });
writeFileSync(
  schemaOut,
  `${JSON.stringify({ title: 'Krama backend descriptor', ...schema }, null, 2)}\n`,
);
console.log(`Wrote ${schemaOut}`);
