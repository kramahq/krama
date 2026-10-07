import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BackendRegistry } from '@kramahq/agents';
import { createClient } from '@kramahq/sdk';
import { runConformance } from '@kramahq/sdk/conformance';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApi, createKrama, loadConfig, type Krama } from '../src/index.js';
import { DEMO_BACKEND, DEMO_DEFINITIONS, DEMO_PACK } from '../src/demo/pack.js';

const TOKEN = 'test-token-0123456789abcdef';
let home: string;
let krama: Krama;
let app: FastifyInstance;
let baseUrl: string;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'krama-sdk-'));
  const backends = BackendRegistry.withBuiltins();
  backends.register(DEMO_BACKEND, 'user');
  krama = await createKrama({ home, packs: [DEMO_PACK], definitions: DEMO_DEFINITIONS, backends });
  const config = loadConfig({ argv: ['--home', home, '--token', TOKEN, '--port', '0'], env: {} });
  app = await buildApi({ krama, config, validateResponses: true, autoStartRuns: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/api/v1`;
}, 60_000);

afterAll(async () => {
  await app?.close();
  await krama?.close();
  rmSync(home, { recursive: true, force: true });
});

describe('the SDK against the server', () => {
  it('passes the shared conformance checks', async () => {
    const results = await runConformance(createClient({ baseUrl, token: TOKEN }));
    expect(results.filter((r) => !r.ok)).toEqual([]);
    expect(results.length).toBeGreaterThan(5);
  });
});
