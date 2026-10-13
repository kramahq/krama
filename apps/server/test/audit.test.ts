import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { API_BASE_PATH, auditEntry } from '@kramahq/contract';
import type { AuditEntry } from '@kramahq/contract';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApi, createKrama, loadConfig, type Krama } from '../src/index.js';

const TOKEN = 'test-token-0123456789abcdef';
const auth = { authorization: `Bearer ${TOKEN}` };
const V1 = API_BASE_PATH;

let home: string;
let krama: Krama;
const apps: Record<string, FastifyInstance> = {};

const as = async (name: string, roles: string[]) => {
  const config = loadConfig({ argv: ['--home', home, '--token', TOKEN, '--port', '0'], env: {} });
  apps[name] = await buildApi({
    krama,
    config,
    validateResponses: true,
    autoStartRuns: false,
    principal: { id: `u_${name}`, name: name, roles, permissions: [] },
  });
  await apps[name]!.ready();
};

const write = (
  kind: string,
  who: string,
  day: string,
  payload: unknown,
  type: 'user' | 'system' = 'user',
) =>
  krama.ports.ledger!.append({
    chain: 'control',
    actor: { type, id: who, ...(type === 'user' ? { role: 'operator' } : {}) },
    kind,
    source: type === 'system' ? 'system' : 'api',
    at: `2026-01-0${day}T00:00:00.000Z`,
    payload,
  });

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'krama-audit-'));
  krama = await createKrama({ home, packs: [], definitions: [] });
  await as('admin', ['admin']);
  await as('operator', ['operator']);
  await as('viewer', ['viewer']);
  const subject = (id: string) => ({ type: 'run', id });
  await write('run.created', 'u_a', '1', {
    subject: subject('run_1'),
    actorName: 'Ann',
    detail: { mode: 'review' },
  });
  await write('run.updated', 'u_b', '2', {
    subject: subject('run_1'),
    actorName: 'Bo',
    detail: { changed: ['title'] },
  });
  await write('capture.gap', 'engine', '3', { reason: 'unattributed' }, 'system');
  await write('decision.resolved', 'u_b', '4', {
    subject: { type: 'decision', id: 'dec_1' },
    actorName: 'Bo',
    detail: { optionId: 'approve' },
  });
  await write('run.stop', 'u_a', '5', { subject: subject('run_1'), actorName: 'Ann' });
}, 60_000);

afterAll(async () => {
  for (const a of Object.values(apps)) await a.close();
  await krama?.close();
  rmSync(home, { recursive: true, force: true });
});

interface Page {
  items: AuditEntry[];
  nextCursor?: string;
}
const list = async (who: string, query = '') => {
  const res = await apps[who]!.inject({ method: 'GET', url: `${V1}/audit${query}`, headers: auth });
  return { status: res.statusCode, body: res.json() as Page & { code?: string } };
};

describe('GET /audit is the control chain', () => {
  it('lists who did what, newest first, with the principal, the subject and the chain position', async () => {
    const { status, body } = await list('admin');
    expect(status).toBe(200);
    const items = body.items.map((e) => auditEntry.parse(e));
    expect(items.map((e) => e.action)).toEqual([
      'run.stop',
      'decision.resolved',
      'capture.gap',
      'run.updated',
      'run.created',
    ]);
    expect(items.map((e) => e.seq)).toEqual([5, 4, 3, 2, 1]);
    expect(items[4]).toMatchObject({
      actor: { type: 'user', id: 'u_a', name: 'Ann', role: 'operator' },
      subject: { type: 'run', id: 'run_1' },
      detail: { mode: 'review' },
    });
    // A finding the platform wrote itself has no subject of its own: it is its own subject, and its payload is the detail.
    expect(items[2]).toMatchObject({
      actor: { type: 'system', id: 'engine' },
      subject: { type: 'control', id: items[2]!.id },
      detail: { reason: 'unattributed' },
    });
    // Each entry carries the hash that ties it into the chain.
    const chain = await krama.ports.ledger!.read('control');
    expect(items.map((e) => e.hash)).toEqual(chain.map((r) => r.hash).reverse());
  });

  it('pages backwards without a gap or a repeat', async () => {
    const first = await list('admin', '?limit=2');
    expect(first.body.items.map((e) => e.seq)).toEqual([5, 4]);
    expect(first.body.nextCursor).toBeTruthy();
    const second = await list('admin', `?limit=2&cursor=${first.body.nextCursor}`);
    expect(second.body.items.map((e) => e.seq)).toEqual([3, 2]);
    const third = await list('admin', `?limit=2&cursor=${second.body.nextCursor}`);
    expect(third.body.items.map((e) => e.seq)).toEqual([1]);
    expect(third.body.nextCursor).toBeUndefined();
  });

  it('filters by actor, by action (and what is under it) and by time range', async () => {
    const seqs = async (q: string) => (await list('admin', q)).body.items.map((e) => e.seq);
    expect(await seqs('?actor=u_b')).toEqual([4, 2]);
    expect(await seqs('?action=run')).toEqual([5, 2, 1]);
    expect(await seqs('?action=run.created')).toEqual([1]);
    expect(await seqs('?actor=u_a&action=run')).toEqual([5, 1]);
    expect(await seqs('?from=2026-01-02&to=2026-01-04T00:00:00Z')).toEqual([4, 3, 2]);
    expect(await seqs('?from=2027-01-01')).toEqual([]);
  });

  it('refuses a bad date, an inverted range and a bad cursor with a field error', async () => {
    const bad = async (q: string) => (await list('admin', q)).body;
    expect(await bad('?from=yesterday')).toMatchObject({ code: 'validation_failed' });
    expect(await bad('?from=2026-02-01&to=2026-01-01')).toMatchObject({
      code: 'validation_failed',
    });
    expect(await bad('?cursor=nonsense')).toMatchObject({ code: 'validation_failed' });
  });

  it('is for administrators only', async () => {
    expect((await list('operator')).status).toBe(403);
    expect((await list('viewer')).status).toBe(403);
  });
});
