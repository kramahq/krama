import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildOpenApi } from './openapi.js';

const out = fileURLToPath(new URL('../openapi.json', import.meta.url));
const doc = buildOpenApi();
writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`);
console.log(`Wrote ${out} (${Object.keys(doc.paths).length} paths)`);
