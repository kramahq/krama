import { createClient } from '@kramahq/sdk';
import { runConformance } from '@kramahq/sdk/conformance';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildMock, type MockApp } from '../src/app.js';

let mock: MockApp;
let baseUrl: string;
beforeAll(async () => {
  mock = await buildMock({ autoProgress: false });
  await mock.app.listen({ port: 0, host: '127.0.0.1' });
  const addr = mock.app.server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/api/v1`;
});
afterAll(async () => mock?.app.close());

describe('the SDK against the mock', () => {
  it('passes the shared conformance checks', async () => {
    const results = await runConformance(createClient({ baseUrl }));
    expect(results.filter((r) => !r.ok)).toEqual([]);
    expect(results.length).toBeGreaterThan(5);
  });
});
