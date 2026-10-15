import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { BackendRegistry, deriveLaunch } from '@kramahq/agents';
import {
  agentDefinition,
  agentPreview,
  operation,
  type AgentPreview,
  type Pack,
} from '@kramahq/contract';
import { planFromPack, specFor } from '@kramahq/orchestrator-mcp';
import { createClient } from '@kramahq/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApi, createKrama, loadConfig, type Krama } from '../src/index.js';
import { DEMO_PACK } from '../src/demo/pack.js';
import { admin, agentConfig, cleanup, git, hasGit, remote, tmp } from './agent-pool-fixture.js';

const TOKEN = 'test-token-0123456789abcdef';
const agentId = 'reviewer/default';
const encoded = encodeURIComponent(agentId);
let home: string;
let krama: Krama;
let repo: Awaited<ReturnType<typeof remote>>;
const apps: Record<string, FastifyInstance> = {};
const pack: Pack = {
  ...DEMO_PACK,
  id: 'pack_pool',
  orchestrator: 'planner',
  agents: { planner: { definition: agentId } },
};
const call = (
  who: string,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  payload?: object,
  headers: Record<string, string> = {},
) =>
  apps[who]!.inject({
    method,
    url: `/api/v1${path}`,
    headers: { authorization: `Bearer ${TOKEN}`, ...headers },
    ...(payload ? { payload } : {}),
  });
async function finished(
  who: string,
  response: Awaited<ReturnType<typeof call>>,
): Promise<AgentPreview> {
  expect(response.statusCode, response.body).toBe(202);
  const initial = operation.parse(response.json());
  for (let i = 0; i < 400; i++) {
    const op = operation.parse((await call(who, 'GET', `/operations/${initial.id}`)).json());
    if (op.status === 'succeeded') return agentPreview.parse(op.result);
    if (op.status === 'failed') throw new Error(JSON.stringify(op.error));
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('preview did not finish');
}
const review = (p: AgentPreview) => ({
  previewId: p.previewId,
  manifestDigest: p.manifestDigest,
  consent: { granted: p.permissions.map((p) => p.id), declined: [] },
});
const preview = async (who = 'admin') =>
  finished(
    who,
    await call(who, 'POST', '/agent-definitions/preview', {
      id: agentId,
      source: { url: repo.url, ref: 'main', path: 'reviewer' },
      secrets: { SVC_TOKEN: 'svc-token' },
    }),
  );

beforeAll(async () => {
  if (!hasGit) return;
  home = tmp();
  repo = await remote();
  await repo.commit({
    'reviewer/config.json': agentConfig('reviewer', {
      claude: { model: 'first', systemPromptAppend: 'Own persona.' },
      memory: { instructions: 'instructions.md' },
      mcp: {
        svc: {
          type: 'http',
          url: 'https://svc.example/mcp',
          headers: { Authorization: 'Bearer ${SVC_TOKEN}' },
        },
      },
    }),
    'reviewer/instructions.md': 'Review carefully.',
  });
  krama = await createKrama({ home, packs: [pack], definitions: [], sources: { git } });
  const config = loadConfig({ argv: ['--home', home, '--token', TOKEN, '--port', '0'], env: {} });
  for (const [who, roles] of Object.entries({
    admin: ['admin'],
    author: ['author'],
    viewer: ['viewer'],
  })) {
    apps[who] = await buildApi({
      krama,
      config,
      validateResponses: true,
      autoStartRuns: false,
      principal: { id: `u_${who}`, name: who, roles, permissions: [] },
    });
    await apps[who]!.ready();
  }
}, 60_000);
afterAll(async () => {
  for (const app of Object.values(apps)) await app.close();
  await krama?.close();
  cleanup();
});

describe.skipIf(!hasGit)('the Git agent pool over HTTP', { timeout: 120_000 }, () => {
  it('allows author previews and admin installs, and rejects viewers and invalid source paths', async () => {
    expect(
      (
        await call('viewer', 'POST', '/agent-definitions/preview', {
          id: agentId,
          source: { url: repo.url },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await call('admin', 'POST', '/agent-definitions/preview', {
          id: 'bad',
          source: { url: repo.url },
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (
        await call('admin', 'POST', '/agent-definitions/preview', {
          id: agentId,
          source: { url: repo.url, path: '../escape' },
        })
      ).statusCode,
    ).toBe(422);
    const p = await preview('author');
    expect(
      (
        await call('author', 'POST', '/agent-definitions', review(p), {
          'idempotency-key': 'author',
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await call(
          'admin',
          'POST',
          '/agent-definitions',
          { ...review(p), consent: { granted: [], declined: [] } },
          { 'idempotency-key': 'empty' },
        )
      ).statusCode,
    ).toBe(422);
    const installed = await call('admin', 'POST', '/agent-definitions', review(p), {
      'idempotency-key': 'install',
    });
    expect(installed.statusCode, installed.body).toBe(201);
    agentDefinition.parse(installed.json());
    const repeated = await call('admin', 'POST', '/agent-definitions', review(p), {
      'idempotency-key': 'install',
    });
    expect(repeated.json()).toEqual(installed.json());
    expect((await call('viewer', 'GET', `/agent-definitions/${encoded}`)).json()).toMatchObject({
      id: agentId,
      source: { type: 'git', sha: p.sha },
    });
    expect(
      (await call('viewer', 'GET', '/agent-definitions?capability=reviewer')).json(),
    ).toMatchObject({ items: [{ id: agentId }] });
    expect(
      (await call('admin', 'POST', '/agents/match', { capabilities: ['reviewer'] })).json(),
    ).toMatchObject({ candidates: [{ definition: { id: agentId } }] });
    expect(krama.runtime.list()).toEqual([]); // Registration does not start a wrapper process.
  });

  it('uses installed wrapper configs in graph launches, preserving prompts, files, tools and secrets', async () => {
    const created = await krama.engine.runs.create(
      { packId: pack.id, input: { text: 'Review' } },
      admin,
    );
    expect(created.orchestrator).toMatchObject({ backend: 'a2a-claude', model: 'first' });
    const definition = krama.agentPool.get(agentId)!;
    const directory = {
      definitions: () => krama.agentPool.list(),
      systemPrompt: () => '',
      backendUsable: () => true,
      definitionConfig: (d: typeof definition) => krama.agentPool.config(d),
    };
    const spec = await specFor(
      { ports: krama.ports, directory },
      created,
      pack,
      planFromPack(pack)!,
      'planner',
      { entries: [], lines: [], secrets: {} },
      { prompt: 'Krama protocol.' },
    );
    expect(spec.baseConfig).toBeDefined();
    const base = (spec.baseConfig as { json: Record<string, unknown> }).json;
    const launch = deriveLaunch(
      BackendRegistry.withBuiltins().get('a2a-claude')!,
      base,
      spec.definition.backend,
      {
        port: 4444,
        workspace: join(home, 'workspace'),
        configPath: join(home, 'derived.json'),
        agentName: definition.name,
        agentDescription: definition.description,
        systemPrompt: spec.systemPrompt!,
        secretValues: { 'svc-token': 'bound' },
        ambientEnv: { ANTHROPIC_API_KEY: 'test-key' },
      },
    );
    expect(launch.ok, JSON.stringify(launch.problems)).toBe(true);
    expect(launch.config.claude).toMatchObject({
      systemPromptAppend: 'Own persona.\n\nKrama protocol.',
    });
    expect(launch.config.memory).toMatchObject({
      instructions: expect.stringContaining('instructions.md'),
    });
    expect(launch.config.mcp).toHaveProperty('svc');
    expect(launch.env.SVC_TOKEN).toBe('bound');
    expect(launch.config).not.toHaveProperty('SVC_TOKEN');
    expect((await call('admin', 'DELETE', `/agent-definitions/${encoded}`)).statusCode).toBe(409);
    await krama.engine.runs.stop(created.id, admin, 'test complete');
  });

  it('supports typed SDK updates and rollback, records the actor, and survives restart with the remote gone', async () => {
    const config = loadConfig({ argv: ['--home', home, '--token', TOKEN, '--port', '0'], env: {} });
    const first = krama.agentPool.get(agentId)!.source.sha!;
    await repo.commit({
      'reviewer/config.json': agentConfig('reviewer', { claude: { model: 'second' } }),
    });
    await apps.admin!.listen({ host: '127.0.0.1', port: 0 });
    const address = apps.admin!.server.address() as { port: number };
    const client = createClient({
      baseUrl: `http://127.0.0.1:${address.port}/api/v1`,
      token: TOKEN,
    });
    const op = await client.api.previewAgentDefinitionUpdate({ params: { id: agentId }, body: {} });
    let result: AgentPreview | undefined;
    for (let i = 0; i < 400; i++) {
      const state = await client.api.getOperation({ params: { id: op.id } });
      if (state.status === 'succeeded') {
        result = agentPreview.parse(state.result);
        break;
      }
      if (state.status === 'failed') throw new Error(JSON.stringify(state.error));
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(result).toBeDefined();
    expect(
      (await client.api.updateAgentDefinition({ params: { id: agentId }, body: review(result!) }))
        .backend.model,
    ).toBe('second');
    const rollback = await client.api.rollbackAgentDefinition({
      params: { id: agentId },
      body: { sha: first },
    });
    expect(rollback.backend.model).toBe('first');
    expect(
      (await client.api.listAgentDefinitionVersions({ params: { id: agentId } })).items.map(
        (v) => v.action,
      ),
    ).toEqual(['rollback', 'update', 'install']);
    const audit = (await call('admin', 'GET', '/audit?action=agent_definition')).json() as {
      items: { action: string; actor: { id: string } }[];
    };
    expect(audit.items.map((v) => v.action).reverse()).toEqual([
      'agent_definition.installed',
      'agent_definition.updated',
      'agent_definition.rolled_back',
    ]);
    expect(audit.items.every((v) => v.actor.id === 'u_admin')).toBe(true);
    for (const app of Object.values(apps)) await app.close();
    await krama.close();
    rmSync(repo.url, { recursive: true });
    krama = await createKrama({ home, packs: [pack], definitions: [], sources: { git } });
    apps.admin = await buildApi({ krama, config, validateResponses: true, autoStartRuns: false });
    expect((await call('admin', 'GET', `/agent-definitions/${encoded}`)).json()).toMatchObject({
      id: agentId,
      backend: { model: 'first' },
    });
    expect((await call('admin', 'DELETE', `/agent-definitions/${encoded}`)).statusCode).toBe(204);
    expect((await call('admin', 'GET', `/agent-definitions/${encoded}`)).statusCode).toBe(404);
  });
});
