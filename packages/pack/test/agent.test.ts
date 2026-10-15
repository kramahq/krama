import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BackendDescriptor } from '@kramahq/contract';
import { afterAll, describe, expect, it } from 'vitest';
import { loadAgentDir } from '../src/index.js';

const dirs: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'krama-agent-load-'));
  dirs.push(dir);
  return dir;
};
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
const descriptor = {
  id: 'worker',
  providerKey: 'worker',
  capabilities: { canOrchestrate: false, cost: 'not_reported' },
  env: [],
  options: [],
} as unknown as BackendDescriptor;
const env = { backends: { list: () => [descriptor], get: () => descriptor } };
const config = (extra: object = {}) =>
  JSON.stringify({
    agentCard: { name: 'Worker', description: 'A standalone worker.' },
    worker: {},
    ...extra,
  });

describe('standalone wrapper configuration validation', () => {
  it('accepts workers that cannot orchestrate, and reports missing files and provider errors', async () => {
    const dir = temp();
    writeFileSync(join(dir, 'config.json'), config());
    expect((await loadAgentDir(dir, env)).ok).toBe(true);
    writeFileSync(join(dir, 'config.json'), config({ worker: null }));
    expect((await loadAgentDir(dir, env)).ok).toBe(false);
    writeFileSync(join(dir, 'config.json'), config());
    const invalid = await loadAgentDir(dir, {
      ...env,
      checkProviderConfig: () => [{ path: 'model', message: 'Invalid model' }],
    });
    expect(invalid.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'config.worker.model', code: 'provider_config' }),
      ]),
    );
    writeFileSync(join(dir, 'config.json'), config({ memory: { instructions: 'missing.md' } }));
    expect((await loadAgentDir(dir, env)).issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'file_missing', path: 'config.memory.instructions' }),
      ]),
    );
  });
  it('refuses literal credentials without returning their values', async () => {
    const dir = temp();
    writeFileSync(
      join(dir, 'config.json'),
      config({ mcp: { svc: { env: { TOKEN: 'fixture-credential' } } } }),
    );
    const result = await loadAgentDir(dir, env);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result.issues)).not.toContain('fixture-credential');
  });
  it('keeps referenced files inside the source checkout, including symlink targets', async () => {
    const root = temp();
    const dir = join(root, 'agent');
    mkdirSync(dir);
    const outside = temp();
    const file = join(outside, 'private.md');
    writeFileSync(file, 'outside');
    writeFileSync(join(dir, 'config.json'), config({ memory: { instructions: file } }));
    expect((await loadAgentDir(dir, env, {}, root)).issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'path_outside_source' })]),
    );
    writeFileSync(join(root, 'shared.md'), 'within checkout');
    writeFileSync(join(dir, 'config.json'), config({ memory: { instructions: '../shared.md' } }));
    expect((await loadAgentDir(dir, env, {}, root)).ok).toBe(true);
    if (process.platform !== 'win32') {
      symlinkSync(file, join(dir, 'link.md'));
      writeFileSync(join(dir, 'config.json'), config({ memory: { instructions: 'link.md' } }));
      expect((await loadAgentDir(dir, env, {}, root)).issues).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: 'path_outside_source' })]),
      );
    }
  });
});
