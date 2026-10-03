// Generates the backend reference pages from the registry, so the docs cannot drift from the descriptors.
//   node scripts/gen-backend-docs.ts <output-dir>
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BackendRegistry } from '../dist/index.js';

const out = process.argv[2];
if (!out) {
  console.error('Usage: gen-backend-docs <output-dir>');
  process.exit(2);
}
mkdirSync(out, { recursive: true });
const reg = BackendRegistry.withBuiltins();
const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
const code = (s: unknown) => `\`${String(s)}\``;

const page = (d: ReturnType<typeof reg.list>[number]): string => {
  const opts = d.options
    .map(
      (o) =>
        `| ${code(o.key)} | ${o.type === 'enum' ? (o.values?.map(code).join(', ') ?? 'enum') : o.type} | ${esc(o.description)}${o.risk === 'high' ? ' **(high risk)**' : ''}${o.secret ? ' **(secret)**' : ''}${o.default !== undefined ? ` Default: ${code(JSON.stringify(o.default))}.` : ''} |`,
    )
    .join('\n');
  const env = d.env.length
    ? d.env
        .map(
          (e) =>
            `| ${code(e.name)} | ${e.required ? 'yes' : e.group ? `one of group \`${e.group}\`` : 'no'} | ${e.secret ? 'secret' : ''} | ${esc(e.description)} |`,
        )
        .join('\n')
    : '| _none_ | | | |';
  const pre = d.prerequisites
    .map(
      (p) =>
        `- **${p.id}**${p.optional ? ' (optional)' : ''}: ${p.description}${p.install?.any ? `. Install: ${code(p.install.any)}` : ''}${p.install?.macos ? `. macOS: ${code(p.install.macos)}` : ''}${p.install?.windows ? `. Windows: ${code(p.install.windows)}` : ''}${p.install?.linux ? `. Linux: ${code(p.install.linux)}` : ''}`,
    )
    .join('\n');
  const cap = d.capabilities;
  return `# ${d.label} (\`${d.id}\`)

> Generated from the backend descriptor. Do not edit by hand; change \`packages/agents/src/backends/${d.id}.json\`.

${d.description ?? ''}

| | |
|---|---|
| Package | ${code(d.package.name)} (executable ${code(d.package.bin)}) |
| Install | ${code(d.package.install)} |
| Config section | ${code(d.providerKey)} |
| Workspace key | ${code(`${d.providerKey}.${d.mapping.workspace}`)} |
| System prompt key | ${d.mapping.systemPrompt ? code(`${d.providerKey}.${d.mapping.systemPrompt}`) : '_not supported_'} |
| Can orchestrate | ${cap.canOrchestrate ? 'yes' : 'no'} |
| Cost reporting | ${cap.cost} |
| Sideband events | ${cap.sideband ? 'yes' : 'no'} |
| Resumable sessions | ${cap.resumableSessions ? 'yes' : 'no'} |
| Suggested models | ${d.models.length ? d.models.map(code).join(', ') : 'any model the provider accepts'} |

## Prerequisites

${pre}

Run \`krama doctor\` to check them on your machine.

## Environment

| Variable | Required | | Description |
|---|---|---|---|
${env}

Bind secrets with \`backend.secrets\` (variable name to secret reference). Values are never written to config files.

## Options

Set these under \`backend.options\` in an agent definition.

| Option | Type | Description |
|---|---|---|
${opts}
`;
};

for (const d of reg.list()) writeFileSync(join(out, `${d.id}.md`), page(d));
writeFileSync(
  join(out, 'index.md'),
  `# Backends

> Generated from the built-in backend descriptors.

Krama talks to every coding agent through an [A2A](https://a2a-protocol.org) wrapper. Each wrapper shares one core and adds its own provider section, credentials and prerequisites.

| Backend | Package | Can orchestrate | Cost reporting |
|---|---|---|---|
${reg
  .list()
  .map(
    (d) =>
      `| [${d.label}](./${d.id}.md) | ${code(d.package.name)} | ${d.capabilities.canOrchestrate ? 'yes' : 'no'} | ${d.capabilities.cost} |`,
  )
  .join('\n')}

Need another provider? See [Adding a backend](../../guides/adding-a-backend.md).
`,
);
console.log(`Wrote ${reg.list().length + 1} pages to ${out}`);
