import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { FsAuditBlobs } from '../src/index.js';

const dir = mkdtempSync(join(tmpdir(), 'krama audit blobs-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('FsAuditBlobs', () => {
  const blobs = new FsAuditBlobs(dir);
  const bytes = (s: string) => new TextEncoder().encode(s);

  it('stores by content hash and reads back the same bytes, in a path with spaces', async () => {
    const ref = await blobs.put(bytes('hello'), 'text/plain');
    expect(ref).toMatchObject({
      sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
      bytes: 5,
      mediaType: 'text/plain',
    });
    expect(await blobs.has(ref.sha256)).toBe(true);
    expect(new TextDecoder().decode(await blobs.get(ref.sha256))).toBe('hello');
  });

  it('keeps arbitrary bytes intact, including zeros and a large body', async () => {
    const raw = new Uint8Array(3 * 1024 * 1024).map((_, i) => (i * 31) % 256);
    const ref = await blobs.put(raw, 'application/octet-stream');
    const back = await blobs.get(ref.sha256);
    expect(back?.byteLength).toBe(raw.byteLength);
    expect(Buffer.compare(Buffer.from(back!), Buffer.from(raw))).toBe(0);
  });

  it('stores identical bytes once, even when written at the same time', async () => {
    const same = bytes('written twice');
    const refs = await Promise.all(Array.from({ length: 8 }, () => blobs.put(same, 'text/plain')));
    expect(new Set(refs.map((r) => r.sha256)).size).toBe(1);
    expect(readdirSync(join(dir, 'tmp'))).toEqual([]); // no temp files left behind
  });

  it('answers undefined, not an error, for a missing or malformed hash and never reads outside its folder', async () => {
    expect(await blobs.get('0'.repeat(64))).toBeUndefined();
    expect(await blobs.has('0'.repeat(64))).toBe(false);
    expect(await blobs.get('../../etc/passwd')).toBeUndefined();
    expect(await blobs.has('not-a-hash')).toBe(false);
  });
});
