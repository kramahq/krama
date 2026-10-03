import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { agentDefinition, type AgentDefinition } from '@kramahq/contract';
import type { BackendCatalog } from '@kramahq/engine';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { validateOptions } from './options.js';

/** An agent definition together with the text files that sit next to it. */
export interface DefinitionBundle {
  definition: AgentDefinition;
  /** Contents of `prompt.md` (the persona / system prompt). Empty when absent. */
  systemPrompt: string;
  /** Contents of `context.md` (project context handed to the agent). Empty when absent. */
  context: string;
  dir: string;
}

export interface DefinitionProblem {
  /** Path of the file or directory with the problem. */
  path: string;
  errors: string[];
  /** Warnings do not stop the definition from loading. */
  warnings?: string[];
}

export interface DefinitionLoadResult {
  bundles: DefinitionBundle[];
  problems: DefinitionProblem[];
}

const NAME = /^[a-z][a-z0-9-]*$/;

/** What an author writes in `agent.yaml`; `id`, `role`, `variant` and `source` come from where the file lives. */
const file = agentDefinition
  .omit({ id: true, role: true, variant: true, source: true, links: true })
  .partial({
    mcpServers: true,
    skills: true,
    permissions: true,
    memory: true,
    capabilities: true,
  });

const FILES = ['agent.yaml', 'agent.yml', 'agent.json'];
const read = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8') : '');

/**
 * Loads `<root>/<role>/<variant>/agent.yaml` (or `.json`) with optional `prompt.md` and `context.md`.
 * The id is `role/variant`, taken from the folder names. Every definition is checked against the backend
 * registry: unknown backend, unknown or mistyped options, and secret bindings the backend does not use.
 * Bad definitions are reported and skipped; the rest still load.
 */
export function loadDefinitions(
  root: string,
  catalog: BackendCatalog,
  source: AgentDefinition['source'] = { type: 'local' },
): DefinitionLoadResult {
  const out: DefinitionLoadResult = { bundles: [], problems: [] };
  let roles: string[];
  try {
    roles = readdirSync(root)
      .filter((n) => statSync(join(root, n)).isDirectory())
      .sort();
  } catch {
    return out;
  }
  for (const role of roles) {
    const roleDir = join(root, role);
    for (const variant of readdirSync(roleDir)
      .filter((n) => statSync(join(roleDir, n)).isDirectory())
      .sort()) {
      const dir = join(roleDir, variant);
      const problem = (errors: string[], warnings?: string[]) =>
        out.problems.push({ path: dir, errors, ...(warnings?.length ? { warnings } : {}) });
      if (!NAME.test(role) || !NAME.test(variant)) {
        problem([
          `"${role}/${variant}": role and variant must be lowercase letters, digits and dashes`,
        ]);
        continue;
      }
      const defFile = FILES.map((f) => join(dir, f)).find(existsSync);
      if (!defFile) {
        problem([`no ${FILES.join(' / ')} found`]);
        continue;
      }
      let raw: unknown;
      try {
        raw = defFile.endsWith('.json')
          ? JSON.parse(readFileSync(defFile, 'utf8'))
          : parseYaml(readFileSync(defFile, 'utf8'));
      } catch (e) {
        out.problems.push({ path: defFile, errors: [`could not parse: ${(e as Error).message}`] });
        continue;
      }
      const parsed = file.safeParse(raw);
      if (!parsed.success) {
        out.problems.push({
          path: defFile,
          errors: parsed.error.issues.map(
            (i: z.core.$ZodIssue) => `${i.path.join('.') || '(root)'}: ${i.message}`,
          ),
        });
        continue;
      }
      const d = parsed.data;
      const errors: string[] = [];
      const warnings: string[] = [];
      const descriptor = catalog.get(d.backend.wrapper);
      if (!descriptor) {
        errors.push(
          `backend "${d.backend.wrapper}" is not registered. Registered: ${catalog
            .list()
            .map((b) => b.id)
            .join(', ')}`,
        );
      } else {
        for (const i of validateOptions(descriptor, d.backend.options, { workspaceProvided: true }))
          errors.push(`backend.options.${i.path}: ${i.message}`);
        const envNames = new Set(descriptor.env.map((e) => e.name));
        for (const name of Object.keys(d.backend.secrets ?? {}))
          if (!envNames.has(name))
            warnings.push(
              `backend.secrets.${name}: ${descriptor.id} does not read this variable (reads: ${[...envNames].join(', ') || 'none'})`,
            );
      }
      if (errors.length) {
        problem(errors, warnings);
        continue;
      }
      if (warnings.length) problem([], warnings);
      const definition: AgentDefinition = agentDefinition.parse({
        skills: [],
        mcpServers: [],
        permissions: { tools: {} },
        memory: { enabled: false, scopes: [] },
        capabilities: [],
        ...d,
        id: `${role}/${variant}`,
        role,
        variant,
        source,
        links: {},
      });
      out.bundles.push({
        definition,
        systemPrompt: read(join(dir, 'prompt.md')),
        context: read(join(dir, 'context.md')),
        dir,
      });
    }
  }
  const ids = out.bundles.map((b) => b.definition.id);
  if (new Set(ids).size !== ids.length)
    out.problems.push({ path: root, errors: ['duplicate definition ids'] });
  return out;
}
