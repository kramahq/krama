import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuditDraft, AuditRecord } from '@kramahq/contract';
import { AUDIT_GENESIS } from '@kramahq/contract';
import { InMemoryAuditBlobs, auditLedgerContract } from '@kramahq/engine/testing';
import type { AuditTamper } from '@kramahq/engine/testing';
import { canonicalJson } from '@kramahq/engine';
import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { openPglite, openPostgres, type OpenedStore } from '../src/index.js';

const open: OpenedStore[] = [];
const track = async (p: Promise<OpenedStore>) => {
  const o = await p;
  open.push(o);
  return o;
};
afterAll(async () => {
  await Promise.all(open.map((o) => o.close()));
});

const pgUrl = process.env.KRAMA_TEST_POSTGRES_URL;

/** Drizzle wraps the database's message (`Failed query: ...`); the trigger's own text is on `cause`. */
const refused = async (p: Promise<unknown>, re: RegExp) => {
  const e = (await p.then(
    () => undefined,
    (x: unknown) => x,
  )) as { message?: string; cause?: { message?: string } } | undefined;
  expect(e, 'the statement should have been refused').toBeDefined();
  expect(`${e?.cause?.message ?? ''} ${e?.message ?? ''}`).toMatch(re);
};

/** Changes rows the way someone with write access to the tables would: with the guard triggers switched off. */
function tamperOf(o: OpenedStore): AuditTamper {
  const run = async (stmt: ReturnType<typeof sql>) => {
    await o.db.execute(sql`alter table audit_records disable trigger user`);
    await o.db.execute(sql`alter table audit_heads disable trigger user`);
    try {
      await o.db.execute(stmt);
    } finally {
      await o.db.execute(sql`alter table audit_records enable trigger user`);
      await o.db.execute(sql`alter table audit_heads enable trigger user`);
    }
  };
  return {
    edit: async (chain, seq, change) => {
      const rows = (await o.db.execute(
        sql`select record from audit_records where chain = ${chain} and seq = ${seq}`,
      )) as unknown as { rows: { record: string }[] };
      const next = { ...(JSON.parse(rows.rows[0]!.record) as AuditRecord), ...change };
      await run(
        sql`update audit_records set record = ${canonicalJson(next)}, chain = ${next.chain} where chain = ${chain} and seq = ${seq}`,
      );
    },
    remove: (chain, seq) =>
      run(sql`delete from audit_records where chain = ${chain} and seq = ${seq}`),
    setHead: (chain, head) =>
      run(
        sql`update audit_heads set seq = ${head.seq}, hash = ${head.hash} where chain = ${chain}`,
      ),
  };
}

async function clean(o: OpenedStore) {
  await o.db.execute(sql`alter table audit_records disable trigger user`);
  await o.db.execute(sql`alter table audit_heads disable trigger user`);
  await o.db.execute(sql`delete from audit_records`);
  await o.db.execute(sql`delete from audit_heads`);
  await o.db.execute(sql`alter table audit_records enable trigger user`);
  await o.db.execute(sql`alter table audit_heads enable trigger user`);
}

const d = (chain: string, extra: Partial<AuditDraft> = {}): AuditDraft => ({
  chain,
  actor: { type: 'agent', id: 'agent_1' },
  kind: 'tool.call',
  source: 'a2a-stream',
  ...extra,
});

function suites(name: string, make: () => Promise<OpenedStore>, skip = false) {
  describe.skipIf(skip)(`${name} audit ledger`, () => {
    auditLedgerContract({ describe, it, expect } as never, async () => {
      const o = await make();
      await clean(o);
      return { ledger: o.ledger, tamper: tamperOf(o), blobs: new InMemoryAuditBlobs() };
    });

    describe('append-only', () => {
      it('refuses to update a record, delete one, or truncate the table', async () => {
        const o = await make();
        await clean(o);
        await o.ledger.append(d('run:r1', { payload: { a: 1 } }));
        await refused(o.db.execute(sql`update audit_records set kind = 'x'`), /append-only/);
        await refused(o.db.execute(sql`delete from audit_records`), /append-only/);
        await refused(o.db.execute(sql`truncate audit_records`), /append-only/);
        await refused(o.db.execute(sql`delete from audit_heads`), /append-only/);
        await refused(o.db.execute(sql`truncate audit_heads`), /append-only/);
        expect((await o.ledger.verify('run:r1')).ok).toBe(true);
        expect((await o.ledger.read('run:r1')).length).toBe(1);
      });

      it('lets a head move forward only', async () => {
        const o = await make();
        await clean(o);
        await o.ledger.append(d('run:r1'));
        await o.ledger.append(d('run:r1'));
        await refused(
          o.db.execute(
            sql`update audit_heads set seq = 1, hash = ${'f'.repeat(64)} where chain = 'run:r1'`,
          ),
          /forward/,
        );
        await refused(
          o.db.execute(sql`update audit_heads set chain = 'run:other' where chain = 'run:r1'`),
          /forward/,
        );
        expect((await o.ledger.verify('run:r1')).ok).toBe(true);
      });

      it('rolls back a failed write, leaving no gap and no head ahead of the chain', async () => {
        const o = await make();
        await clean(o);
        await o.ledger.append(d('run:r1'));
        // A payload that cannot be stored as text fails after the head is locked; the chain must stay intact.
        const bad = d('run:r1', {
          payload: {
            toJSON: () => {
              throw new Error('boom');
            },
          },
        });
        await expect(o.ledger.append(bad)).rejects.toThrow();
        const next = (await o.ledger.append(d('run:r1'))).record;
        expect(next.seq).toBe(2);
        expect((await o.ledger.verify('run:r1')).ok).toBe(true);
      });
    });

    describe('storage', () => {
      it('stores the record as written, whatever jsonb would do to it', async () => {
        const o = await make();
        await clean(o);
        const payload = {
          z: 1,
          a: [3, 2, 1],
          big: 9007199254740991,
          s: 'line\nbreak \u0000 nul',
          f: 0.1,
          e: 1e21,
        };
        const { record } = await o.ledger.append(d('run:r1', { payload }));
        const [read] = await o.ledger.read('run:r1');
        expect(read).toEqual(record);
        expect((await o.ledger.verify('run:r1')).ok).toBe(true);
      });

      it('keeps one head per chain and independent positions for many chains written at once', async () => {
        const o = await make();
        await clean(o);
        await Promise.all(
          Array.from({ length: 6 }, (_, c) =>
            Promise.all(Array.from({ length: 10 }, () => o.ledger.append(d(`run:r${c}`)))),
          ),
        );
        for (let c = 0; c < 6; c++) {
          const v = await o.ledger.verify(`run:r${c}`);
          expect(v).toMatchObject({ ok: true, count: 10, head: { seq: 10 } });
        }
        expect((await o.ledger.chains('run:')).length).toBe(6);
      });

      it('verifies a chain longer than one page', async () => {
        const o = await make();
        await clean(o);
        for (let i = 0; i < 520; i++) await o.ledger.append(d('run:long', { payload: { i } }));
        const v = await o.ledger.verify('run:long');
        expect(v).toMatchObject({ ok: true, count: 520, head: { seq: 520 } });
      }, 60_000);

      it('starts every chain from the genesis value', async () => {
        const o = await make();
        await clean(o);
        expect(
          (await o.ledger.append(d('control', { actor: { type: 'user', id: 'u' }, source: 'api' })))
            .record.prev,
        ).toBe(AUDIT_GENESIS);
      });
    });
  });
}

suites('PGlite', () => track(openPglite()));
suites('Postgres', () => track(openPostgres(pgUrl!)), !pgUrl);

describe('audit ledger persistence', () => {
  it('survives a restart: records, heads and chain order', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'krama audit with spaces-'));
    try {
      const a = await openPglite(dir);
      await a.ledger.append(d('run:r1', { payload: { n: 1 } }));
      const last = (await a.ledger.append(d('run:r1', { payload: { n: 2 } }))).record;
      await a.close();
      const b = await openPglite(dir);
      expect(await b.ledger.head('run:r1')).toEqual({ seq: 2, hash: last.hash });
      const next = (await b.ledger.append(d('run:r1'))).record;
      expect(next).toMatchObject({ seq: 3, prev: last.hash });
      expect((await b.ledger.verify('run:r1')).ok).toBe(true);
      await b.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
