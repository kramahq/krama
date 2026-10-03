import type { AgentDefinition, RosterEntry } from '@kramahq/contract';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DomainError, matchDefinitions, resolveRoster } from '../../src/index.js';

const def = (id: string, backend: string, caps: string[], cost?: number): AgentDefinition => {
  const [role, variant] = id.split('/') as [string, string];
  return {
    id,
    role,
    variant,
    name: id,
    description: id,
    backend: { wrapper: backend },
    skills: [],
    mcpServers: [],
    permissions: { tools: {} },
    memory: { enabled: false, scopes: [] },
    capabilities: caps,
    source: { type: 'local' },
    links: {},
    ...(cost !== undefined
      ? { costHint: { perMillionTokens: { amount: cost, currency: 'USD' as const } } }
      : {}),
  };
};

describe('matching a request to definitions', () => {
  const defs = [
    def('developer/codex', 'a2a-codex', ['code', 'tests'], 6),
    def('developer/claude', 'a2a-claude', ['code', 'tests', 'refactor'], 15),
    def('developer/cheap', 'a2a-opencode', ['code'], 1),
    def('developer/unpriced', 'a2a-copilot', ['code', 'tests']),
    def('reviewer/claude', 'a2a-claude', ['code-review']),
  ];

  it('orders by capability coverage, then backend, then cost, then id', () => {
    const r = matchDefinitions(defs, {
      role: 'developer',
      capabilities: ['code', 'tests'],
      backend: 'a2a-claude',
    });
    // Full coverage first (codex, claude, unpriced); among them the preferred backend, then cheaper, unknown cost last.
    expect(r.map((c) => c.definition.id)).toEqual([
      'developer/claude',
      'developer/codex',
      'developer/unpriced',
      'developer/cheap',
    ]);
    expect(r[0]).toMatchObject({ coverage: 1, backendMatch: true });
    expect(r.at(-1)).toMatchObject({ coverage: 0.5 });
    expect(r[0]!.reasons).toEqual(
      expect.arrayContaining(['capability:code', 'backend:a2a-claude', 'cost:15']),
    );
  });

  it('breaks ties on cost with unknown last, then id', () => {
    const r = matchDefinitions(defs, { role: 'developer', capabilities: ['code', 'tests'] });
    expect(r.map((c) => c.definition.id)).toEqual([
      'developer/codex',
      'developer/claude',
      'developer/unpriced',
      'developer/cheap',
    ]);
  });

  it('filters by role, drops zero coverage, honours a cost ceiling and the usable predicate', () => {
    expect(matchDefinitions(defs, { role: 'reviewer' }).map((c) => c.definition.id)).toEqual([
      'reviewer/claude',
    ]);
    expect(
      matchDefinitions(defs, { capabilities: ['code-review'] }).map((c) => c.definition.id),
    ).toEqual(['reviewer/claude']);
    expect(
      matchDefinitions(defs, { role: 'developer', capabilities: ['code'], maxCostPerMTok: 6 }).map(
        (c) => c.definition.id,
      ),
    ).toEqual(['developer/cheap', 'developer/codex', 'developer/unpriced']);
    expect(
      matchDefinitions(defs, { role: 'developer' }, (d) => d.backend.wrapper !== 'a2a-codex').map(
        (c) => c.definition.id,
      ),
    ).not.toContain('developer/codex');
    expect(matchDefinitions(defs, { capabilities: ['nothing'] })).toEqual([]);
  });

  it('property: a candidate with strictly higher coverage never ranks below one with lower coverage, and the order is deterministic', () => {
    const caps = ['a', 'b', 'c', 'd'];
    const gen = fc.array(
      fc.record({
        id: fc.stringMatching(/^[a-z]{1,4}\/[a-z]{1,4}$/),
        backend: fc.constantFrom('x', 'y', 'z'),
        caps: fc.subarray(caps),
        cost: fc.option(fc.integer({ min: 1, max: 50 }), { nil: undefined }),
      }),
      { maxLength: 12 },
    );
    fc.assert(
      fc.property(
        gen,
        fc.subarray(caps),
        fc.constantFrom('x', 'y', undefined),
        (rows, want, backend) => {
          const unique = rows.filter((r, i) => rows.findIndex((x) => x.id === r.id) === i);
          const defs2 = unique.map((r) => def(r.id, r.backend, r.caps, r.cost));
          const req = {
            ...(want.length ? { capabilities: want } : {}),
            ...(backend ? { backend } : {}),
          };
          const a = matchDefinitions(defs2, req);
          const b = matchDefinitions([...defs2].reverse(), req);
          expect(a.map((c) => c.definition.id)).toEqual(b.map((c) => c.definition.id));
          for (let i = 1; i < a.length; i++)
            expect(a[i - 1]!.coverage).toBeGreaterThanOrEqual(a[i]!.coverage);
        },
      ),
    );
  });
});

describe('resolving a pack roster', () => {
  const defs = [
    def('developer/default', 'a2a-codex', ['code'], 6),
    def('analyst/default', 'a2a-claude', ['requirements']),
    def('reviewer/default', 'a2a-claude', ['code-review']),
    def('reviewer/codex', 'a2a-codex', ['code-review'], 3),
  ];
  const usable = (...ids: string[]) => ({ backendUsable: (b: string) => ids.includes(b) });
  const roster = (...e: RosterEntry[]) => e;

  it('resolves pinned definitions, capability selection and pinned backends', () => {
    const r = resolveRoster(
      roster(
        {
          role: 'developer',
          select: { definitionId: 'developer/default', backend: 'a2a-claude' },
          count: 2,
        },
        { role: 'analyst', select: { capabilities: ['requirements'] } },
        { role: 'reviewer', select: { capabilities: ['code-review'], backend: 'a2a-codex' } },
      ),
      defs,
      usable('a2a-codex', 'a2a-claude'),
    );
    expect(r.resolved.map((x) => `${x.role}:${x.definition.id}@${x.backend} x${x.count}`)).toEqual([
      'developer:developer/default@a2a-claude x2',
      'analyst:analyst/default@a2a-claude x1',
      'reviewer:reviewer/codex@a2a-codex x1',
    ]);
    expect(r.resolved[2]!.alternatives.map((c) => c.definition.id)).toEqual(['reviewer/default']);
  });

  it('lists every unfilled required role at once with the reason', () => {
    try {
      resolveRoster(
        roster(
          { role: 'developer', select: { definitionId: 'developer/default' } },
          { role: 'qa', select: { capabilities: ['testing'] } },
          { role: 'analyst', select: { definitionId: 'analyst/missing' } },
        ),
        defs,
        usable('a2a-claude'),
      );
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(DomainError);
      const err = e as DomainError;
      expect(err.code).toBe('roster_unsatisfied');
      expect(err.problemCode).toBe('roster_unsatisfied');
      expect((err.details as { missing: { role: string }[] }).missing.map((m) => m.role)).toEqual([
        'developer',
        'qa',
        'analyst',
      ]);
      expect(err.message).toContain('backend "a2a-codex" is not available');
    }
  });

  it('skips optional roles that cannot be filled instead of failing', () => {
    const r = resolveRoster(
      roster(
        { role: 'devops', select: { capabilities: ['deploy'] }, optional: true },
        { role: 'analyst', select: {} },
      ),
      defs,
      usable('a2a-claude'),
    );
    expect(r.skipped).toEqual([
      { role: 'devops', reason: expect.stringContaining('no usable definition') },
    ]);
    expect(r.resolved.map((x) => x.role)).toEqual(['analyst']);
  });

  it('treats a pinned backend as a requirement and says so', () => {
    expect(() =>
      resolveRoster(
        roster({ role: 'analyst', select: { backend: 'a2a-codex' } }),
        defs,
        usable('a2a-codex', 'a2a-claude'),
      ),
    ).toThrow(/no usable definition runs on a2a-codex/);
  });
});
