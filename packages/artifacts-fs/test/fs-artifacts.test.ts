import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FakeClock,
  InMemoryStore,
  SequentialIds,
  artifactStoreContract,
} from '@kramahq/engine/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { ArtifactTooLargeError, FsArtifactStore } from '../src/index.js';

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'krama blobs '));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const make = (over: { maxBytes?: number } = {}) => {
  const store = new InMemoryStore();
  return new FsArtifactStore({
    dir: tmp(),
    catalog: store.artifacts,
    ids: new SequentialIds(),
    clock: new FakeClock(),
    ...over,
  });
};
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)).map((f) => join(e.name, f)) : [e.name],
  );
const producer = { type: 'user', id: 'u1' } as const;
const put = (s: FsArtifactStore, bytes: Uint8Array, over: object = {}) =>
  s.put({
    runId: 'run_1',
    name: 'f.bin',
    type: 'file',
    mediaType: 'application/octet-stream',
    producer,
    bytes,
    ...over,
  });

describe('the shared ArtifactStore contract', () => {
  artifactStoreContract({ describe, it, expect } as never, () => make());
});

describe('blobs on disk', () => {
  it('stores content-addressed under sharded folders, once per distinct content, in a path with spaces', async () => {
    const dir = tmp();
    const s = new FsArtifactStore({
      dir,
      catalog: new InMemoryStore().artifacts,
      ids: new SequentialIds(),
      clock: new FakeClock(),
    });
    const a = await put(s, new TextEncoder().encode('hello'));
    const b = await put(s, new TextEncoder().encode('hello'));
    await put(s, new TextEncoder().encode('world'));
    expect(a.id).not.toBe(b.id);
    expect(a.sha256).toBe(createHash('sha256').update('hello').digest('hex'));
    const blobs = files(dir).filter((f) => !f.startsWith('tmp'));
    expect(blobs).toHaveLength(2);
    expect(blobs[0]).toMatch(/^[0-9a-f]{2}[\\/][0-9a-f]{2}[\\/][0-9a-f]{64}$/);
    expect(files(join(dir, 'tmp'))).toEqual([]); // no temp files left behind
  });

  it('serves byte ranges of a 50 MB file by reading only the slice, byte-exact', async () => {
    const s = make();
    const big = randomBytes(50 * 1024 * 1024);
    const a = await put(s, big);
    expect(a.size).toBe(50 * 1024 * 1024);
    for (const [start, end] of [
      [0, 0],
      [0, 1023],
      [25_000_000, 25_065_535],
      [50 * 1024 * 1024 - 1024, 50 * 1024 * 1024 - 1],
      [10, 5],
    ] as const) {
      const c = await s.read(a.id, { start, end });
      if (start > end) {
        expect(c?.bytes.byteLength).toBe(0);
        continue;
      }
      expect(Buffer.compare(Buffer.from(c!.bytes), big.subarray(start, end + 1))).toBe(0);
      expect(c).toMatchObject({ size: 50 * 1024 * 1024, range: { start, end } });
    }
    // Past the end is clipped, not an error.
    const tail = await s.read(a.id, { start: 50 * 1024 * 1024 - 10, end: 99_999_999_999 });
    expect(tail?.bytes.byteLength).toBe(10);
    // The whole file round-trips too.
    expect(
      createHash('sha256')
        .update((await s.read(a.id))!.bytes)
        .digest('hex'),
    ).toBe(a.sha256);
  }, 60_000);

  it('enforces the size cap and does not store anything for a rejected artifact', async () => {
    const dir = tmp();
    const s = new FsArtifactStore({
      dir,
      catalog: new InMemoryStore().artifacts,
      ids: new SequentialIds(),
      clock: new FakeClock(),
      maxBytes: 10,
    });
    await expect(put(s, new Uint8Array(11))).rejects.toBeInstanceOf(ArtifactTooLargeError);
    expect(files(dir).filter((f) => !f.startsWith('tmp'))).toEqual([]);
    expect((await put(s, new Uint8Array(10))).size).toBe(10);
  });

  it('handles empty artifacts and structured data', async () => {
    const s = make();
    const empty = await put(s, new Uint8Array());
    expect(empty.size).toBe(0);
    expect((await s.read(empty.id))!.bytes.byteLength).toBe(0);
    expect((await s.read(empty.id, { start: 0, end: 10 }))!.bytes.byteLength).toBe(0);
    const json = await put(s, new TextEncoder().encode(JSON.stringify({ high: 2 })), {
      mediaType: 'application/json',
      type: 'data',
    });
    expect(JSON.parse(new TextDecoder().decode((await s.read(json.id))!.bytes))).toEqual({
      high: 2,
    });
  });

  it('concurrent writers of the same content leave one intact blob', async () => {
    const dir = tmp();
    const s = new FsArtifactStore({
      dir,
      catalog: new InMemoryStore().artifacts,
      ids: new SequentialIds(),
      clock: new FakeClock(),
    });
    const bytes = randomBytes(256 * 1024);
    const arts = await Promise.all(Array.from({ length: 8 }, () => put(s, bytes)));
    expect(new Set(arts.map((a) => a.sha256)).size).toBe(1);
    expect(files(dir).filter((f) => !f.startsWith('tmp'))).toHaveLength(1);
    for (const a of arts)
      expect(Buffer.compare(Buffer.from((await s.read(a.id))!.bytes), bytes)).toBe(0);
  });

  it('reports a missing blob as undefined rather than throwing', async () => {
    const dir = tmp();
    const s = new FsArtifactStore({
      dir,
      catalog: new InMemoryStore().artifacts,
      ids: new SequentialIds(),
      clock: new FakeClock(),
    });
    const a = await put(s, new TextEncoder().encode('gone'));
    rmSync(join(dir, a.sha256.slice(0, 2)), { recursive: true });
    expect(await s.read(a.id)).toBeUndefined();
    expect(await s.read(a.id, { start: 0, end: 1 })).toBeUndefined();
    expect(statSync(dir).isDirectory()).toBe(true);
  });
});
