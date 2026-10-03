// Scaffolds a backend descriptor for a new A2A wrapper from its JSON schema.
//
//   node scripts/scaffold-backend.ts --schema ../a2a-foo/schemas/agent-config.schema.json \
//        --id a2a-foo --package a2a-foo --provider foo --out ~/.krama/backends/a2a-foo.json
//
// Build first (`pnpm -F @kramahq/agents build`). The output validates immediately; fill in the
// items it lists (env vars, prerequisites, capabilities) and run `krama doctor`.
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { BackendRegistry, extractOptions } from '../dist/index.js';

const { values: a } = parseArgs({
  options: {
    schema: { type: 'string' },
    id: { type: 'string' },
    package: { type: 'string' },
    provider: { type: 'string' },
    label: { type: 'string' },
    port: { type: 'string' },
    out: { type: 'string' },
  },
});
if (!a.schema || !a.id || !a.package) {
  console.error(
    'Usage: scaffold-backend --schema <agent-config.schema.json> --id a2a-foo --package a2a-foo [--provider foo] [--label "Foo"] [--port 3050] [--out file.json]',
  );
  process.exit(2);
}

const provider = a.provider ?? a.id.replace(/^a2a-/, '');
const options = extractOptions(JSON.parse(readFileSync(a.schema, 'utf8')), provider);
if (options.length === 0) {
  console.error(
    `No options found under "${provider}" in the schema. Pass --provider with the config section name.`,
  );
  process.exit(1);
}
const keys = options.map((o) => o.key);
const guess = (re: RegExp) => keys.find((k) => re.test(k));
const todo: string[] = [];

const workspace =
  guess(/^(working|workspace|project)(Dir|Directory)$/i) ?? guess(/(dir|directory|cwd)$/i);
if (!workspace)
  todo.push(
    'mapping.workspace: no workspace option found; set the option key that holds the working directory',
  );
const systemPrompt = guess(
  /^(systemPrompt(Append)?|developerInstructions|systemInstructions|instructions)$/i,
);
if (!systemPrompt)
  todo.push(
    'mapping.systemPrompt: none detected; set it if the provider accepts a persona/system prompt',
  );

const descriptor = {
  $schema:
    'https://raw.githubusercontent.com/kramahq/krama/main/packages/contract/schemas/backend-descriptor.schema.json',
  id: a.id,
  label: a.label ?? provider,
  package: { name: a.package, bin: a.package, install: `npm i -g ${a.package}` },
  launch: { defaultPort: Number(a.port ?? 3050) },
  providerKey: provider,
  mapping: {
    workspace: workspace ?? 'workingDirectory',
    model: keys.includes('model') ? 'model' : 'model',
    ...(systemPrompt ? { systemPrompt } : {}),
  },
  options,
  env: [],
  prerequisites: [
    {
      id: 'wrapper',
      description: `${a.package} is installed`,
      kind: 'binary',
      check: { command: [a.package, '--version'] },
      install: { any: `npm i -g ${a.package}` },
    },
  ],
  capabilities: {
    canOrchestrate: false,
    cost: 'unknown',
    sideband: true,
    resumableSessions: false,
  },
};
todo.push('env: list the environment variables the wrapper reads (API keys as secret: true)');
todo.push(
  'prerequisites: add anything the provider needs besides the wrapper (a CLI, a running service, a runtime)',
);
todo.push(
  'capabilities: canOrchestrate (needs reliable MCP tool calling), cost, resumableSessions',
);
if (!keys.includes('model'))
  todo.push('mapping.model: no "model" option found; set the option key that selects the model');

try {
  new BackendRegistry().register(descriptor, 'user');
} catch (e) {
  console.error(`Scaffold produced an invalid descriptor: ${(e as Error).message}`);
  process.exit(1);
}
const json = `${JSON.stringify(descriptor, null, 2)}\n`;
if (a.out) writeFileSync(a.out, json);
else process.stdout.write(json);
console.error(
  `\n${options.length} options extracted. Still to do:\n${todo.map((t) => `  - ${t}`).join('\n')}`,
);
