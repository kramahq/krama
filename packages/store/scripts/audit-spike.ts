// M2.5 spike: how fast and how big is the hash-chained audit record, and does it get in the way of the event log when it
// shares a database? Run after a build:  node scripts/audit-spike.ts [pglite|postgres://...] [--quick]
// Prints one JSON object. Numbers depend on the machine; the shape of the answer is what matters.
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { openPglite, openPostgres, type OpenedStore } from '../dist/index.js';

const target = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'pglite';
const quick = process.argv.includes('--quick');
const N = quick ? 100 : 400;

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return +s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!.toFixed(2);
};
// Random text does not compress, so the sizes below are a worst case for storage; real transcripts compress well.
const text = (bytes: number) =>
  randomBytes(Math.ceil(bytes / 2))
    .toString('hex')
    .slice(0, bytes);
const draft = (chain: string, i: number, payload: unknown) => ({
  chain,
  actor: { type: 'agent' as const, id: 'agent_1' },
  kind: 'tool.result',
  source: 'a2a-stream' as const,
  sourceEventId: `${chain}-${i}`,
  payload,
});

async function openOne(label: string): Promise<{ o: OpenedStore; dir?: string }> {
  if (target === 'pglite') {
    const dir = mkdtempSync(join(tmpdir(), `krama-spike-${label}-`));
    return { o: await openPglite(dir), dir };
  }
  const base = new URL(target);
  const name = `krama_spike_${label}`;
  const admin = await openPostgres(target);
  await admin.db.execute(sql.raw(`drop database if exists ${name}`));
  await admin.db.execute(sql.raw(`create database ${name}`));
  await admin.close();
  base.pathname = `/${name}`;
  return { o: await openPostgres(base.toString()) };
}

const dirSize = (d: string): number =>
  readdirSync(d, { withFileTypes: true }).reduce(
    (n, e) => n + (e.isDirectory() ? dirSize(join(d, e.name)) : statSync(join(d, e.name)).size),
    0,
  );

async function relationBytes(o: OpenedStore, table: string): Promise<number> {
  const r = (await o.db.execute(
    sql.raw(`select pg_total_relation_size('${table}') as b`),
  )) as unknown as { rows: { b: string | number }[] };
  return Number(r.rows[0]!.b);
}

async function timed<T>(fn: () => Promise<T>): Promise<{ ms: number; value: T }> {
  const t = performance.now();
  const value = await fn();
  return { ms: performance.now() - t, value };
}

const out: Record<string, unknown> = {
  target: target === 'pglite' ? 'pglite' : 'postgres',
  records: N,
};

// A. One chain, one writer: records per second and storage per record, by payload size.
{
  const { o, dir } = await openOne('a');
  const rows: unknown[] = [];
  for (const size of [300, 2_000, 8_000]) {
    const chain = `run:size${size}`;
    const before = await relationBytes(o, 'audit_records');
    const lat: number[] = [];
    const t0 = performance.now();
    for (let i = 0; i < N; i++) {
      const { ms } = await timed(() => o.ledger.append(draft(chain, i, { t: text(size) })));
      lat.push(ms);
    }
    const secs = (performance.now() - t0) / 1000;
    const after = await relationBytes(o, 'audit_records');
    const v = await timed(() => o.ledger.verify(chain));
    rows.push({
      payloadBytes: size,
      appendsPerSec: Math.round(N / secs),
      p50ms: pct(lat, 50),
      p95ms: pct(lat, 95),
      dbBytesPerRecord: Math.round((after - before) / N),
      verifyRecordsPerSec: Math.round(N / (v.ms / 1000)),
      verifyOk: v.value.ok,
    });
  }
  out.singleChain = rows;
  await o.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
}

// B. Many runs at once (each its own chain): does throughput scale, or do chains queue behind each other?
{
  const { o, dir } = await openOne('b');
  for (const runs of [1, 4, 8]) {
    const per = Math.max(10, Math.floor(N / 2));
    const t0 = performance.now();
    const lat: number[] = [];
    await Promise.all(
      Array.from({ length: runs }, async (_, r) => {
        for (let i = 0; i < per; i++) {
          const { ms } = await timed(() =>
            o.ledger.append(draft(`run:par${runs}-${r}`, i, { t: text(2_000) })),
          );
          lat.push(ms);
        }
      }),
    );
    const secs = (performance.now() - t0) / 1000;
    (out.concurrentChains ??= [] as unknown[]) as unknown[];
    (out.concurrentChains as unknown[]).push({
      chains: runs,
      appendsPerSec: Math.round((runs * per) / secs),
      p50ms: pct(lat, 50),
      p95ms: pct(lat, 95),
    });
  }
  await o.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
}

// C. Same database or separate? Measure the event log's append latency (the existing hot path) on its own, with audit
// writes running at the same time in the same database, and with audit writes in a second database.
{
  const evt = (i: number) => ({
    type: 'activity.message',
    runId: 'run_spike' as const,
    subject: { type: 'run', id: 'run_spike' },
    data: { i, t: text(500) },
  });
  const measure = async (events: OpenedStore, withAudit: OpenedStore | undefined) => {
    const lat: number[] = [];
    let stop = false;
    const noise = withAudit
      ? (async () => {
          let i = 0;
          while (!stop) {
            await Promise.all(
              Array.from({ length: 4 }, (_, r) =>
                withAudit.ledger.append(draft(`run:noise${r}`, i++, { t: text(2_000) })),
              ),
            );
          }
        })()
      : Promise.resolve();
    for (let i = 0; i < N; i++) {
      const { ms } = await timed(() => events.events.append(evt(i)));
      lat.push(ms);
    }
    stop = true;
    await noise;
    return { p50ms: pct(lat, 50), p95ms: pct(lat, 95), p99ms: pct(lat, 99) };
  };
  const alone = await openOne('c1');
  const aloneRes = await measure(alone.o, undefined);
  await alone.o.close();
  const same = await openOne('c2');
  const sameRes = await measure(same.o, same.o);
  await same.o.close();
  const ev = await openOne('c3');
  const au = await openOne('c4');
  const sepRes = await measure(ev.o, au.o);
  await ev.o.close();
  await au.o.close();
  for (const d of [alone.dir, same.dir, ev.dir, au.dir])
    if (d) rmSync(d, { recursive: true, force: true });
  out.eventLogLatency = {
    eventLogAlone: aloneRes,
    auditInSameDatabase: sameRes,
    auditInSeparateDatabase: sepRes,
  };
}

// D. Where should the cut between "inline in the record" and "a blob on disk" be? Body sizes from 4 KiB to 1 MiB, written
// inline and as a blob (a temp file renamed into place, as FsAuditBlobs does): latency and database bytes per record.
{
  const { o, dir } = await openOne('d');
  const blobDir = mkdtempSync(join(tmpdir(), 'krama-spike-blobs-'));
  const rows: unknown[] = [];
  const reps = quick ? 20 : 60;
  for (const size of [4_096, 16_384, 65_536, 262_144, 1_048_576]) {
    const inline: number[] = [];
    const before1 = await relationBytes(o, 'audit_records');
    for (let i = 0; i < reps; i++)
      inline.push(
        (await timed(() => o.ledger.append(draft(`run:in${size}`, i, { t: text(size) })))).ms,
      );
    const inlineBytes = Math.round(((await relationBytes(o, 'audit_records')) - before1) / reps);

    const viaBlob: number[] = [];
    const before2 = await relationBytes(o, 'audit_records');
    for (let i = 0; i < reps; i++) {
      const body = Buffer.from(text(size));
      const { ms } = await timed(async () => {
        const sha = createHash('sha256').update(body).digest('hex');
        const tmp = join(blobDir, `${sha}.tmp`);
        await writeFile(tmp, body);
        await rename(tmp, join(blobDir, sha));
        await o.ledger.append({
          ...draft(`run:bl${size}`, i, undefined),
          blob: { sha256: sha, bytes: body.byteLength, mediaType: 'application/json' },
        });
      });
      viaBlob.push(ms);
    }
    const blobRecordBytes = Math.round(
      ((await relationBytes(o, 'audit_records')) - before2) / reps,
    );
    rows.push({
      bodyBytes: size,
      inlineP50ms: pct(inline, 50),
      inlineP95ms: pct(inline, 95),
      inlineDbBytesPerRecord: inlineBytes,
      blobP50ms: pct(viaBlob, 50),
      blobP95ms: pct(viaBlob, 95),
      blobDbBytesPerRecord: blobRecordBytes,
    });
  }
  out.inlineVersusBlob = rows;
  out.blobDirBytes = dirSize(blobDir);
  rmSync(blobDir, { recursive: true, force: true });
  await o.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
}

console.log(JSON.stringify(out, null, 2));
