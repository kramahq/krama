import type { BackendDescriptor, Pack, PackAgent } from '@kramahq/contract';
import { StaticSecretResolver } from '@kramahq/engine/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { renderAgentsSection } from '../src/index.js';
import { pack } from './rig.js';
import {
  call,
  newRun,
  playOrchestrator,
  statusOf,
  system,
  until,
  user,
  type System,
} from './runner-rig.js';

const live: System[] = [];
afterEach(async () => {
  await Promise.allSettled(live.splice(0).map((s) => s.stop()));
});

/** Only the fields the graph code reads. */
const backend = (id: string, providerKey: string) => ({ id, providerKey }) as BackendDescriptor;
const BACKENDS = [backend('a2a-claude', 'claude'), backend('a2a-codex', 'codex')];

const card = (name: string, extra: Record<string, unknown> = {}) => ({
  agentCard: { name, skills: [{ id: 'work', name }] },
  ...extra,
});

/**
 *   planner ─┬─ author ── vendor (external)
 *            ├─ reviewer ── researcher
 *            └─ researcher            (shared by planner and reviewer)
 *   stray                             (nobody references it)
 */
const catalogue = (): Record<string, PackAgent> => ({
  planner: {
    role: 'orchestrator',
    config: card('planner', { claude: { systemPromptAppend: 'You coordinate the team.' } }),
    subAgents: [
      { agent: 'author', hint: 'Writes and revises the draft' },
      { agent: 'reviewer', hint: 'check every draft' },
      { agent: 'researcher', hint: 'Internal policy questions' },
    ],
  },
  author: {
    definition: 'author/default',
    subAgents: [{ agent: 'vendor', hint: 'Market data we do not have' }],
  },
  reviewer: {
    config: card('reviewer', { claude: { systemPromptAppend: 'You review drafts.' } }),
    description: 'Reviews drafts',
    subAgents: [{ agent: 'researcher', hint: 'verify facts' }],
  },
  researcher: {
    config: card('researcher', { codex: {} }),
    description: 'Looks things up',
  },
  vendor: {
    description: 'A vendor research service',
    external: {
      name: 'vendor',
      agentCardUrl: 'https://research.example.com/.well-known/agent-card.json',
      auth: { mode: 'bearer', token: '${VENDOR_TOKEN}' },
    },
    secrets: { VENDOR_TOKEN: 'vendor-token' },
  },
  stray: { config: card('stray', { codex: {} }), subAgents: [{ agent: 'author' }] },
});

const graphPack = (agents = catalogue(), orchestrator = 'planner'): Pack => ({
  ...pack(),
  orchestrator,
  agents,
});

const make = async (
  p: Pack,
  policy: object = { defaultDelegation: 'native' },
  withCollector = false,
) => {
  const s = await system(undefined, policy, [p], withCollector);
  s.p.backends = { list: () => BACKENDS, get: (id) => BACKENDS.find((b) => b.id === id) };
  s.p.secrets = new StaticSecretResolver({ 'vendor-token': 'tok-123' });
  live.push(s);
  return s;
};

const cardOf = (url: string) => `${url}/.well-known/agent-card.json`;
const subAgents = (s: System, id: string) =>
  (
    s.p.agents.spawned.find((x) => x.definition.id === id)?.overrides?.subAgents as {
      agents: { name: string; agentCardUrl: string; auth?: unknown }[];
    }
  ).agents;

describe('a run over an agent graph (native delegation)', () => {
  it('starts leaves first, gives each parent exactly its children, and shares an agent between parents', async () => {
    const s = await make(graphPack());
    const runId = await newRun(s);
    s.p.gateway.queue(
      'orchestrator',
      playOrchestrator(s, async (c) => {
        for (const phaseId of ['draft', 'review'])
          await call(c, 'record_phase_outcome', {
            phaseId,
            status: 'success',
            reason: 'done',
            gating: 'continue',
          });
      }),
    );
    await s.runner.start(runId);
    await until(async () => (await statusOf(s, runId)) === 'awaiting_decision');

    const spawned = s.p.agents.spawned;
    // Leaves before the parents that need their addresses; the orchestrator last; external and unreachable agents never.
    expect(spawned.map((x) => x.definition.id)).toEqual([
      'author/default',
      'researcher',
      'reviewer',
      'planner',
    ]);
    // The shared agent is one instance for the run.
    expect(spawned.filter((x) => x.definition.id === 'researcher')).toHaveLength(1);

    const at = (id: string) => s.p.agents.list().find((a) => a.definitionId === id)!;
    const researcher = at('researcher');

    // The reviewer can call the researcher and nobody else.
    expect(subAgents(s, 'reviewer')).toEqual([
      { name: 'researcher', agentCardUrl: cardOf(researcher.url), auth: { mode: 'none' } },
    ]);
    // The planner can call its three, with live addresses.
    expect(subAgents(s, 'planner')).toEqual([
      { name: 'author', agentCardUrl: cardOf(at('author/default').url), auth: { mode: 'none' } },
      { name: 'reviewer', agentCardUrl: cardOf(at('reviewer').url), auth: { mode: 'none' } },
      { name: 'researcher', agentCardUrl: cardOf(researcher.url), auth: { mode: 'none' } },
    ]);
    // The author reaches the external vendor through the declared entry, and gets the token it needs in its environment.
    expect(subAgents(s, 'author/default')).toEqual([
      {
        name: 'vendor',
        agentCardUrl: 'https://research.example.com/.well-known/agent-card.json',
        auth: { mode: 'bearer', token: '${VENDOR_TOKEN}' },
      },
    ]);
    expect(spawned[0]!.env).toMatchObject({ VENDOR_TOKEN: 'tok-123' });
    // The leaf calls nobody.
    expect(spawned.find((x) => x.definition.id === 'researcher')!.overrides).toBeUndefined();

    expect(s.errors).toEqual([]);
  });

  it('keeps each agent’s own config and adds the hints to the caller’s prompt', async () => {
    const s = await make(graphPack());
    const runId = await newRun(s);
    s.p.gateway.queue(
      'orchestrator',
      playOrchestrator(s, async () => undefined),
    );
    await s.runner.start(runId);
    await until(() => s.p.agents.spawned.some((x) => x.definition.id === 'planner'));

    const reviewer = s.p.agents.spawned.find((x) => x.definition.id === 'reviewer')!;
    // The agent's own config is passed through untouched; its prompt gets the section appended.
    expect(reviewer.baseConfig).toEqual({ json: catalogue().reviewer!.config });
    expect(reviewer.systemPrompt).toBe(
      '## Agents you can call\n- researcher: Looks things up. When to use: verify facts.',
    );
    expect(reviewer.definition.backend.wrapper).toBe('a2a-claude');

    const planner = s.p.agents.spawned.find((x) => x.definition.id === 'planner')!;
    expect(planner.definition.backend.wrapper).toBe('a2a-claude');
    expect(planner.systemPrompt).toContain(
      '**reviewer** — Reviews drafts. When to use: check every draft',
    );
    expect(planner.systemPrompt).toContain('**author**');
    expect(planner.systemPrompt).toContain('Internal policy questions');
    expect(planner.systemPrompt).not.toContain('delegate_to_agent');
    expect(planner.systemPrompt).not.toContain('stray');
    expect(planner.mcp).toMatchObject({ krama: { type: 'http' } });
    expect(planner.env?.KRAMA_MCP_TOKEN).toBeTruthy();

    // A definition-sourced agent keeps its persona and gets the hint section after it.
    const author = s.p.agents.spawned.find((x) => x.definition.id === 'author/default')!;
    expect(author.baseConfig).toBeUndefined();
    expect(author.systemPrompt).toBe(
      '## Agents you can call\n- vendor: A vendor research service. When to use: Market data we do not have.',
    );
  });

  it('releases every instance with the run', async () => {
    const s = await make(graphPack());
    const runId = await newRun(s);
    s.p.gateway.queue(
      'orchestrator',
      playOrchestrator(s, async (c) => {
        for (const phaseId of ['draft', 'review'])
          await call(c, 'record_phase_outcome', {
            phaseId,
            status: 'success',
            reason: 'done',
            gating: 'continue',
          });
      }),
    );
    await s.runner.start(runId);
    await until(async () => (await statusOf(s, runId)) === 'awaiting_decision');
    const dec = (await s.p.store.decisions.list({ runId, status: ['pending'] })).items[0]!.value
      .decision;
    await s.engine.decisions.resolve(dec.id, { optionId: 'approve' }, user);
    await until(async () => (await statusOf(s, runId)) === 'completed');
    await s.runner.idle(runId);
    expect(s.p.agents.list({ status: ['idle', 'busy', 'starting'] })).toEqual([]);
    expect(s.mcp.tokens.size).toBe(0);
  });
});

describe('where agents report their activity', () => {
  const sink = (spec: { overrides?: Record<string, unknown> }) =>
    spec.overrides?.events as
      { transport: string; httpUrl: string; httpHeaders: { Authorization: string } } | undefined;

  it('gives agents Krama does not call a sink with a token that names the run and the instance, and none to the orchestrator', async () => {
    const s = await make(graphPack(), { defaultDelegation: 'native' }, true);
    const runId = await newRun(s);
    s.p.gateway.queue(
      'orchestrator',
      playOrchestrator(s, async (c) => {
        for (const phaseId of ['draft', 'review'])
          await call(c, 'record_phase_outcome', {
            phaseId,
            status: 'success',
            reason: 'done',
            gating: 'continue',
          });
      }),
    );
    await s.runner.start(runId);
    await until(async () => (await statusOf(s, runId)) === 'awaiting_decision');

    const spawned = s.p.agents.spawned;
    const researcher = spawned.find((x) => x.definition.id === 'researcher')!;
    const events = sink(researcher)!;
    expect(events).toMatchObject({
      transport: 'http',
      httpUrl: `${s.collector!.url}/agent-events`,
    });
    // The instance id was fixed before the agent started, so the token can name it.
    expect(researcher.instanceId).toBeTruthy();
    expect(
      s.collector!.tokens.verify(events.httpHeaders.Authorization.replace('Bearer ', '')),
    ).toEqual({
      runId,
      instanceId: researcher.instanceId,
      agent: 'researcher',
      role: 'researcher',
      backend: 'a2a-codex',
    });
    // Every worker has its own token; the orchestrator, which Krama calls itself, has none.
    const tokens = spawned
      .filter((x) => x.definition.id !== 'planner')
      .map((x) => sink(x)!.httpHeaders.Authorization);
    expect(new Set(tokens).size).toBe(3);
    expect(sink(spawned.find((x) => x.definition.id === 'planner')!)).toBeUndefined();
    // The sink keeps the subAgents the same spec carries.
    expect(researcher.overrides).not.toHaveProperty('subAgents');
    expect(spawned.find((x) => x.definition.id === 'reviewer')!.overrides).toHaveProperty(
      'subAgents',
    );

    // Done with the run: the tokens stop working.
    const dec = (await s.p.store.decisions.list({ runId, status: ['pending'] })).items[0]!.value
      .decision;
    await s.engine.decisions.resolve(dec.id, { optionId: 'approve' }, user);
    await until(async () => (await statusOf(s, runId)) === 'completed');
    await s.runner.idle(runId);
    expect(s.collector!.tokens.size).toBe(0);
    expect(s.errors).toEqual([]);
  });

  it('configures no sink when there is no collector', async () => {
    const s = await make(graphPack());
    const runId = await newRun(s);
    s.p.gateway.queue(
      'orchestrator',
      playOrchestrator(s, async () => undefined),
    );
    await s.runner.start(runId);
    await until(() => s.p.agents.spawned.some((x) => x.definition.id === 'planner'));
    for (const x of s.p.agents.spawned) expect(sink(x)).toBeUndefined();
  });

  it('sends the run with every orchestrator turn', async () => {
    const s = await make(graphPack());
    const runId = await newRun(s);
    const seen: unknown[] = [];
    s.p.gateway.queue(
      'orchestrator',
      playOrchestrator(s, async (_c, message) => void seen.push(message.correlation)),
    );
    await s.runner.start(runId);
    await until(() => seen.length > 0);
    expect(seen[0]).toEqual({ runId });
  });
});

describe('an agent that dies between turns (health check and start)', () => {
  /** Runs two orchestrator turns; `breakIt` runs inside the first, so the second finds the damage. */
  const twoTurns = async (breakIt: (s: System) => Promise<void>) => {
    const s = await make(graphPack());
    const runId = await newRun(s);
    const texts: string[] = [];
    s.p.gateway.queue(
      'orchestrator',
      playOrchestrator(s, async (_c, m) => {
        texts.push(m.text);
        await breakIt(s);
      }),
      playOrchestrator(s, async (_c, m) => void texts.push(m.text)),
    );
    await s.runner.start(runId);
    // The first turn ends with work left, so the runner asks the orchestrator to continue: that is the second turn.
    await until(() => texts.length >= 2);
    return { s, runId, texts };
  };
  const idOf = (s: System, definitionId: string) =>
    s.p.agents.list().find((a) => a.definitionId === definitionId)!;
  const card = (a: { url: string }) => `${a.url}/.well-known/agent-card.json`;

  it('brings a dead agent back where it was and leaves everything else alone', async () => {
    let before = 0;
    let researcherUrl = '';
    const { s, texts } = await twoTurns(async (sys) => {
      const r = idOf(sys, 'researcher');
      researcherUrl = r.url;
      before = sys.p.agents.spawned.length;
      await sys.p.agents.stop(r.id);
    });
    // Restarted in place: nothing was started again, and it answers at the address its callers were given.
    expect(s.p.agents.spawned).toHaveLength(before);
    const back = idOf(s, 'researcher');
    expect(s.p.agents.ref(back.id)?.url).toBe(researcherUrl);
    // The orchestrator was not replaced, so it is not told to start over.
    expect(texts[1]).not.toContain('interrupted');
    expect(s.errors).toEqual([]);
  });

  it('restarts the agents given an address that could not be kept, leaf first, and tells a replaced orchestrator', async () => {
    const old: Record<string, { id: string; url: string }> = {};
    const { s, texts } = await twoTurns(async (sys) => {
      for (const d of ['researcher', 'reviewer', 'author/default', 'planner'])
        old[d] = idOf(sys, d);
      // The old port cannot be reused: restarting in place fails, so it is started afresh somewhere else.
      sys.p.agents.restart = async () => {
        throw new Error('port is gone');
      };
      await sys.p.agents.stop(old.researcher!.id);
    });

    const after = s.p.agents.spawned.slice(4); // the four started at the beginning, then what the health check did
    expect(after.map((x) => x.definition.id)).toEqual(['researcher', 'reviewer', 'planner']);
    // It asked for the old port back (the fake cannot honour it, a real runtime does when it is free).
    expect(after[0]!.preferredPort).toBe(Number(new URL(old.researcher!.url).port));

    const fresh = s.p.agents.list().filter((a) => a.status !== 'stopped');
    const researcher = fresh.find((a) => a.definitionId === 'researcher')!;
    expect(researcher.url).not.toBe(old.researcher!.url);
    // Whoever was given the old address now has the new one, and only the researcher's callers were touched.
    const reviewerSubs = after[1]!.overrides!.subAgents as { agents: { agentCardUrl: string }[] };
    expect(reviewerSubs.agents.map((a) => a.agentCardUrl)).toEqual([card(researcher)]);
    const plannerSubs = after[2]!.overrides!.subAgents as {
      agents: { name: string; agentCardUrl: string }[];
    };
    expect(plannerSubs.agents.find((a) => a.name === 'researcher')!.agentCardUrl).toBe(
      card(researcher),
    );
    expect(plannerSubs.agents.find((a) => a.name === 'author')!.agentCardUrl).toBe(
      card(old['author/default']!),
    );
    // The stale callers were stopped; the author, which never called the researcher, was not.
    expect(s.p.agents.get(old.reviewer!.id)!.status).toBe('stopped');
    expect(s.p.agents.get(old.planner!.id)!.status).toBe('stopped');
    expect(s.p.agents.get(old['author/default']!.id)!.status).not.toBe('stopped');
    // The new orchestrator remembers nothing, so it is told the run was interrupted and resumed.
    expect(texts[1]).toContain('interrupted and has been resumed');
    expect(s.errors).toEqual([]);
  });

  it('starts an orchestrator that died as well, and tells it', async () => {
    const { s, texts } = await twoTurns(async (sys) => {
      await sys.p.agents.stop(idOf(sys, 'planner').id);
    });
    expect(s.p.agents.spawned.filter((x) => x.definition.id === 'planner')).toHaveLength(2);
    expect(texts[1]).toContain('interrupted and has been resumed');
  });
});

describe('a graph that cannot run', () => {
  const blockedWith = async (s: System) => {
    const runId = await newRun(s);
    await s.runner.start(runId);
    await until(async () => (await statusOf(s, runId)) === 'blocked');
    return (await s.p.store.runs.get(runId))!.value.run.statusReason ?? '';
  };

  it('blocks the run with the path of a cycle, and starts nothing', async () => {
    const agents = catalogue();
    agents.researcher!.subAgents = [{ agent: 'planner' }];
    const s = await make(graphPack(agents));
    expect(await blockedWith(s)).toContain('Cycle: planner -> reviewer -> researcher -> planner');
    expect(s.p.agents.spawned).toEqual([]);
  });

  it('blocks the run on a reference to an agent that is not in the catalogue', async () => {
    const agents = catalogue();
    agents.reviewer!.subAgents = [{ agent: 'ghost' }];
    const s = await make(graphPack(agents));
    expect(await blockedWith(s)).toContain('agents.reviewer.subAgents[0].agent');
    expect(s.p.agents.spawned).toEqual([]);
  });

  it('blocks the run when an agent’s config matches no registered backend', async () => {
    const agents = catalogue();
    agents.researcher!.config = card('researcher', { mystery: {} });
    const s = await make(graphPack(agents));
    expect(await blockedWith(s)).toContain('agents.researcher.config');
  });

  it('blocks the run on a source Krama cannot start yet (git)', async () => {
    const agents = catalogue();
    agents.researcher = { git: 'github.com/acme/agents@v1#workers/researcher' };
    const s = await make(graphPack(agents));
    expect(await blockedWith(s)).toContain('git sources are loaded by the pack loader');
  });

  it('needs native delegation: the relay only works from a roster', async () => {
    const s = await make(graphPack(), { defaultDelegation: 'krama' });
    expect(await blockedWith(s)).toContain('needs native delegation');
    expect(s.p.agents.spawned).toEqual([]);
  });
});

describe('hints', () => {
  it('lists each agent with its description and when to use it', () => {
    expect(
      renderAgentsSection([
        { id: 'web', description: 'Searches the web', hint: 'for public facts' },
        { id: 'wiki', description: 'Searches the wiki.' },
        { id: 'bare' },
      ]),
    ).toBe(
      [
        '## Agents you can call',
        '- web: Searches the web. When to use: for public facts.',
        '- wiki: Searches the wiki.',
        '- bare',
      ].join('\n'),
    );
  });
  it('is empty for an agent that calls nobody', () => {
    expect(renderAgentsSection([])).toBe('');
  });
});
