import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  viewerId,
  type Capabilities,
  type Me,
  type ViewerId,
  type health,
} from '@kramahq/contract';
import type { z } from 'zod';
import { ROLES, toMe } from './auth.js';
import type { ApiContext, Handlers } from './context.js';
import { ApiProblem } from './problems.js';

type Health = z.infer<typeof health>;
type Status = Health['status'];

/** Viewers the UI can render today; the rest fall back to download. */
const VIEWERS: ViewerId[] = viewerId.options.filter(
  (v) => v !== 'slides' && v !== 'html-sandboxed',
);

/** Defaults for `capabilities.limits`. They are reported, not yet enforced (M12 hardening). */
export const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;
export const MAX_RUNS_CONCURRENT = 8;
export const MAX_AGENTS = 16;

/** What this server really offers, so the UI hides what is not there. Grows as milestones land. */
export function buildCapabilities(c: ApiContext): Capabilities {
  const { krama } = c;
  return {
    apiVersion: 'v1',
    engineVersion: c.version,
    a2a: { versions: ['0.3'] },
    features: {
      runs: true,
      decisions: true,
      packs: true,
      packInstallFromGit: false, // M9.1
      skills: false, // M9.3
      memory: { enabled: false, scopes: [], export: [], gitSync: false }, // M8
      schedules: { enabled: false, triggers: [] }, // M11
      packTests: false, // M6.4
      builder: false, // M10
      typedArtifacts: true,
      eventReplay: true,
      multiProject: true,
      auth: { mode: 'token', roles: [...ROLES] },
    },
    workItemSources: [],
    backends: krama.backends.list().map((b) => ({
      wrapper: b.id,
      label: b.label,
      models: b.models,
      canOrchestrate: b.capabilities.canOrchestrate,
    })),
    viewers: VIEWERS,
    limits: {
      maxUploadBytes: MAX_UPLOAD_BYTES,
      maxRunsConcurrent: MAX_RUNS_CONCURRENT,
      agentCapacity: {
        used: krama.runtime.list().filter((a) => a.status !== 'stopped').length,
        max: MAX_AGENTS,
      },
    },
    deprecations: [],
  };
}

const worst = (a: Status, b: Status): Status =>
  a === 'down' || b === 'down' ? 'down' : a === 'degraded' || b === 'degraded' ? 'degraded' : 'ok';

/** Liveness and component status. A failing component is reported, never thrown. */
export async function buildHealth(c: ApiContext): Promise<Health> {
  const components: Health['components'] = {};

  try {
    await c.krama.ports.store.runs.list({ limit: 1 });
    components['store'] = { status: 'ok' };
  } catch (e) {
    components['store'] = { status: 'down', detail: (e as Error).message };
  }

  const agents = c.krama.runtime.list();
  const unhealthy = agents.filter((a) => a.status === 'unhealthy').length;
  components['agents'] = unhealthy
    ? { status: 'degraded', detail: `${unhealthy} of ${agents.length} agents unhealthy` }
    : { status: 'ok' };

  const parked = c.krama.collector.stats.parked;
  components['events'] = parked
    ? { status: 'degraded', detail: `${parked} agent events could not be attributed` }
    : { status: 'ok' };

  const status = Object.values(components).reduce<Status>((s, x) => worst(s, x.status), 'ok');
  return { status, version: c.version, components };
}

/** RFC 7396 JSON Merge Patch: `null` removes a key, objects merge, everything else replaces. */
export function mergePatch(target: Record<string, unknown>, patch: Record<string, unknown>) {
  const out = { ...target };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else if (
      typeof v === 'object' &&
      !Array.isArray(v) &&
      typeof out[k] === 'object' &&
      out[k] &&
      !Array.isArray(out[k])
    )
      out[k] = mergePatch(out[k] as Record<string, unknown>, v as Record<string, unknown>);
    else out[k] = v;
  }
  return out;
}

/** UI preferences for the one local user, kept in `<home>/preferences.json` (written atomically). */
export class Preferences {
  private readonly file: string;
  private cache: Record<string, unknown> | undefined;
  constructor(home: string) {
    this.file = join(home, 'preferences.json');
  }
  get(): Record<string, unknown> {
    if (this.cache) return this.cache;
    try {
      const v: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
      this.cache =
        v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
    } catch {
      this.cache = {};
    }
    return this.cache;
  }
  patch(p: Record<string, unknown>): Record<string, unknown> {
    const next = mergePatch(this.get(), p);
    if (JSON.stringify(next).length > 64 * 1024)
      throw new ApiProblem('validation_failed', 'Preferences are limited to 64 KiB');
    mkdirSync(join(this.file, '..'), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2));
    renameSync(tmp, this.file);
    this.cache = next;
    return next;
  }
}

export function platformHandlers(prefs: Preferences): Handlers {
  return {
    getCapabilities: (req) => buildCapabilities(req.ctx),
    getHealth: (req) => buildHealth(req.ctx),
    getMe: (req): Me => toMe(req.principal, prefs.get()),
    patchPreferences: (req): Me => {
      if (typeof req.body !== 'object' || req.body === null || Array.isArray(req.body))
        throw new ApiProblem('validation_failed', 'Expected a JSON object');
      return toMe(req.principal, prefs.patch(req.body as Record<string, unknown>));
    },
  };
}
