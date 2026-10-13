import { isAbsolute, resolve } from 'node:path';

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The config with the paths of the files it points at (`memory.instructions`, each `memory.skills[]`) made absolute against
 * `dir`, the directory they were written for. The wrapper resolves them against its own config file, which Krama writes
 * elsewhere, so a relative path would not be found. The input is not changed.
 */
export function withAbsolutePaths(
  config: Record<string, unknown>,
  dir: string,
): Record<string, unknown> {
  const memory = config['memory'];
  if (!isObject(memory)) return config;
  const at = (p: unknown) => (typeof p === 'string' && !isAbsolute(p) ? resolve(dir, p) : p);
  const next: Record<string, unknown> = { ...memory };
  if ('instructions' in next) next['instructions'] = at(next['instructions']);
  if (Array.isArray(next['skills'])) next['skills'] = next['skills'].map(at);
  return { ...config, memory: next };
}
