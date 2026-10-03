import { CUT1_ROUTES, ROUTES, fullPath, problem } from '@kramahq/contract';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildMock, type MockApp } from '../src/app.js';

let mock: MockApp;
beforeEach(async () => {
  mock = await buildMock({ autoProgress: false });
});
afterAll(async () => mock?.app.close());

const sample = (path: string): string =>
  path
    .replace('{wid}', 'ws_main')
    .replace('{phaseId}', 'inception')
    .replace('{mid}', 'msg_1')
    .replace('{kind}', 'thumbnail')
    .replace(/^\/runs\/\{id\}/, '/runs/run_01J9PART')
    .replace(/^\/decisions\/\{id\}/, '/decisions/dec_INPUT')
    .replace(/^\/artifacts\/\{id\}/, '/artifacts/art_req1')
    .replace(/^\/packs\/\{id\}/, '/packs/pack_aidlc')
    .replace(/^\/backends\/\{id\}/, '/backends/a2a-codex')
    .replace(/^\/agents\/\{id\}/, '/agents/agt_dev1')
    .replace(/^\/projects\/\{id\}/, '/projects/proj_payments')
    .replace(/^\/schedules\/\{id\}/, '/schedules/sch_nightly_deps')
    .replace(/^\/memory\/records\/\{id\}/, '/memory/records/mem_01J9PROP')
    .replace(
      /^\/agent-definitions\/\{id\}/,
      `/agent-definitions/${encodeURIComponent('developer/default')}`,
    );

// Routes that need a body, a side effect, or special transport are covered by the flow tests below.
const SKIP = new Set([
  'streamEvents',
  'streamRunEvents',
  'streamAgentMessage',
  'getOperation',
  'cancelOperation',
  'getWorkspaceFile',
  'getArtifactContent',
  'getPackFiles',
]);

describe('Cut 1 GET routes match the contract', () => {
  const gets = CUT1_ROUTES.filter(
    (r) => r.method === 'GET' && !SKIP.has(r.operationId) && r.response,
  );
  for (const r of gets) {
    it(`${r.operationId} ${r.path}`, async () => {
      const res = await mock.app.inject({ method: 'GET', url: fullPath({ path: sample(r.path) }) });
      expect(res.statusCode, res.body).toBe(200);
      const parsed = r.response!.safeParse(res.json());
      expect(
        parsed.success,
        parsed.success ? '' : JSON.stringify(parsed.error.issues.slice(0, 3), null, 1),
      ).toBe(true);
    });
  }
});

describe('every Cut 1 route is handled', () => {
  it('has a handler for each Cut 1 operation', async () => {
    const unhandled: string[] = [];
    for (const r of CUT1_ROUTES) {
      if (r.stream || r.operationId === 'createEventTicket') continue;
      const res = await mock.app.inject({
        method: r.method,
        url: fullPath({ path: sample(r.path) }),
        payload: {},
      });
      if (res.statusCode === 501) unhandled.push(r.operationId);
    }
    expect(unhandled).toEqual([]);
  });

  it('later-cut routes answer 501 problem+json', async () => {
    const later = ROUTES.find((r) => !r.cut1 && r.operationId === 'getSettings')!;
    const res = await mock.app.inject({ method: 'GET', url: fullPath(later) });
    expect(res.statusCode).toBe(501);
    expect(problem.safeParse(res.json()).success).toBe(true);
  });
});

describe('flows', () => {
  const resolve = (id: string, body: object) =>
    mock.app.inject({ method: 'POST', url: `/api/v1/decisions/${id}/resolve`, payload: body });
  const getRun = async (id: string) =>
    (await mock.app.inject({ url: `/api/v1/runs/${id}?expand=phases` })).json();

  it('resolving a gate advances the run and is final', async () => {
    const ok = await resolve('dec_SLIDES', { optionId: 'approve' });
    expect(ok.statusCode).toBe(200);
    const run = await getRun('run_01J9DECK');
    expect(run.status).toBe('running');
    expect(run.phases.find((p: { id: string }) => p.id === 'polish').status).toBe('active');
    const again = await resolve('dec_SLIDES', { optionId: 'approve' });
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe('decision_resolved');
  });

  it('multi-approver gate needs `need` approvals', async () => {
    const first = (await resolve('dec_PROD', { optionId: 'approve' })).json();
    expect(first.status).toBe('pending');
    expect(first.approvals).toHaveLength(1);
    const second = (await resolve('dec_PROD', { optionId: 'approve' })).json();
    expect(second.status).toBe('resolved');
    expect((await getRun('run_01J9PRICE')).status).toBe('completed');
  });

  it('required option input is enforced with a 422 problem', async () => {
    const res = await resolve('dec_SLIDES', { optionId: 'changes' });
    expect(res.statusCode).toBe(422);
    expect(res.json().errors[0].field).toBe('input');
  });

  it('requesting changes loops the phase back', async () => {
    await resolve('dec_SLIDES', { optionId: 'changes', input: 'Label slide 9' });
    const phase = (await getRun('run_01J9DECK')).phases.find(
      (p: { id: string }) => p.id === 'design',
    );
    expect(phase.iteration).toBe(2);
  });

  it('access decision resumes the run', async () => {
    expect((await resolve('dec_ACCESS', { optionId: 'allow_once' })).statusCode).toBe(200);
    expect((await getRun('run_01J9PART')).status).toBe('running');
  });

  it('pause, resume and stop follow the state machine', async () => {
    const post = (a: string) =>
      mock.app.inject({ method: 'POST', url: `/api/v1/runs/run_01J9VID/${a}`, payload: {} });
    expect((await post('pause')).json().status).toBe('paused');
    expect((await post('pause')).statusCode).toBe(409);
    expect((await post('resume')).json().status).toBe('running');
    expect((await post('stop')).json().status).toBe('stopped');
    expect((await post('resume')).statusCode).toBe(409);
  });

  it('creates a run from a pack', async () => {
    const res = await mock.app.inject({
      method: 'POST',
      url: '/api/v1/runs',
      payload: { packId: 'pack_deck', input: { text: 'Quarterly review' } },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe('running');
    const bad = await mock.app.inject({
      method: 'POST',
      url: '/api/v1/runs',
      payload: { packId: 'pack_nope', input: {} },
    });
    expect(bad.statusCode).toBe(404);
  });

  it('cost is null when a backend does not report it', async () => {
    const run = await getRun('run_01J9SKO');
    expect(run.budget.spent).toBeNull();
    const cost = (await mock.app.inject({ url: '/api/v1/runs/run_01J9SKO/cost' })).json();
    expect(cost.total).toBeNull();
  });

  it('serves artifact content with Range', async () => {
    const res = await mock.app.inject({
      url: '/api/v1/artifacts/art_req1/content',
      headers: { range: 'bytes=0-9' },
    });
    expect(res.statusCode).toBe(206);
    expect(res.body).toHaveLength(10);
    expect(res.headers['content-range']).toMatch(/^bytes 0-9\//);
  });

  it('install enforces consent for high-risk permissions', async () => {
    const op = (
      await mock.app.inject({
        method: 'POST',
        url: '/api/v1/packs/preview',
        payload: { source: { url: 'https://github.com/kai-dev/podcast-pack' } },
      })
    ).json();
    expect(op.status).toBe('succeeded');
    const preview = (await mock.app.inject({ url: `/api/v1/operations/${op.id}` })).json().result
      .preview;
    const ok = await mock.app.inject({
      method: 'POST',
      url: '/api/v1/packs',
      payload: {
        previewId: preview.previewId,
        manifestDigest: preview.manifestDigest,
        consent: { granted: ['n1', 's1'], declined: [] },
      },
    });
    expect(ok.statusCode).toBe(201);
  });
});

describe('events', () => {
  it('replays only the events after a cursor, filtered by topic (no cross-run leakage)', async () => {
    await mock.app.inject({ method: 'POST', url: '/api/v1/runs/run_01J9VID/pause', payload: {} });
    await mock.app.inject({ method: 'POST', url: '/api/v1/runs/run_01J9PART/pause', payload: {} });
    const all = (
      await mock.app.inject({
        url: '/api/v1/events?after=000000000&topics=run:run_01J9VID',
        headers: { accept: 'application/json' },
      })
    ).json();
    expect(all.items.length).toBeGreaterThan(0);
    expect(all.items.every((e: { runId: string }) => e.runId === 'run_01J9VID')).toBe(true);
    const cursor = all.items.at(-1).id;
    await mock.app.inject({ method: 'POST', url: '/api/v1/runs/run_01J9VID/resume', payload: {} });
    const missed = (
      await mock.app.inject({
        url: `/api/v1/events?after=${cursor}&topics=run:run_01J9VID`,
        headers: { accept: 'application/json' },
      })
    ).json();
    expect(missed.items).toHaveLength(1);
    expect(missed.items[0].type).toBe('run.updated');
  });

  it('plays a scenario into the log at speed', async () => {
    const res = await mock.app.inject({
      method: 'POST',
      url: '/__mock/scenarios/partner-input/play',
      payload: { speed: 1000 },
    });
    expect(res.statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 60));
    const evs = (
      await mock.app.inject({
        url: '/api/v1/events?after=000000000&topics=run:run_01J9PART',
        headers: { accept: 'application/json' },
      })
    ).json();
    expect(evs.items.some((e: { type: string }) => e.type === 'decision.requested')).toBe(true);
    const act = (await mock.app.inject({ url: '/api/v1/runs/run_01J9PART/activity' })).json();
    expect(act.items.some((a: { text?: string }) => a.text?.includes('1 failing'))).toBe(true);
  });

  it('capabilities can be toggled', async () => {
    await mock.app.inject({
      method: 'POST',
      url: '/__mock/capabilities',
      payload: { features: { packs: false } },
    });
    expect((await mock.app.inject({ url: '/api/v1/capabilities' })).json().features.packs).toBe(
      false,
    );
  });
});
