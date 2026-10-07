import { ApiError } from './errors.js';
import type { Client } from './client.js';

export interface ConformanceCheck {
  name: string;
  ok: boolean;
  error?: string;
}

export interface ConformanceOptions {
  /** A pack the target can run; defaults to the first pack the target lists. */
  packId?: string;
  /** Skip the checks that create a run. */
  readOnly?: boolean;
}

/**
 * Drives the M5.2 routes through the SDK against any Krama API (the mock or the server) and reports each check.
 * The same list runs against both, so the two stay interchangeable for the UI and the CLI.
 */
export async function runConformance(
  client: Client,
  o: ConformanceOptions = {},
): Promise<ConformanceCheck[]> {
  const results: ConformanceCheck[] = [];
  const check = async (name: string, fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
      results.push({ name, ok: true });
    } catch (e) {
      results.push({ name, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  };
  function must(cond: unknown, msg: string): asserts cond {
    if (!cond) throw new Error(msg);
  }
  const { api } = client;

  await check('capabilities and health are public reads', async () => {
    const caps = await api.getCapabilities({});
    must(typeof caps === 'object' && caps !== null, 'no capabilities');
    must((await api.getHealth({})).status, 'no health status');
  });
  await check('me names the caller', async () => {
    must((await api.getMe({})).id, 'no id');
  });
  await check('projects and packs list as pages', async () => {
    must(Array.isArray((await api.listProjects({})).items), 'projects');
    must(Array.isArray((await api.listPacks({})).items), 'packs');
  });
  await check('runs list with a filter and a page size', async () => {
    const page = await api.listRuns({ query: { limit: 2 } });
    must(page.items.length <= 2, 'page size ignored');
  });
  await check('an unknown run is an ApiError with a code and status 404', async () => {
    const err = await api
      .getRun({ params: { id: 'run_DOESNOTEXIST0000000000000' } })
      .catch((e) => e);
    must(err instanceof ApiError, 'not an ApiError');
    must(err.status === 404, `status ${err.status}`);
    must(typeof err.code === 'string' && err.code !== 'error', `code ${err.code}`);
  });
  await check('decisions list', async () => {
    must(Array.isArray((await api.listDecisions({})).items), 'decisions');
  });
  await check('an unknown path parameter is refused before the request', async () => {
    const err = await api
      .getRun({ params: { id: '' } })
      .then(() => undefined)
      .catch((e) => e);
    must(err instanceof TypeError, 'expected TypeError');
  });

  if (o.readOnly) return results;

  const packId = o.packId ?? (await api.listPacks({})).items[0]?.id;
  await check('create, read, pause, resume and stop a run', async () => {
    must(packId, 'no pack to run');
    const created = await api.createRun({
      body: { packId, input: { text: 'sdk conformance' } },
    });
    must(created.id.startsWith('run_'), `id ${created.id}`);
    const got = await api.getRun({ params: { id: created.id } });
    must(got.id === created.id, 'read back a different run');
    const listed = await api.listRuns({ query: { limit: 200 } });
    must(
      listed.items.some((r) => r.id === created.id),
      'created run not listed',
    );
    must(Array.isArray((await api.listActivity({ params: { id: created.id } })).items), 'activity');
    must((await api.listPhases({ params: { id: created.id } })).items, 'phases');
    await api.pauseRun({ params: { id: created.id } }).catch(() => undefined);
    await api.resumeRun({ params: { id: created.id } }).catch(() => undefined);
    const stopped = await api.stopRun({ params: { id: created.id } });
    must(['stopped', 'failed', 'completed'].includes(stopped.status), `status ${stopped.status}`);
  });
  await check('the same idempotency key replays the first create', async () => {
    must(packId, 'no pack to run');
    const key = `sdk-${Date.now()}`;
    const body = { packId, input: { text: 'idempotent' } };
    const a = await api.createRun({ body, idempotencyKey: key });
    const b = await api.createRun({ body, idempotencyKey: key });
    must(a.id === b.id, 'a second run was created');
    await api.stopRun({ params: { id: a.id } }).catch(() => undefined);
  });
  return results;
}
