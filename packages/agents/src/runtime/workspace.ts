import { lstatSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

const SAFE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

/** Neutral workspace layout for agents: no tracker or methodology names, safe against traversal and symlinks. */
export class WorkspaceManager {
  private readonly base: string;
  constructor(baseDir: string) {
    this.base = resolve(baseDir);
    mkdirSync(this.base, { recursive: true });
  }

  /** Rejects anything that could escape the base directory (separators, `..`, NUL, leading dots). */
  private name(part: string, what: string): string {
    if (!SAFE.test(part) || part.includes('..'))
      throw new Error(`Invalid ${what} "${part}": use letters, digits, dot, dash or underscore`);
    return part;
  }

  private ensure(dir: string): string {
    const abs = resolve(dir);
    if (abs !== this.base && !abs.startsWith(this.base + sep))
      throw new Error(`Path escapes the workspace root: ${abs}`);
    try {
      if (lstatSync(abs).isSymbolicLink())
        throw new Error(`Workspace path "${abs}" is a symlink; refusing to use it`);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      mkdirSync(abs, { recursive: true });
    }
    return abs;
  }

  /** One directory shared by every agent of a run, so downstream agents see upstream files. */
  shared(key: string): string {
    return this.ensure(join(this.base, 'runs', this.name(key, 'workspace key'), 'shared'));
  }

  /** A private directory for one agent instance. */
  isolated(key: string, agentId: string): string {
    return this.ensure(
      join(
        this.base,
        'runs',
        this.name(key, 'workspace key'),
        'agents',
        this.name(agentId, 'agent id'),
      ),
    );
  }

  /** Long-lived memory directory for a role/variant. */
  memory(role: string, variant: string): string {
    return this.ensure(
      join(this.base, 'memory', this.name(role, 'role'), this.name(variant, 'variant')),
    );
  }

  /** Removes everything for a run (all workspaces). */
  removeRun(key: string): void {
    const dir = resolve(join(this.base, 'runs', this.name(key, 'workspace key')));
    if (dir.startsWith(this.base + sep)) rmSync(dir, { recursive: true, force: true });
  }
}
