import { createHash } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Artifact } from '@kramahq/contract';
import type {
  ArtifactCatalog,
  ArtifactContent,
  ArtifactStore,
  ByteRange,
  Clock,
  IdGenerator,
  PutArtifact,
} from '@kramahq/engine';

export interface FsArtifactStoreOptions {
  /** Directory for blobs. */
  dir: string;
  /** Where metadata lives (the database's catalog). */
  catalog: ArtifactCatalog;
  ids: IdGenerator;
  clock: Clock;
  /** Largest artifact accepted. Default 512 MiB (contract). */
  maxBytes?: number;
}

export class ArtifactTooLargeError extends Error {
  constructor(
    readonly size: number,
    readonly max: number,
  ) {
    super(`Artifact is ${size} bytes; the limit is ${max}`);
    this.name = 'ArtifactTooLargeError';
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Windows can briefly refuse a rename (`EBUSY`/`EPERM`, antivirus, indexers): retry with backoff. */
export async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      await rename(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (i >= 8 || (code !== 'EBUSY' && code !== 'EPERM' && code !== 'EACCES')) throw e;
      await sleep(25 * (i + 1));
    }
  }
}

/**
 * Content-addressed blobs on disk (`<dir>/<aa>/<bb>/<sha256>`), metadata in the catalog. Identical bytes are stored once.
 * Writes go to a temp file and are renamed into place, so a crash never leaves a half-written blob under its final name.
 * Reads of a byte range open the file and read only that slice, so a range of a huge file costs the range, not the file.
 */
export class FsArtifactStore implements ArtifactStore {
  private readonly max: number;
  constructor(private readonly o: FsArtifactStoreOptions) {
    this.max = o.maxBytes ?? 512 * 1024 * 1024;
    mkdirSync(join(o.dir, 'tmp'), { recursive: true });
  }

  private blobPath(sha: string): string {
    return join(this.o.dir, sha.slice(0, 2), sha.slice(2, 4), sha);
  }

  async put(i: PutArtifact): Promise<Artifact> {
    if (i.bytes.byteLength > this.max)
      throw new ArtifactTooLargeError(i.bytes.byteLength, this.max);
    const prev = i.supersedes ? await this.o.catalog.get(i.supersedes) : undefined;
    if (i.supersedes && !prev) throw new Error(`Cannot supersede unknown artifact ${i.supersedes}`);

    const sha = createHash('sha256').update(i.bytes).digest('hex');
    const dest = this.blobPath(sha);
    const exists = await stat(dest).then(
      () => true,
      () => false,
    );
    if (!exists) {
      mkdirSync(dirname(dest), { recursive: true });
      const tmp = join(
        this.o.dir,
        'tmp',
        `${sha}.${process.pid}.${Math.random().toString(36).slice(2)}`,
      );
      await writeFile(tmp, i.bytes);
      try {
        await renameWithRetry(tmp, dest);
      } catch (e) {
        await unlink(tmp).catch(() => undefined);
        // Another writer stored the same content first: that is fine.
        if (
          !(await stat(dest).then(
            () => true,
            () => false,
          ))
        )
          throw e;
      }
    }

    const a: Artifact = {
      id: this.o.ids.next('art'),
      ...(i.runId ? { runId: i.runId as Artifact['runId'] } : {}),
      ...(i.phaseId ? { phaseId: i.phaseId } : {}),
      ...(i.stepId ? { stepId: i.stepId as Artifact['stepId'] } : {}),
      name: i.name,
      type: i.type,
      mediaType: i.mediaType,
      size: i.bytes.byteLength,
      sha256: sha,
      version: (prev?.version ?? 0) + 1,
      ...(prev ? { supersedes: prev.id } : {}),
      status: 'draft',
      producer: i.producer,
      ...(i.summary ? { summary: i.summary } : {}),
      ...(i.derivedFrom ? { derivedFrom: i.derivedFrom as Artifact['derivedFrom'] } : {}),
      ...(i.meta ? { meta: i.meta } : {}),
      renditions: [],
      createdAt: this.o.clock.now().toISOString(),
      links: {},
    };
    if (prev) await this.o.catalog.put({ ...prev, status: 'superseded' });
    await this.o.catalog.put(a);
    return a;
  }

  get(id: string): Promise<Artifact | undefined> {
    return this.o.catalog.get(id);
  }

  async read(id: string, range?: ByteRange): Promise<ArtifactContent | undefined> {
    const a = await this.o.catalog.get(id);
    if (!a) return undefined;
    const path = this.blobPath(a.sha256);
    if (!range) {
      const bytes = await readFile(path).catch(() => undefined);
      return bytes
        ? { bytes: new Uint8Array(bytes), mediaType: a.mediaType, size: a.size }
        : undefined;
    }
    const start = Math.max(0, range.start);
    const end = Math.min(range.end, a.size - 1);
    if (a.size === 0 || start > end)
      return { bytes: new Uint8Array(), mediaType: a.mediaType, size: a.size };
    const fh = await open(path, 'r').catch(() => undefined);
    if (!fh) return undefined;
    try {
      const buf = Buffer.alloc(end - start + 1);
      const { bytesRead } = await fh.read(buf, 0, buf.length, start);
      return {
        bytes: new Uint8Array(buf.subarray(0, bytesRead)),
        mediaType: a.mediaType,
        size: a.size,
        range: { start, end: start + bytesRead - 1 },
      };
    } finally {
      await fh.close();
    }
  }

  /** Version chain from oldest to newest. */
  async versions(id: string): Promise<Artifact[]> {
    let cur = await this.o.catalog.get(id);
    if (!cur) return [];
    while (cur.supersedes) {
      const prev = await this.o.catalog.get(cur.supersedes);
      if (!prev) break;
      cur = prev;
    }
    const chain: Artifact[] = [];
    for (
      let next: Artifact | undefined = cur;
      next;
      next = await this.o.catalog.findSuperseding(next.id)
    )
      chain.push(next);
    return chain;
  }

  listByRun(
    runId: string,
    filter?: { phaseId?: string; type?: string; status?: Artifact['status'] },
  ): Promise<Artifact[]> {
    return this.o.catalog.listByRun(runId, filter);
  }

  async setStatus(id: string, status: Artifact['status']): Promise<Artifact> {
    const a = await this.o.catalog.get(id);
    if (!a) throw new Error(`Artifact ${id} not found`);
    const next = { ...a, status };
    await this.o.catalog.put(next);
    return next;
  }

  /** Removes the whole blob directory (tests and `krama reset`). */
  destroy(): void {
    rmSync(this.o.dir, { recursive: true, force: true });
  }
}
