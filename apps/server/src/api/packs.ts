import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import type { ActorRef, PackPreview } from '@kramahq/contract';
import type { PackVersion } from '../packs/manager.js';
import { PackError } from '../packs/manager.js';
import type { ApiRequest, Handlers } from './context.js';
import { ApiProblem, toProblem } from './problems.js';
import { actorOf } from './work.js';

interface Consent {
  granted: string[];
  declined: string[];
}
interface Review {
  previewId: string;
  manifestDigest: string;
  consent: Consent;
}

const MAX_FILE = 256 * 1024;

/** A version as a client reads it: where it came from and when, never the internal pins. */
const presentVersion = (v: PackVersion, current: string) => ({
  sha: v.sha,
  version: v.version,
  digest: v.digest,
  at: v.at,
  by: v.by,
  action: v.action,
  source: v.source,
  current: v.sha === current,
  ...(v.consent ? { consent: v.consent } : {}),
});

/**
 * A path inside a pack's checkout and nowhere else: relative, no `..`, and after following symlinks still under the
 * root. The checkout is someone else's repository, so a link in it must not lead out.
 */
async function inside(root: string, rel: string): Promise<string> {
  const bad = () =>
    new ApiProblem('validation_failed', 'That path is not inside the pack', {
      errors: [{ field: 'path', message: 'Use a path inside the pack' }],
    });
  if (rel.includes('\0') || /^([a-zA-Z]:)?[\\/]/.test(rel)) throw bad();
  const target = resolve(root, rel);
  const real = await realpath(target).catch(() => undefined);
  const base = await realpath(root);
  if (!real) throw new ApiProblem('not_found', `${rel || '/'} does not exist in this pack`);
  if (real !== base && !real.startsWith(base + sep)) throw bad();
  return real;
}

/** The pack routes that install, update and take back what comes from git (M9.1). Listing and reading stay in the catalogue. */
export function packHandlers(): Handlers {
  const manager = (req: ApiRequest) => req.ctx.krama.packs;
  const actor = (req: ApiRequest): ActorRef => actorOf(req.principal);

  return {
    // The preview fetches and validates, which can take a while on a first fetch: it is an operation, as the contract says.
    previewPack: (req) => {
      const { source } = req.body as { source: { url: string; ref?: string; path?: string } };
      const op = req.ctx.operations.start(
        {
          type: 'pack.preview',
          owner: req.principal.id,
          message: 'Fetching and checking the pack',
        },
        async () => {
          try {
            return { ...(await manager(req).preview(source)) } as Record<string, unknown>;
          } catch (e) {
            throw toProblem(e, req.requestId);
          }
        },
      );
      return op;
    },
    previewPackUpdate: (req) => {
      const id = req.params['id']!;
      const body = (req.body ?? {}) as { ref?: string };
      return req.ctx.operations.start(
        { type: 'pack.update.preview', owner: req.principal.id, message: 'Fetching what changed' },
        async () => {
          try {
            return {
              ...(await manager(req).previewUpdate(id, body.ref ? { ref: body.ref } : undefined)),
            } as Record<string, unknown>;
          } catch (e) {
            throw toProblem(e, req.requestId);
          }
        },
      );
    },
    installPack: (req) => manager(req).install(req.body as Review, actor(req)),
    updatePack: (req) => manager(req).update(req.params['id']!, req.body as Review, actor(req)),
    rollbackPack: (req) =>
      manager(req).rollback(req.params['id']!, (req.body as { sha: string }).sha, actor(req)),
    disablePack: (req) => manager(req).setEnabled(req.params['id']!, false, actor(req)),
    enablePack: (req) => manager(req).setEnabled(req.params['id']!, true, actor(req)),
    uninstallPack: async (req, reply) => {
      await manager(req).uninstall(req.params['id']!, actor(req));
      reply.code(204);
      return undefined;
    },
    getPackManifest: async (req) => manager(req).manifest(req.params['id']!),
    listPackVersions: async (req) => {
      const id = req.params['id']!;
      const pack = await manager(req).get(id);
      if (!pack) throw new PackError('not_found', `Pack ${id} not found`);
      const versions = manager(req).versions(id);
      return { items: versions.map((v) => presentVersion(v, pack.source.sha)) };
    },
    // A read-only browser over the checkout: a directory lists its entries, a file gives its text (cut at 256 KB).
    getPackFiles: async (req) => {
      const root = await manager(req).rootOf(req.params['id']!);
      const rel = String((req.query as { path?: string }).path ?? '').replace(/^\/+/, '');
      const target = await inside(root, rel);
      const st = await lstat(target);
      const shown = relative(await realpath(root), target)
        .split(sep)
        .join('/');
      if (st.isDirectory()) {
        const names = (await readdir(target)).filter((n) => n !== '.git').sort();
        const entries = await Promise.all(
          names.map(async (name) => {
            const s = await lstat(join(target, name));
            return {
              name,
              type: s.isDirectory() ? 'directory' : s.isSymbolicLink() ? 'link' : 'file',
              ...(s.isFile() ? { size: s.size } : {}),
            };
          }),
        );
        return { path: shown, type: 'directory', entries };
      }
      const bytes = await readFile(target);
      const binary = bytes.subarray(0, 8000).includes(0);
      return {
        path: shown,
        type: 'file',
        size: st.size,
        ...(binary
          ? { binary: true }
          : {
              content: bytes.subarray(0, MAX_FILE).toString('utf8'),
              truncated: bytes.length > MAX_FILE,
            }),
      };
    },
  };
}

export type { PackPreview };
