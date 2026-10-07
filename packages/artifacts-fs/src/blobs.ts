import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AuditBlobRef } from '@kramahq/contract';
import type { AuditBlobs } from '@kramahq/engine';
import { renameWithRetry } from './store.js';

const SHA = /^[0-9a-f]{64}$/;

/**
 * Bodies too large to keep inline in an audit record, on disk by content hash (`<dir>/<aa>/<bb>/<sha256>`), written to
 * a temp file and renamed into place so a crash never leaves a half-written blob under its final name. Identical bytes
 * are stored once. Nothing here deletes; retention is a separate, audited operation.
 */
export class FsAuditBlobs implements AuditBlobs {
  constructor(private readonly dir: string) {
    mkdirSync(join(dir, 'tmp'), { recursive: true });
  }

  private path(sha: string): string {
    return join(this.dir, sha.slice(0, 2), sha.slice(2, 4), sha);
  }

  async put(bytes: Uint8Array, mediaType: string): Promise<AuditBlobRef> {
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const dest = this.path(sha256);
    if (!(await this.has(sha256))) {
      mkdirSync(dirname(dest), { recursive: true });
      const tmp = join(
        this.dir,
        'tmp',
        `${sha256}.${process.pid}.${Math.random().toString(36).slice(2)}`,
      );
      await writeFile(tmp, bytes);
      try {
        await renameWithRetry(tmp, dest);
      } catch (e) {
        await unlink(tmp).catch(() => undefined);
        if (!(await this.has(sha256))) throw e; // another writer stored the same content first: fine
      }
    }
    return { sha256, bytes: bytes.byteLength, mediaType };
  }

  async get(sha256: string): Promise<Uint8Array | undefined> {
    if (!SHA.test(sha256)) return undefined;
    try {
      return new Uint8Array(await readFile(this.path(sha256)));
    } catch {
      return undefined;
    }
  }

  async has(sha256: string): Promise<boolean> {
    if (!SHA.test(sha256)) return false;
    return stat(this.path(sha256)).then(
      () => true,
      () => false,
    );
  }
}
