import { describe, expect, it } from 'vitest';
import { EnvSecretResolver, SystemClock, UlidIdGenerator } from '../src/index.js';

describe('system adapters', () => {
  it('generates prefixed, unique, sortable ULIDs, monotonic within a millisecond', () => {
    const g = new UlidIdGenerator();
    const ids = Array.from({ length: 5000 }, () => g.next('run'));
    expect(new Set(ids).size).toBe(5000);
    expect(ids.every((i) => /^run_[0-9A-HJKMNP-TV-Z]{26}$/.test(i))).toBe(true);
    expect([...ids].sort()).toEqual(ids);
  });
  it('resolves secrets from the environment by reference name', async () => {
    const r = new EnvSecretResolver({ KRAMA_SECRET_OPENAI_MAIN: 'sk-x' });
    expect(await r.resolve('openai-main')).toBe('sk-x');
    expect(await r.resolve('missing')).toBeUndefined();
  });
  it('tells the time', () => {
    const before = Date.now();
    const actual = new SystemClock().now().getTime();
    const after = Date.now();
    expect(actual).toBeGreaterThanOrEqual(before);
    expect(actual).toBeLessThanOrEqual(after);
  });
});
