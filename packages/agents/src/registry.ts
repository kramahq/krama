import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { backendDescriptor, type BackendDescriptor } from '@kramahq/contract';
import type { BackendCatalog } from '@kramahq/engine';
import claude from './backends/a2a-claude.json' with { type: 'json' };
import codex from './backends/a2a-codex.json' with { type: 'json' };
import copilot from './backends/a2a-copilot.json' with { type: 'json' };
import opencode from './backends/a2a-opencode.json' with { type: 'json' };
import antigravity from './backends/a2a-antigravity.json' with { type: 'json' };

export interface LoadProblem {
  file: string;
  errors: string[];
}

export interface LoadResult {
  loaded: string[];
  problems: LoadProblem[];
}

/** Descriptors shipped with Krama. Each is a plain JSON file in `src/backends/`. */
export const BUILTIN_BACKENDS: readonly unknown[] = [claude, codex, copilot, opencode, antigravity];

/**
 * The set of known backends. Built-ins load first; user and pack descriptors are added from
 * directories of `*.json` files (a user file with a built-in's id replaces it, with a warning
 * available from `overrides`). Invalid files are reported, never silently skipped, and never stop the rest from loading.
 */
export class BackendRegistry implements BackendCatalog {
  private readonly map = new Map<string, BackendDescriptor>();
  /** Ids that a later source replaced. */
  readonly overrides: {
    id: string;
    from: BackendDescriptor['origin'];
    by: BackendDescriptor['origin'];
  }[] = [];

  /** A registry holding the built-in backends. */
  static withBuiltins(): BackendRegistry {
    const r = new BackendRegistry();
    for (const raw of BUILTIN_BACKENDS) r.register(raw, 'builtin');
    return r;
  }

  /** Validates and registers one descriptor. Throws with readable messages when invalid. */
  register(
    raw: unknown,
    origin: NonNullable<BackendDescriptor['origin']> = 'user',
  ): BackendDescriptor {
    const parsed = backendDescriptor.safeParse(raw);
    if (!parsed.success) {
      throw new Error(
        parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '),
      );
    }
    const d: BackendDescriptor = { ...parsed.data, origin };
    delete d.$schema;
    const dupKeys = d.options.map((o) => o.key).filter((k, i, a) => a.indexOf(k) !== i);
    if (dupKeys.length)
      throw new Error(`options: duplicate keys ${[...new Set(dupKeys)].join(', ')}`);
    const prior = this.map.get(d.id);
    if (prior) this.overrides.push({ id: d.id, from: prior.origin, by: origin });
    this.map.set(d.id, d);
    return d;
  }

  unregister(id: string): boolean {
    return this.map.delete(id);
  }

  /** Loads every `*.json` in a directory. A missing directory is not an error. */
  loadDir(dir: string, origin: NonNullable<BackendDescriptor['origin']> = 'user'): LoadResult {
    const result: LoadResult = { loaded: [], problems: [] };
    let names: string[];
    try {
      if (!statSync(dir).isDirectory()) return result;
      names = readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .sort();
    } catch {
      return result;
    }
    for (const name of names) {
      const file = join(dir, name);
      try {
        result.loaded.push(this.register(JSON.parse(readFileSync(file, 'utf8')), origin).id);
      } catch (e) {
        result.problems.push({
          file,
          errors: [
            e instanceof SyntaxError ? `not valid JSON: ${e.message}` : (e as Error).message,
          ],
        });
      }
    }
    return result;
  }

  list(): BackendDescriptor[] {
    return [...this.map.values()].sort((a, b) => a.id.localeCompare(b.id));
  }
  get(id: string): BackendDescriptor | undefined {
    return this.map.get(id);
  }
  has(id: string): boolean {
    return this.map.has(id);
  }
}
