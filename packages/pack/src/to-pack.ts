import type { Pack, PermissionRequest } from '@kramahq/contract';
import semver from 'semver';
import { formatGitSource } from './git-source.js';
import type { PackLoad } from './load.js';

export interface InstallInfo {
  /** Where the pack came from and the commit it was pinned to. */
  source: { url: string; ref: string; sha: string; path?: string };
  trust: Pack['trust'];
  status: Pack['status'];
  installedAt?: string;
  permissions: readonly PermissionRequest[];
  /** The version of Krama checking compatibility, e.g. `0.3.0`. */
  engineVersion: string;
}

/** Whether a Krama version satisfies a pack's `engine` range. A pack that asks for nothing fits every version. */
export function engineCompatible(range: string | undefined, version: string): boolean {
  if (!range) return true;
  const v = semver.coerce(version);
  return (
    !!v &&
    semver.validRange(range) !== null &&
    semver.satisfies(v, range, { includePrerelease: true })
  );
}

/**
 * A loaded pack as the catalogue shows it (the contract's `Pack`): the pack file's fields, each agent in the form a client
 * reads, the permissions it asks for, and where it was installed from. Throws for a load that failed; check `load.ok`.
 */
export function toPack(load: PackLoad, info: InstallInfo): Pack {
  const file = load.file;
  if (!file || !load.ok) throw new Error('A pack that did not load cannot be put in the catalogue');
  const agents: NonNullable<Pack['agents']> = {};
  for (const [id, a] of Object.entries(file.agents)) {
    const r = load.agents[id]!;
    agents[id] = {
      ...(a.role ? { role: a.role } : {}),
      ...(a.description ? { description: a.description } : {}),
      ...(a.external ? { external: a.external } : {}),
      ...(r.git ? { git: formatGitSource(r.git) } : {}),
      ...(a.config ? { config: a.config } : {}),
      ...(a.secrets ? { secrets: a.secrets } : {}),
      ...(a.subAgents ? { subAgents: a.subAgents } : {}),
    };
  }
  const mcpServers = new Set<string>();
  for (const r of Object.values(load.agents)) {
    const mcp = r.config?.['mcp'];
    if (mcp && typeof mcp === 'object') for (const name of Object.keys(mcp)) mcpServers.add(name);
  }
  const secrets = new Set(Object.values(load.agents).flatMap((r) => Object.values(r.secrets)));
  return {
    id: `pack_${file.name}`,
    name: file.name,
    version: file.version,
    description: file.description,
    ...(file.icon ? { icon: file.icon } : {}),
    tags: file.tags ?? [],
    status: info.status,
    source: {
      type: 'git',
      url: info.source.url,
      ref: info.source.ref,
      sha: info.source.sha,
      ...(info.source.path ? { path: info.source.path } : {}),
    },
    trust: info.trust,
    engine: {
      requires: file.engine ?? '*',
      compatible: engineCompatible(file.engine, info.engineVersion),
    },
    orchestrator: file.orchestrator,
    agents,
    inputsSchema: file.inputsSchema ?? {},
    ui: file.ui ?? {},
    artifactTypes: file.artifactTypes ?? [],
    requirements: {
      mcpServers: [...mcpServers],
      secrets: [...secrets],
      workItemSources: file.requirements?.workItemSources ?? [],
    },
    permissions: [...info.permissions],
    memoryScopes: file.memoryScopes ?? [],
    tests: { suites: 0 },
    ...(info.installedAt ? { installedAt: info.installedAt } : {}),
    links: {},
  };
}
