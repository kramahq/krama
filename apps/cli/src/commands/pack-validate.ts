import { existsSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { BackendRegistry, validateOptions } from '@kramahq/agents';
import { Git, Sources } from '@kramahq/git';
import { loadPackDir, PACK_FILE, type PackLoadEnv } from '@kramahq/pack';

export interface ValidateOptions {
  /** Fetch the agents a pack takes from git, at their pinned commits, so their configs are checked too. */
  online?: boolean;
  /** The backends policy allows; empty or absent means all of them. */
  allowedBackends?: readonly string[];
}

export interface PackReport {
  /** The directory the pack was read from, as given. */
  dir: string;
  name?: string;
  version?: string;
  ok: boolean;
  issues: { severity: 'error' | 'warn'; code: string; path: string; message: string }[];
}

/** The packs in `dir`: the directory itself when it holds a pack file, otherwise each of its folders that does. */
export function findPacks(dir: string): string[] {
  const root = resolve(dir);
  if (existsSync(join(root, PACK_FILE))) return [root];
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
    .map((e) => join(root, e.name))
    .filter((d) => existsSync(join(d, PACK_FILE)))
    .sort();
}

/** Validates every pack found in `dir` against the real backend descriptors. Never throws for a pack that is wrong. */
export async function validatePacks(dir: string, o: ValidateOptions = {}): Promise<PackReport[]> {
  const scratch = o.online ? mkdtempSync(join(tmpdir(), 'krama pack validate ')) : undefined;
  try {
    const sources = scratch
      ? await Sources.open({ root: join(scratch, 'sources'), git: new Git() })
      : undefined;
    const env: PackLoadEnv = {
      backends: BackendRegistry.withBuiltins(),
      ...(o.allowedBackends?.length ? { allowedBackends: o.allowedBackends } : {}),
      checkProviderConfig: (d, section) =>
        validateOptions(d, section).map((i) => ({ path: i.path, message: i.message })),
      ...(sources ? { resolveGit: (s) => sources.resolveGit(s) } : {}),
    };
    const reports: PackReport[] = [];
    for (const d of findPacks(dir)) {
      const load = await loadPackDir(d, env).catch((e: unknown) => ({
        ok: false,
        file: undefined,
        agents: {},
        issues: [
          {
            severity: 'error' as const,
            code: 'load_failed',
            path: '',
            message: e instanceof Error ? e.message : String(e),
          },
        ],
      }));
      reports.push({
        dir: d,
        ...(load.file ? { name: load.file.name, version: load.file.version } : {}),
        ok: load.ok,
        issues: load.issues.map((i) => ({
          severity: i.severity === 'error' ? 'error' : 'warn',
          code: i.code,
          path: i.path,
          message: i.message,
        })),
      });
    }
    return reports;
  } finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
}

/** The report as a person reads it. */
export function formatReports(reports: readonly PackReport[]): string {
  const out: string[] = [];
  for (const r of reports) {
    const label = r.name ? `${r.name} ${r.version ?? ''}`.trim() : r.dir;
    const errors = r.issues.filter((i) => i.severity === 'error').length;
    const warns = r.issues.length - errors;
    out.push(
      `${r.ok ? 'ok     ' : 'INVALID'} ${label}${r.issues.length ? `  (${errors} error${errors === 1 ? '' : 's'}, ${warns} warning${warns === 1 ? '' : 's'})` : ''}`,
    );
    for (const i of r.issues)
      out.push(`  ${i.severity === 'error' ? 'error' : 'warn '}  ${i.path || '-'}  ${i.message}`);
  }
  return out.join('\n');
}
