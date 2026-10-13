import { stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import type { PermissionRequest } from '@kramahq/contract';
import type { BackendCatalog } from '@kramahq/engine';
import { formatGitSource } from './git-source.js';
import type { PackLoad, ResolvedAgent } from './load.js';

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const permission = (p: Omit<PermissionRequest, 'id'>): PermissionRequest => ({
  id: `${p.kind}:${p.subject}:${p.requestedBy}`,
  ...p,
});

const hostOf = (url: string): string | undefined => {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
};

/** Whether a directory exists, for the question "does this skill ship scripts". */
const isDir = (p: string): Promise<boolean> =>
  stat(p).then(
    (s) => s.isDirectory(),
    () => false,
  );

/**
 * What installing a pack asks a person to allow (PACK-FORMAT, "the permission surface"): the MCP servers its agents start
 * or reach, the hosts they call, the secrets they are given, the scripts their skills carry, the backend settings that
 * loosen a sandbox, and the memory it reads or writes. Nothing here grants anything; it is what a person reads before
 * consenting. Each entry names the agent that asks for it.
 */
export async function permissionSurface(
  load: PackLoad,
  backends?: BackendCatalog,
): Promise<PermissionRequest[]> {
  const out = new Map<string, PermissionRequest>();
  const add = (p: Omit<PermissionRequest, 'id'>) => {
    const full = permission(p);
    out.set(full.id, full);
  };
  for (const agent of Object.values(load.agents)) {
    if (agent.kind === 'external') {
      const ext = load.file?.agents[agent.id]?.external;
      if (ext) {
        const host = hostOf(ext.agentCardUrl);
        add({
          kind: 'network',
          subject: host ?? ext.agentCardUrl,
          access: 'A2A agent',
          risk: ext.agentCardUrl.startsWith('https:') ? 'medium' : 'high',
          reason: `Calls the external agent ${ext.name}${ext.agentCardUrl.startsWith('https:') ? '' : ' over plain http'}`,
          requestedBy: agent.id,
        });
      }
    }
    for (const [name, ref] of Object.entries(agent.secrets))
      add({
        kind: 'secret_ref',
        subject: ref,
        access: `as ${name}`,
        risk: 'medium',
        reason: `${agent.id} is given the secret ${ref} as the environment variable ${name}`,
        requestedBy: agent.id,
      });
    if (agent.config) await surfaceOfConfig(agent, add, backends);
  }
  for (const m of load.file?.memoryScopes ?? [])
    add({
      kind: 'memory_scope',
      subject: m.scope,
      access: m.access,
      risk: m.access === 'write' ? 'medium' : 'low',
      requestedBy: load.file?.orchestrator ?? 'pack',
    });
  return [...out.values()];
}

async function surfaceOfConfig(
  agent: ResolvedAgent,
  add: (p: Omit<PermissionRequest, 'id'>) => void,
  backends?: BackendCatalog,
): Promise<void> {
  const config = agent.config!;
  const mcp = config['mcp'];
  if (isObject(mcp))
    for (const [name, server] of Object.entries(mcp)) {
      if (!isObject(server)) continue;
      const url = typeof server['url'] === 'string' ? server['url'] : undefined;
      const command = server['command'];
      const target = url ?? (Array.isArray(command) ? command.join(' ') : String(command ?? ''));
      add({
        kind: 'mcp_server',
        subject: name,
        access: url ? `connects to ${target}` : `runs ${target}`,
        // A server Krama's agent starts as a process can do anything the person can; a remote one only what its API offers.
        risk: url ? 'medium' : 'high',
        requestedBy: agent.id,
      });
      const host = url ? hostOf(url) : undefined;
      if (host)
        add({
          kind: 'network',
          subject: host,
          access: `MCP server ${name}`,
          risk: url!.startsWith('https:') ? 'low' : 'medium',
          requestedBy: agent.id,
        });
    }

  // Settings the backend itself marks as risky, when the config sets them away from the default.
  const descriptor = backends?.list().find((b) => b.providerKey in config);
  const section = descriptor ? config[descriptor.providerKey] : undefined;
  if (descriptor && isObject(section))
    for (const o of descriptor.options)
      if (o.risk === 'high' && o.key in section && section[o.key] !== o.default)
        add({
          kind: 'workspace',
          subject: `${descriptor.providerKey}.${o.key}`,
          access: String(section[o.key]),
          risk: 'high',
          reason: o.description,
          requestedBy: agent.id,
        });

  // A skill that ships a scripts/ directory runs code the first time an agent uses it.
  const memory = config['memory'];
  const skills = isObject(memory) && Array.isArray(memory['skills']) ? memory['skills'] : [];
  for (const rel of skills) {
    if (typeof rel !== 'string') continue;
    const dir = isAbsolute(rel) ? rel : agent.dir ? resolve(agent.dir, rel) : undefined;
    if (dir && (await isDir(join(dir, 'scripts'))))
      add({
        kind: 'script_execution',
        subject: rel,
        access: 'scripts/',
        risk: 'high',
        reason: 'The skill ships scripts that can run',
        requestedBy: agent.id,
      });
  }
}

/** The secret references a pack needs bound, with the variable each is given as and who needs it. */
export function secretRefs(load: PackLoad): { ref: string; description: string }[] {
  const byRef = new Map<string, string[]>();
  for (const agent of Object.values(load.agents))
    for (const [name, ref] of Object.entries(agent.secrets)) {
      const list = byRef.get(ref) ?? [];
      list.push(`${agent.id} (${name})`);
      byRef.set(ref, list);
    }
  return [...byRef].map(([ref, who]) => ({ ref, description: `Needed by ${who.join(', ')}` }));
}

export interface PackDiff {
  added: string[];
  removed: string[];
  changed: { path: string; summary: string }[];
  permissionChanges: PermissionRequest[];
}

/**
 * What changes between two loads of a pack: agents added or removed, agents whose resolved config (or the commit it came
 * from) changed, rewired sub-agents, the version, and the permissions the new one asks for that the old one did not.
 */
export function diffLoads(
  from: PackLoad,
  to: PackLoad,
  fromPerms: readonly PermissionRequest[],
  toPerms: readonly PermissionRequest[],
): PackDiff {
  const a = from.agents;
  const b = to.agents;
  const added = Object.keys(b)
    .filter((id) => !(id in a))
    .map((id) => `agents.${id}`);
  const removed = Object.keys(a)
    .filter((id) => !(id in b))
    .map((id) => `agents.${id}`);
  const changed: PackDiff['changed'] = [];
  if (from.file && to.file && from.file.version !== to.file.version)
    changed.push({ path: 'version', summary: `${from.file.version} to ${to.file.version}` });
  if (from.file && to.file && from.file.orchestrator !== to.file.orchestrator)
    changed.push({
      path: 'orchestrator',
      summary: `${from.file.orchestrator} to ${to.file.orchestrator}`,
    });
  for (const id of Object.keys(b).filter((x) => x in a)) {
    const x = a[id]!;
    const y = b[id]!;
    if (x.sha && y.sha && x.sha !== y.sha)
      changed.push({
        path: `agents.${id}`,
        summary: `${x.sha.slice(0, 10)} to ${y.sha.slice(0, 10)}`,
      });
    else if (x.git && y.git && formatGitSource(x.git) !== formatGitSource(y.git))
      changed.push({
        path: `agents.${id}`,
        summary: `${formatGitSource(x.git)} to ${formatGitSource(y.git)}`,
      });
    else if (JSON.stringify(x.config ?? null) !== JSON.stringify(y.config ?? null))
      changed.push({ path: `agents.${id}`, summary: 'its configuration changed' });
    const wired = (r: ResolvedAgent) =>
      r.subAgents
        .map((s) => `${s.agent}:${s.hint ?? ''}`)
        .sort()
        .join('|');
    if (wired(x) !== wired(y))
      changed.push({
        path: `agents.${id}.subAgents`,
        summary: 'its sub-agents or their hints changed',
      });
  }
  const had = new Set(fromPerms.map((p) => p.id));
  return { added, removed, changed, permissionChanges: toPerms.filter((p) => !had.has(p.id)) };
}
