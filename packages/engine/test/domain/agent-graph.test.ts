import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  DomainError,
  resolveAgentGraph,
  validateAgentGraph,
  type AgentGraphInput,
} from '../../src/index.js';

const ref = (agent: string, hint?: string) => ({ agent, ...(hint ? { hint } : {}) });

/** orchestrator -> reviewer -> researcher, and orchestrator -> researcher too: one agent shared by two parents. */
const threeLevel: AgentGraphInput = {
  orchestrator: 'planner',
  agents: {
    planner: {
      subAgents: [ref('author'), ref('reviewer', 'check every draft'), ref('researcher')],
    },
    author: {},
    reviewer: { subAgents: [ref('researcher', 'verify facts')] },
    researcher: {},
  },
};

const issuesOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(DomainError);
    expect((e as DomainError).code).toBe('invalid_graph');
    return (e as DomainError).details?.issues as { path: string; message: string }[];
  }
  throw new Error('expected the graph to be rejected');
};

describe('resolveAgentGraph', () => {
  it('starts leaves first and the orchestrator last, each agent once', () => {
    const g = resolveAgentGraph(threeLevel);
    expect(g.order).toEqual(['author', 'researcher', 'reviewer', 'planner']);
    expect(new Set(g.order).size).toBe(g.order.length);
  });

  it('keeps hints and declared order per parent', () => {
    const g = resolveAgentGraph(threeLevel);
    expect(g.children.planner).toEqual([
      { agent: 'author' },
      { agent: 'reviewer', hint: 'check every draft' },
      { agent: 'researcher' },
    ]);
    expect(g.children.reviewer).toEqual([{ agent: 'researcher', hint: 'verify facts' }]);
  });

  it('records both parents of a shared agent (one instance per run)', () => {
    const g = resolveAgentGraph(threeLevel);
    expect([...g.parents.researcher!].sort()).toEqual(['planner', 'reviewer']);
    expect(g.parents.planner).toEqual([]);
  });

  it('an agent nobody references cannot be reached and is not started', () => {
    const g = resolveAgentGraph({
      ...threeLevel,
      agents: { ...threeLevel.agents, stray: { subAgents: [ref('author')] } },
    });
    expect(g.unreachable).toEqual(['stray']);
    expect(g.order).not.toContain('stray');
    expect(g.parents.author).not.toContain('stray');
  });

  it('a one-agent graph is just the orchestrator', () => {
    expect(resolveAgentGraph({ orchestrator: 'solo', agents: { solo: {} } }).order).toEqual([
      'solo',
    ]);
  });

  it('an external agent is a valid leaf', () => {
    const g = resolveAgentGraph({
      orchestrator: 'planner',
      agents: { planner: { subAgents: [ref('vendor')] }, vendor: { external: true } },
    });
    expect(g.order).toEqual(['vendor', 'planner']);
  });
});

describe('validateAgentGraph', () => {
  it('rejects a cycle and names the loop and the offending reference', () => {
    const issues = issuesOf(() =>
      resolveAgentGraph({
        orchestrator: 'a',
        agents: {
          a: { subAgents: [ref('b')] },
          b: { subAgents: [ref('c')] },
          c: { subAgents: [ref('a')] },
        },
      }),
    );
    expect(issues).toEqual([
      { path: 'agents.c.subAgents[0].agent', message: 'Cycle: a -> b -> c -> a' },
    ]);
  });

  it('rejects an agent that references itself', () => {
    const issues = validateAgentGraph({
      orchestrator: 'a',
      agents: { a: { subAgents: [ref('a')] } },
    });
    expect(issues.map((i) => i.message)).toEqual(['Cycle: a -> a']);
  });

  it('reports a cycle that the orchestrator cannot reach', () => {
    const issues = validateAgentGraph({
      orchestrator: 'a',
      agents: { a: {}, x: { subAgents: [ref('y')] }, y: { subAgents: [ref('x')] } },
    });
    expect(issues.some((i) => i.message.startsWith('Cycle:'))).toBe(true);
  });

  it('rejects an unknown reference with its path', () => {
    const issues = issuesOf(() =>
      resolveAgentGraph({
        orchestrator: 'a',
        agents: { a: { subAgents: [ref('b'), ref('ghost')] }, b: {} },
      }),
    );
    expect(issues).toEqual([
      { path: 'agents.a.subAgents[1].agent', message: '"ghost" is not in the agent catalogue' },
    ]);
  });

  it('rejects an unknown or external orchestrator', () => {
    expect(
      validateAgentGraph({ orchestrator: 'nobody', agents: { a: {} } }).map((i) => i.path),
    ).toEqual(['orchestrator']);
    expect(
      validateAgentGraph({ orchestrator: 'a', agents: { a: { external: true } } })[0]?.message,
    ).toMatch(/external/);
  });

  it('rejects sub-agents on an external agent and duplicate references', () => {
    const issues = validateAgentGraph({
      orchestrator: 'a',
      agents: {
        a: { subAgents: [ref('v'), ref('v')] },
        v: { external: true, subAgents: [ref('a')] },
      },
    });
    const paths = issues.map((i) => i.path);
    expect(paths).toContain('agents.v.subAgents');
    expect(paths).toContain('agents.a.subAgents[1].agent');
  });

  it('rejects ids that are not valid sub-agent names', () => {
    const issues = validateAgentGraph({
      orchestrator: 'Bad_Id',
      agents: { Bad_Id: {} },
    });
    expect(issues.map((i) => i.path)).toContain('agents.Bad_Id');
  });

  it('reports every problem at once', () => {
    const issues = validateAgentGraph({
      orchestrator: 'a',
      agents: { a: { subAgents: [ref('ghost'), ref('b')] }, b: { subAgents: [ref('a')] } },
    });
    expect(issues).toHaveLength(2);
  });
});

describe('agent graph (property)', () => {
  /** A random DAG: agent i may only reference agents with a higher index, so no cycle can exist. */
  const dag = fc
    .integer({ min: 1, max: 9 })
    .chain((n) =>
      fc.tuple(
        ...Array.from({ length: n }, (_, i) => {
          const later = Array.from({ length: n - i - 1 }, (_, k) => `a${i + k + 1}`);
          return fc.subarray(later, { maxLength: Math.min(4, later.length) });
        }),
      ),
    )
    .map((lists): AgentGraphInput => ({
      orchestrator: 'a0',
      agents: Object.fromEntries(
        lists.map((refs, i) => [`a${i}`, { subAgents: refs.map((r) => ref(r)) }]),
      ),
    }));

  it('every agent starts after everything it references, and exactly the reachable ones start', () => {
    fc.assert(
      fc.property(dag, (input) => {
        const g = resolveAgentGraph(input);
        const at = new Map(g.order.map((id, i) => [id, i]));
        expect(at.size).toBe(g.order.length);
        for (const id of g.order)
          for (const r of input.agents[id]!.subAgents ?? [])
            expect(at.get(r.agent)!).toBeLessThan(at.get(id)!);
        expect(g.order.at(-1)).toBe('a0');
        expect([...g.order, ...g.unreachable].sort()).toEqual(Object.keys(input.agents).sort());
      }),
    );
  });

  it('adding an edge back to an ancestor always makes the graph invalid', () => {
    fc.assert(
      fc.property(dag, fc.nat(), (input, pick) => {
        const g = resolveAgentGraph(input);
        // Pick a reachable agent that has a child; point the child back at it.
        const withChild = g.order.filter((id) => g.children[id]!.length > 0);
        if (withChild.length === 0) return;
        const parent = withChild[pick % withChild.length]!;
        const child = g.children[parent]![0]!.agent;
        const bad: AgentGraphInput = {
          ...input,
          agents: {
            ...input.agents,
            [child]: { subAgents: [...(input.agents[child]!.subAgents ?? []), ref(parent)] },
          },
        };
        expect(validateAgentGraph(bad).some((i) => i.message.startsWith('Cycle:'))).toBe(true);
      }),
    );
  });
});
