import {
  artifactTypeDef,
  externalAgent,
  jsonSchema,
  memoryAccess,
  memoryScopeType,
  packUi,
  permissionRequest,
  subAgentRef,
} from '@kramahq/contract';
import { parse as parseYaml, YAMLParseError } from 'yaml';
import { z } from 'zod';
import { error, type PackIssue } from './issues.js';

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** One catalogue entry as written: exactly one of `git`, `config`, `external` (checked by the loader, which can name it). */
const agentEntry = z
  .object({
    git: z
      .union([
        z.string(),
        z.object({ url: z.string(), ref: z.string().optional(), path: z.string().optional() }),
      ])
      .optional(),
    config: z.record(z.string(), z.unknown()).optional(),
    external: externalAgent.optional(),
    role: z.string().optional(),
    description: z.string().optional(),
    secrets: z.record(z.string(), z.string()).optional(),
    subAgents: z.array(subAgentRef).optional(),
  })
  .strict();
export type AgentEntry = z.infer<typeof agentEntry>;

/** `krama-pack.yaml` (PACK-FORMAT §2). Unknown keys are refused, so a misspelled field is an error, not silence. */
export const packFile = z
  .object({
    name: z.string().regex(/^[a-z0-9-]+$/, 'Use lowercase letters, digits and hyphens'),
    version: z.string().regex(SEMVER, 'Use a semantic version, e.g. 0.1.0'),
    description: z.string().min(1),
    engine: z.string().optional(),
    orchestrator: z.string(),
    agents: z.record(z.string(), agentEntry),
    tags: z.array(z.string()).optional(),
    icon: z.string().optional(),
    /** Delegation modes the pack supports; a graph pack needs `native`. */
    delegation: z.array(z.enum(['native', 'krama'])).optional(),
    inputsSchema: jsonSchema.optional(),
    ui: packUi.optional(),
    artifactTypes: z.array(artifactTypeDef).optional(),
    memoryScopes: z.array(z.object({ scope: memoryScopeType, access: memoryAccess })).optional(),
    requirements: z
      .object({
        mcpServers: z.array(z.string()).default([]),
        secrets: z.array(z.string()).default([]),
        workItemSources: z.array(z.string()).default([]),
      })
      .optional(),
    permissions: z.array(permissionRequest).optional(),
  })
  .strict();
export type PackFile = z.infer<typeof packFile>;

/** A zod path as the pack's own dotted-and-indexed path: `['agents','a','subAgents',0]` -> `agents.a.subAgents[0]`. */
export const pathOf = (parts: readonly PropertyKey[]): string =>
  parts.reduce<string>(
    (out, p) => (typeof p === 'number' ? `${out}[${p}]` : out ? `${out}.${String(p)}` : String(p)),
    '',
  );

export function parsePackText(text: string): { file?: PackFile; issues: PackIssue[] } {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (e) {
    const line = e instanceof YAMLParseError ? e.linePos?.[0]?.line : undefined;
    return {
      issues: [
        error(
          'invalid_yaml',
          line ? `line ${line}` : '',
          `The pack is not valid YAML: ${(e as Error).message.split('\n')[0]}`,
        ),
      ],
    };
  }
  const r = packFile.safeParse(raw);
  if (r.success) return { file: r.data, issues: [] };
  return {
    issues: r.error.issues.map((i) => {
      // An unrecognised key arrives with the path of its parent: name it.
      const keys = i.code === 'unrecognized_keys' ? (i as { keys: string[] }).keys : undefined;
      const path = keys ? keys.map((k) => pathOf([...i.path, k])).join(', ') : pathOf(i.path);
      return error(
        keys ? 'unknown_field' : 'invalid_field',
        path,
        keys ? `Unknown field ${keys.map((k) => `"${k}"`).join(', ')}` : i.message,
      );
    }),
  };
}
