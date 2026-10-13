import type { BackendDescriptor, Pack, PackAgent } from '@kramahq/contract';
import { StaticSecretResolver } from '@kramahq/engine/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { renderAgentsSection, resolveGraphBackends } from '../src/index.js';
import { def, pack } from './rig.js';
import {
  call,
  newRun,
  playOrchestrator,
  statusOf,
  system,
  until,
  user,
  worker,
  type System,
} from './runner-rig.js';

const live: System[] = [];
afterEach(async () => {
  await Promise.allSettled(live.splice(0).map((s) => s.stop()));
});

/** Only the fields the graph code reads. */
const backend = (id: string, providerKey: string) =>
  ({ id, providerKey, mapping: { model: 'model' } }) as unknown as BackendDescriptor;
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

describe('what a graph pack will really run is known before the run exists (#35)', () => {
  const directory = {
    definitions: () => [def('author', ['write'])],
    systemPrompt: () => '',
    backendUsable: () => true,
  };
  const withResolver = async (p: Pack, policy: object = {}) => {
    const s = await make(p, { defaultDelegation: 'native', ...policy });
    s.p.graphs = { resolve: (pk) => resolveGraphBackends({ ports: s.p, directory }, pk) };
    return s;
  };
  // The root's own config says Codex and a model; the policy default would have said Claude.
  const codexRoot = () =>
    graphPack({
      ...catalogue(),
      planner: {
        ...catalogue().planner!,
        config: card('planner', { codex: { model: 'gpt-5.5' } }),
      },
    });

  it('names the root backend and model, and every backend Krama will start', async () => {
    const s = await make(codexRoot());
    expect(resolveGraphBackends({ ports: s.p, directory }, codexRoot())).toEqual({
      root: { backend: 'a2a-codex', model: 'gpt-5.5' },
      // planner and researcher and author are Codex, reviewer is Claude; the external vendor is not started.
      backends: expect.arrayContaining(['a2a-codex', 'a2a-claude']),
    });
    expect(resolveGraphBackends({ ports: s.p, directory }, pack())).toBeUndefined();
  });

  it('records the backend and model that will actually start, not the policy default', async () => {
    const s = await withResolver(codexRoot());
    const run = await s.engine.runs.create(
      { packId: 'pack_demo', input: { text: 'go' }, budget: { max: 10 } },
      user,
    );
    expect(run.orchestrator).toMatchObject({ backend: 'a2a-codex', model: 'gpt-5.5' });
  });

  it('refuses a run when any agent Krama would start is outside policy', async () => {
    const s = await withResolver(codexRoot(), { allowedBackends: ['a2a-claude'] });
    await expect(
      s.engine.runs.create({ packId: 'pack_demo', input: { text: 'go' } }, user),
    ).rejects.toMatchObject({ code: 'backend_not_allowed', details: { backend: 'a2a-codex' } });
  });

  it('says so when a caller tries to override the orchestrator of a graph pack', async () => {
    const s = await withResolver(codexRoot());
    await expect(
      s.engine.runs.create(
        { packId: 'pack_demo', input: { text: 'go' }, orchestrator: { backend: 'a2a-claude' } },
        user,
      ),
    ).rejects.toMatchObject({ code: 'invalid_option' });
  });
});

/** An agents-only pack: a graph with no methodology and no roster (D16). */
const agentsOnly = (): Pack => {
  const p = graphPack();
  delete p.methodology;
  delete p.roster;
  return p;
};

describe('an agents-only pack completes in both delegation modes (M4.9)', () => {
  const create = (s: System, mode: 'review' | 'autopilot') =>
    s.engine.runs
      .create(
        { packId: 'pack_demo', input: { text: 'Do the work' }, mode, budget: { max: 10 } },
        user,
      )
      .then((r) => r.id);

  /** The orchestrator plans two phases, delegates to two of its agents by name, and records both phases. */
  const work = (s: System) =>
    playOrchestrator(s, async (c) => {
      const first = (await call(c, 'get_run')).data;
      expect(first.phases.map((p: { id: string }) => p.id)).toEqual(['run']);
      await call(c, 'set_plan', {
        phases: [
          { id: 'research', label: 'Research' },
          { id: 'write', label: 'Write', dependsOn: ['research'] },
        ],
      });
      expect((await call(c, 'get_run')).data.currentPhaseIds).toEqual(['research']);
      await call(c, 'delegate_to_agent', {
        phaseId: 'research',
        role: 'researcher',
        task: 'Look up',
      });
      await call(c, 'record_phase_outcome', {
        phaseId: 'research',
        status: 'success',
        reason: 'found it',
        gating: 'continue',
      });
      await call(c, 'delegate_to_agent', { phaseId: 'write', role: 'author', task: 'Write it' });
      await call(c, 'record_phase_outcome', {
        phaseId: 'write',
        status: 'success',
        reason: 'written',
        gating: 'continue',
      });
    });

  it('relay (krama): autopilot completes, agents start on first use, and nobody else starts', async () => {
    const s = await make(agentsOnly(), { defaultDelegation: 'krama' });
    const runId = await create(s, 'autopilot');
    s.p.gateway.queue('researcher', worker('Facts'));
    s.p.gateway.queue('author', worker('Draft'));
    s.p.gateway.queue('orchestrator', work(s));
    await s.runner.start(runId);
    await until(async () => (await statusOf(s, runId)) === 'completed');

    const roles = s.p.agents.spawned.map((x) => x.definition.role);
    expect(roles).toContain('researcher');
    expect(roles).toContain('author');
    // Not the reviewer (never asked for), not the external vendor, not the unreachable stray.
    expect(roles).not.toContain('reviewer');
    expect(roles).not.toContain('stray');
    const orch = s.p.agents.spawned.find((x) => x.definition.role === 'orchestrator')!;
    expect(orch.systemPrompt).toContain('Agents you can delegate to');
    expect(orch.systemPrompt).toContain('**researcher**');
    expect(orch.systemPrompt).not.toContain('Methodology:');
    expect(orch.systemPrompt).toContain('set_plan');
    expect(s.errors).toEqual([]);
  });

  it('relay (krama): review mode waits for the final approval, then completes', async () => {
    const s = await make(agentsOnly(), { defaultDelegation: 'krama' });
    const runId = await create(s, 'review');
    s.p.gateway.queue('researcher', worker('Facts'));
    s.p.gateway.queue('author', worker('Draft'));
    s.p.gateway.queue('orchestrator', work(s));
    await s.runner.start(runId);
    await until(async () => (await statusOf(s, runId)) === 'awaiting_decision');
    await new Promise((r) => setTimeout(r, 150));
    expect(await statusOf(s, runId)).toBe('awaiting_decision');

    const dec = (await s.p.store.decisions.list({ runId, status: ['pending'] })).items[0]!.value
      .decision;
    expect(dec.title).toBe('Final approval');
    await s.engine.decisions.resolve(dec.id, { optionId: 'approve' }, user);
    await until(async () => (await statusOf(s, runId)) === 'completed');
  });

  it('native: the same pack completes, with its agents started up front', async () => {
    const s = await make(agentsOnly(), { defaultDelegation: 'native' });
    const runId = await create(s, 'autopilot');
    s.p.gateway.queue(
      'orchestrator',
      playOrchestrator(s, async (c) => {
        await call(c, 'set_plan', { phases: [{ id: 'all', label: 'All of it' }] });
        await call(c, 'record_phase_outcome', {
          phaseId: 'all',
          status: 'success',
          reason: 'done',
          gating: 'continue',
        });
      }),
    );
    await s.runner.start(runId);
    await until(async () => (await statusOf(s, runId)) === 'completed');
    expect(s.p.agents.spawned.map((x) => x.definition.id)).toContain('researcher');
  });
});
