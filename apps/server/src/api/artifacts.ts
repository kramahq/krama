import type { Artifact } from '@kramahq/contract';
import type { Handlers } from './context.js';
import { paginate, pickFieldsPage } from './helpers.js';
import { ApiProblem, notFound } from './problems.js';
import { RawBody, negotiate } from './raw.js';
import { presentArtifact } from './work.js';

const STATUSES = ['draft', 'in_review', 'final', 'rejected', 'superseded'] as const;

interface ListQuery {
  limit?: number;
  cursor?: string;
  fields?: string;
  phase?: string;
  type?: string;
  status?: string;
}

/** A name safe to put in a `Content-Disposition` header: no controls, quotes or separators. */
const downloadName = (name: string): string =>
  encodeURIComponent(
    [...name]
      .map((ch) => {
        const code = ch.charCodeAt(0);
        return code < 0x20 || code === 0x7f || '"\\/'.includes(ch) ? '_' : ch;
      })
      .join(''),
  );

export function artifactHandlers(): Handlers {
  return {
    listRunArtifacts: async (req) => {
      const { ports } = req.ctx.krama;
      const runId = req.params['id']!;
      const q = req.query as ListQuery;
      if (!(await ports.store.runs.get(runId))) throw notFound('Run', runId);
      if (q.status && !(STATUSES as readonly string[]).includes(q.status))
        throw new ApiProblem('validation_failed', 'Unknown status', {
          errors: [{ field: 'status', message: `"${q.status}" is not an artifact status` }],
        });
      const items = await ports.artifacts.listByRun(runId, {
        ...(q.phase ? { phaseId: q.phase } : {}),
        ...(q.type ? { type: q.type } : {}),
        ...(q.status ? { status: q.status as Artifact['status'] } : {}),
      });
      const page = paginate(items.map(presentArtifact), q);
      return pickFieldsPage(page, q.fields);
    },

    getArtifact: async (req) => {
      const a = await req.ctx.krama.ports.artifacts.get(req.params['id']!);
      if (!a) throw notFound('Artifact', req.params['id']);
      return presentArtifact(a);
    },

    getArtifactContent: async (req) => {
      const { artifacts } = req.ctx.krama.ports;
      const id = req.params['id']!;
      const a = await artifacts.get(id);
      if (!a) throw notFound('Artifact', id);
      // Content is addressed by its hash, so the hash is a strong validator.
      const neg = negotiate(req, a.size, { etag: `"${a.sha256}"`, mediaType: a.mediaType });
      if (neg.kind === 'not_modified' || neg.kind === 'unsatisfiable') return neg.response;
      const content = await artifacts.read(id, neg.range);
      if (!content) throw notFound('Artifact content', id);
      return new RawBody(Buffer.from(content.bytes), {
        status: neg.kind === 'partial' ? 206 : 200,
        mediaType: a.mediaType,
        headers: {
          ...neg.headers,
          'content-disposition': `inline; filename*=UTF-8''${downloadName(a.name)}`,
        },
      });
    },

    listArtifactVersions: async (req) => {
      const { artifacts } = req.ctx.krama.ports;
      const id = req.params['id']!;
      if (!(await artifacts.get(id))) throw notFound('Artifact', id);
      const q = req.query as ListQuery;
      return pickFieldsPage(
        paginate((await artifacts.versions(id)).map(presentArtifact), q),
        q.fields,
      );
    },
  };
}
