import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ApiProblem,
  ConfigError,
  IdempotencyStore,
  PolicyError,
  ROLES,
  TokenAuth,
  decodeCursor,
  loadConfig,
  paginate,
  parseExpand,
  parseIfMatch,
  parseSort,
  pickFields,
  resolvePolicy,
  satisfies,
  sortBy,
  type Principal,
} from '../src/index.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'krama-cfg-'));
const TOKEN = 'unit-test-token-0123456789';

describe('loadConfig', () => {
  it('defaults to loopback and the default port, and generates a private token file once', () => {
    const home = tmp();
    const a = loadConfig({ argv: ['--home', home], env: {} });
    expect(a).toMatchObject({ host: '127.0.0.1', port: 4747, tokenGenerated: true });
    expect(a.token.length).toBeGreaterThanOrEqual(16);
    const file = join(home, 'token');
    expect(readFileSync(file, 'utf8').trim()).toBe(a.token);
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o077).toBe(0);
    const b = loadConfig({ argv: ['--home', home], env: {} });
    expect(b.token).toBe(a.token);
    expect(b.tokenGenerated).toBe(false);
  });

  it('prefers the flag over the environment, and does not write a token file when one is given', () => {
    const home = tmp();
    const c = loadConfig({
      argv: ['--home', home, '--port', '5000', '--token', TOKEN],
      env: { KRAMA_PORT: '6000', KRAMA_TOKEN: 'env-token-0123456789abc' },
    });
    expect(c.port).toBe(5000);
    expect(c.token).toBe(TOKEN);
    expect(existsSync(join(home, 'token'))).toBe(false);
  });

  it('refuses a non-loopback host unless remote access is explicit', () => {
    const base = { argv: ['--home', tmp(), '--token', TOKEN] };
    expect(() =>
      loadConfig({ ...base, argv: [...base.argv, '--host', '0.0.0.0'], env: {} }),
    ).toThrow(ConfigError);
    expect(
      loadConfig({ ...base, argv: [...base.argv, '--host', '0.0.0.0', '--allow-remote'], env: {} })
        .host,
    ).toBe('0.0.0.0');
  });

  it.each([
    [['--port', '70000']],
    [['--port', 'abc']],
    [['--token', 'short']],
    [['--bogus']],
    [['--delegation-mode', 'sideways']],
  ])('rejects bad input %j', (extra) => {
    expect(() =>
      loadConfig({ argv: ['--home', tmp(), '--token', TOKEN, ...extra], env: {} }),
    ).toThrow(ConfigError);
  });

  it('layers the policy: defaults, then policy.json, then the environment, then flags', () => {
    const home = tmp();
    writeFileSync(
      join(home, 'policy.json'),
      JSON.stringify({
        allowedBackends: ['a2a-claude', 'a2a-codex'],
        delegation: { mode: 'krama', proxy: 'on' },
        externalHosts: ['agents.example.com'],
        defaultOrchestrator: { definitionId: 'lead', backend: 'a2a-claude' },
      }),
    );
    const base = ['--home', home, '--token', TOKEN];
    const file = loadConfig({ argv: base, env: {} });
    expect(file.policy.delegation).toEqual({ mode: 'krama', proxy: 'on' });
    expect(file.policy.engine.allowedBackends).toEqual(['a2a-claude', 'a2a-codex']);
    expect(file.policy.engine.defaultOrchestrator?.definitionId).toBe('lead');
    expect(file.policySources).toEqual(['built-in defaults', join(home, 'policy.json')]);

    const env = loadConfig({
      argv: base,
      env: { KRAMA_ALLOWED_BACKENDS: 'a2a-codex', KRAMA_DELEGATION_MODE: 'native' },
    });
    expect(env.policy.engine.allowedBackends).toEqual(['a2a-codex']); // a list replaces, it does not merge
    expect(env.policy.delegation).toEqual({ mode: 'native', proxy: 'on' }); // untouched keys survive

    const flag = loadConfig({
      argv: [...base, '--delegation-mode', 'krama', '--delegation-proxy', 'off'],
      env: { KRAMA_DELEGATION_MODE: 'native' },
    });
    expect(flag.policy.delegation).toEqual({ mode: 'krama', proxy: 'off' });
    expect(flag.policy.engine.defaultDelegation).toBe('krama');
    expect(flag.policySources.at(-1)).toBe('command line');
  });

  it('has native delegation, no proxy and no external hosts by default', () => {
    expect(resolvePolicy()).toEqual({
      engine: { defaultDelegation: 'native' },
      delegation: { mode: 'native', proxy: 'off' },
      externalHosts: [],
    });
  });

  it('fails loudly on a missing, malformed or unknown-key policy file', () => {
    const home = tmp();
    const base = ['--home', home, '--token', TOKEN];
    expect(() =>
      loadConfig({ argv: [...base, '--policy', join(home, 'nope.json')], env: {} }),
    ).toThrow(PolicyError);
    const bad = join(home, 'bad.json');
    writeFileSync(bad, '{not json');
    expect(() => loadConfig({ argv: [...base, '--policy', bad], env: {} })).toThrow(
      /not valid JSON/,
    );
    const typo = join(home, 'typo.json');
    writeFileSync(typo, JSON.stringify({ allowedBackend: ['x'] }));
    expect(() => loadConfig({ argv: [...base, '--policy', typo], env: {} })).toThrow(/not valid/);
    expect(() => loadConfig({ argv: base, env: { KRAMA_DELEGATION_PROXY: 'maybe' } })).toThrow(
      PolicyError,
    );
  });
});

describe('roles', () => {
  const as = (...roles: string[]): Principal => ({ id: 'u', name: 'U', roles, permissions: [] });
  it('lets a higher role do what a lower one can', () => {
    expect(satisfies(as('viewer'), 'viewer')).toBe(true);
    expect(satisfies(as('viewer'), 'requester')).toBe(false);
    expect(satisfies(as('operator'), 'approver')).toBe(true);
    expect(satisfies(as('admin'), 'admin')).toBe(true);
    expect(satisfies(as('operator'), 'admin')).toBe(false);
  });
  it('accepts any alternative, ignores the (own) qualifier, and treats owner as admin', () => {
    expect(satisfies(as('requester'), 'requester(own)/operator')).toBe(true);
    expect(satisfies(as('viewer'), 'requester(own)/operator')).toBe(false);
    expect(satisfies(as('admin'), 'owner/admin')).toBe(true);
  });
  it('needs no role for public and any, and never grants an unknown requirement', () => {
    expect(satisfies(as(), 'public')).toBe(true);
    expect(satisfies(as(), 'any')).toBe(true);
    expect(satisfies(as(...ROLES), 'wizard')).toBe(false);
  });
});

describe('TokenAuth', () => {
  const a = new TokenAuth(TOKEN);
  it('accepts exactly the token as a bearer credential', () => {
    expect(a.authenticate(`Bearer ${TOKEN}`)?.id).toBe('u_local');
    expect(a.authenticate(`bearer ${TOKEN}`)?.id).toBe('u_local');
    expect(a.authenticate(`Bearer ${TOKEN}x`)).toBeUndefined();
    expect(a.authenticate(TOKEN)).toBeUndefined();
    expect(a.authenticate(undefined)).toBeUndefined();
  });
});

describe('pagination, sorting, expansion, fields', () => {
  const items = Array.from({ length: 120 }, (_, i) => ({ id: `i${i}`, n: i }));
  it('defaults to 50, caps at 200, and walks every item exactly once via the cursor', () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const p = paginate(items, { limit: 50, cursor });
      seen.push(...p.items.map((i) => i.id));
      cursor = p.nextCursor;
    } while (cursor);
    expect(seen).toEqual(items.map((i) => i.id));
    expect(paginate(items, {}).items).toHaveLength(50);
    expect(paginate(items, { limit: 9999 }).items).toHaveLength(120);
    expect(paginate(items, { limit: 50 }).total).toBe(120);
    expect(paginate(items.slice(0, 3), {}).nextCursor).toBeUndefined();
  });
  it('rejects a cursor it did not issue', () => {
    expect(() => decodeCursor('garbage')).toThrow(ApiProblem);
  });
  it('sorts by allowed fields, descending with a minus', () => {
    const keys = parseSort('-n', ['n'], { field: 'n', desc: false });
    expect(sortBy(items, keys)[0]?.id).toBe('i119');
    expect(() => parseSort('secret', ['n'], { field: 'n', desc: false })).toThrow(/Cannot sort/);
    expect(parseSort(undefined, ['n'], { field: 'n', desc: true })).toEqual([
      { field: 'n', desc: true },
    ]);
  });
  it('checks expand names against what the resource offers', () => {
    expect([...parseExpand('phases,cost', ['phases', 'cost', 'decisions'])]).toEqual([
      'phases',
      'cost',
    ]);
    expect(() => parseExpand('logs', ['phases'])).toThrow(/Cannot expand/);
  });
  it('trims fields but always keeps the id', () => {
    expect(pickFields({ id: 'a', title: 't', big: 'x' }, 'title')).toEqual({ id: 'a', title: 't' });
    expect(pickFields({ id: 'a', title: 't' }, undefined)).toEqual({ id: 'a', title: 't' });
  });
});

describe('If-Match', () => {
  it('parses a version ETag, weak or strong', () => {
    expect(parseIfMatch('"v3"', true)).toBe(3);
    expect(parseIfMatch('W/"v3"', true)).toBe(3);
    expect(parseIfMatch(undefined, false)).toBeUndefined();
  });
  it('is required (428) when the route says so, and 412 when unreadable', () => {
    expect(() => parseIfMatch(undefined, true)).toThrow(
      expect.objectContaining({ problem: expect.objectContaining({ status: 428 }) }),
    );
    expect(() => parseIfMatch('abc', true)).toThrow(
      expect.objectContaining({ problem: expect.objectContaining({ status: 412 }) }),
    );
  });
});

describe('IdempotencyStore', () => {
  const fp = (b: unknown) => IdempotencyStore.fingerprint('POST', '/runs', b);
  const res = { status: 201, body: { ok: 1 }, headers: {} };

  it('is scoped to the caller', () => {
    const s = new IdempotencyStore();
    expect(s.begin('alice', 'k', fp(1))).toBeUndefined();
    s.complete('alice', 'k', res);
    expect(s.begin('bob', 'k', fp(1))).toBeUndefined();
    expect(s.begin('alice', 'k', fp(1))).toEqual(res);
  });
  it('refuses a second call while the first is still running', () => {
    const s = new IdempotencyStore();
    s.begin('a', 'k', fp(1));
    expect(() => s.begin('a', 'k', fp(1))).toThrow(/still being processed/);
    s.abandon('a', 'k');
    expect(s.begin('a', 'k', fp(1))).toBeUndefined();
  });
  it('forgets a 5xx answer, and expires old entries', () => {
    let t = 0;
    const s = new IdempotencyStore({ ttlMs: 1000, now: () => t });
    s.begin('a', 'k', fp(1));
    s.complete('a', 'k', { ...res, status: 503 });
    expect(s.begin('a', 'k', fp(1))).toBeUndefined();
    s.complete('a', 'k', res);
    t = 2000;
    expect(s.begin('a', 'k', fp(1))).toBeUndefined();
  });
  it('bounds memory and rejects absurd keys', () => {
    const s = new IdempotencyStore({ max: 2 });
    for (const k of ['1', '2', '3']) {
      s.begin('a', k, fp(k));
      s.complete('a', k, res);
    }
    expect(s.begin('a', '1', fp('1'))).toBeUndefined(); // oldest was evicted
    expect(() => s.begin('a', 'x'.repeat(300), fp(1))).toThrow(ApiProblem);
    expect(() => s.begin('a', '', fp(1))).toThrow(ApiProblem);
  });
});
