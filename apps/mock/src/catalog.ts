import { createHash, randomUUID } from 'node:crypto';
import type {
  AgentDefinition,
  AgentPreview,
  Pack,
  PackPreview,
  PermissionRequest,
} from '@kramahq/contract';
import type { MockState } from './state.js';
import type { Handler } from './handlers.js';
import { ProblemError, notFound } from './problems.js';

type Kind = 'pack' | 'agent';
type Item = Pack | AgentDefinition;
interface Version {
  item: Item;
  sha: string;
  digest: string;
  at: string;
  by: string;
  action: string;
  consent: { granted: string[]; declined: string[] };
  source: Pack['source'] | AgentDefinition['source'];
  current: boolean;
  version?: string;
}
interface Held {
  kind: Kind;
  item: Item;
  preview: PackPreview | AgentPreview;
  update?: string;
}
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const packLinks = (p: Pack) => ({
  ...p,
  links: { ...p.links, update: { href: `/api/v1/packs/${p.id}/update`, method: 'POST' as const } },
});

/** Sample-data lifecycle responses. No remote is fetched and no wrapper is started. */
export function mockCatalog(
  s: MockState,
  pendingOp: (type: string, result: Record<string, unknown>) => unknown,
  audit: (action: string, subject: { type: string; id: string }) => void,
): Record<string, Handler> {
  const held = new Map<string, Held>();
  const history = new Map<string, Version[]>();
  const repeated = new Map<string, Item>();
  s.packs = s.packs.map(packLinks);
  const list = (kind: Kind): Item[] => (kind === 'pack' ? s.packs : s.definitions);
  const requireItem = (kind: Kind, id: string) => {
    const item = list(kind).find((i) => i.id === id);
    if (!item) throw notFound(kind, id);
    return item;
  };
  const set = (kind: Kind, item: Item) => {
    if (kind === 'pack') {
      s.packs = [...s.packs.filter((p) => p.id !== item.id), packLinks(item as Pack)];
    } else
      s.definitions = [...s.definitions.filter((p) => p.id !== item.id), item as AgentDefinition];
  };
  const remember = (
    kind: Kind,
    item: Item,
    action: string,
    consent: Version['consent'],
    record = true,
  ) => {
    const key = `${kind}:${item.id}`;
    const v: Version = {
      item: structuredClone(item),
      sha: item.source.sha ?? '',
      digest: digest(item),
      source: item.source,
      at: new Date().toISOString(),
      by: 'u_priya',
      action,
      consent,
      current: true,
      ...('version' in item ? { version: item.version } : {}),
    };
    history.set(key, [...(history.get(key) ?? []).map((v) => ({ ...v, current: false })), v]);
    if (record)
      audit(
        `${kind === 'pack' ? 'pack' : 'agent_definition'}.${action === 'rollback' ? 'rolled_back' : action === 'install' ? 'installed' : 'updated'}`,
        { type: kind, id: item.id },
      );
  };
  for (const p of s.packs.filter((p) => p.status !== 'available'))
    remember(
      'pack',
      p,
      'install',
      { granted: p.permissions.map((p) => p.id), declined: [] },
      false,
    );
  const preview = (
    kind: Kind,
    req: { body: any; params: Record<string, string> },
    update?: string,
  ) => {
    const source = update
      ? { ...requireItem(kind, update).source, ref: req.body?.ref || 'HEAD' }
      : { ...req.body.source, ref: req.body.source.ref || 'HEAD' };
    const sha = digest({ source, version: randomUUID() }).slice(0, 40);
    const base =
      kind === 'pack'
        ? update
          ? requireItem(kind, update)
          : (s.packs.find((p) => p.source.url === source.url) ??
            s.packs.find((p) => p.status === 'available') ??
            s.packs[0])
        : update
          ? requireItem(kind, update)
          : s.definitions[0];
    if (!base) throw new ProblemError('not_found', 'No sample definition available');
    let item: Item;
    let permissions: PermissionRequest[];
    if (kind === 'pack') {
      item = packLinks({
        ...(structuredClone(base) as Pack),
        source: { type: 'git', ...source, sha },
        status: 'available',
        ...(update ? { version: `${(base as Pack).version}-next` } : {}),
      });
      permissions = (item as Pack).permissions;
    } else {
      const name = update ?? req.body.id;
      const [role, variant] = name.split('/');
      item = {
        ...(structuredClone(base) as AgentDefinition),
        id: name,
        role,
        variant,
        name: update ? base.name : `Git ${role}`,
        source: { type: 'git', ...source, sha },
        backend: {
          ...(base as AgentDefinition).backend,
          secrets: req.body?.secrets ?? (base as AgentDefinition).backend.secrets ?? {},
        },
      };
      permissions = Object.entries(item.backend.secrets ?? {}).map(([name, ref]) => ({
        id: `secret_ref:${ref}:agent`,
        kind: 'secret_ref' as const,
        subject: ref,
        access: `as ${name}`,
        risk: 'medium' as const,
        requestedBy: 'agent',
      }));
      permissions.push({
        id: `source:${source.url}`,
        kind: 'network',
        subject: source.url,
        risk: 'high',
        reason: 'This sample source is not trusted.',
        requestedBy: 'source',
      });
    }
    const common = {
      previewId: `prev_${randomUUID()}`,
      manifestDigest: digest(item),
      sha,
      trust: 'untrusted' as const,
      issues: [],
      permissions,
      secretsToBind: Object.values(
        kind === 'agent'
          ? ((item as AgentDefinition).backend.secrets ?? {})
          : Object.fromEntries((item as Pack).requirements.secrets.map((s) => [s, s])),
      ).map((ref) => ({ ref, bound: false })),
      expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
      ...(update
        ? {
            diff: {
              added: [],
              removed: [],
              changed: [{ path: 'source.sha', summary: 'A newer sample commit is available' }],
              permissionChanges: permissions,
            },
          }
        : {}),
    };
    const result: PackPreview | AgentPreview =
      kind === 'pack'
        ? { ...common, manifest: item as Pack, engineCompatible: true, skills: [], definitions: [] }
        : { ...common, definition: item as AgentDefinition, declaredSubAgents: [] };
    held.set(result.previewId, { kind, item, preview: result, ...(update ? { update } : {}) });
    return pendingOp(
      `${kind === 'pack' ? 'pack' : 'agent_definition'}.${update ? 'update.preview' : 'preview'}`,
      { ...result },
    );
  };
  const apply = (kind: Kind, req: Parameters<Handler>[0], update?: string) => {
    const key = req.headers['idempotency-key'];
    if (typeof key === 'string' && repeated.has(key)) return structuredClone(repeated.get(key)!);
    const h = held.get(req.body.previewId);
    if (
      !h ||
      h.kind !== kind ||
      h.update !== update ||
      h.preview.manifestDigest !== req.body.manifestDigest ||
      Date.parse(h.preview.expiresAt) <= Date.now()
    )
      throw new ProblemError('conflict', 'Preview the source again');
    const granted = new Set<string>(req.body.consent.granted);
    if (req.body.consent.declined.length)
      throw new ProblemError('forbidden', 'Required permissions were declined');
    if (
      h.preview.permissions.some((p) => !granted.has(p.id)) ||
      [...granted].some((id) => !h.preview.permissions.some((p) => p.id === id))
    )
      throw new ProblemError('validation_failed', 'Answer every permission in the preview');
    if (
      !update &&
      list(kind).some(
        (i) => i.id === h.item.id && (kind === 'agent' || (i as Pack).status !== 'available'),
      )
    )
      throw new ProblemError('conflict', 'This item is already installed');
    const item = structuredClone(h.item);
    if (kind === 'pack') (item as Pack).status = 'installed';
    set(kind, item);
    remember(kind, item, update ? 'update' : 'install', req.body.consent);
    held.delete(req.body.previewId);
    if (typeof key === 'string') repeated.set(key, item);
    return item;
  };
  const versions = (kind: Kind, id: string) => {
    requireItem(kind, id);
    return {
      items: [...(history.get(`${kind}:${id}`) ?? [])].reverse().map(({ item: _item, ...v }) => {
        void _item;
        return v;
      }),
    };
  };
  const rollback = (kind: Kind, req: Parameters<Handler>[0]) => {
    const id = decodeURIComponent(req.params.id!);
    requireItem(kind, id);
    const target = [...(history.get(`${kind}:${id}`) ?? [])]
      .reverse()
      .find((v) => v.sha === req.body.sha && (!req.body.digest || v.digest === req.body.digest));
    if (!target) throw notFound('version', req.body.sha);
    set(kind, target.item);
    remember(kind, target.item, 'rollback', target.consent);
    return target.item;
  };
  const remove = (kind: Kind, req: Parameters<Handler>[0]) => {
    const id = decodeURIComponent(req.params.id!);
    requireItem(kind, id);
    if (kind === 'pack') s.packs = s.packs.filter((p) => p.id !== id);
    else s.definitions = s.definitions.filter((d) => d.id !== id);
    audit(`${kind}.uninstalled`, { type: kind, id });
  };
  return {
    previewPack: (req, reply) => {
      const result = preview('pack', req);
      reply.code(202);
      return result;
    },
    installPack: (req, reply) => {
      const item = apply('pack', req);
      reply.code(201);
      return item;
    },
    previewPackUpdate: (req, reply) => {
      const result = preview('pack', req, req.params.id!);
      reply.code(202);
      return result;
    },
    updatePack: (req) => apply('pack', req, req.params.id!),
    listPackVersions: (req) => versions('pack', req.params.id!),
    rollbackPack: (req) => rollback('pack', req),
    enablePack: (req) => {
      const p = requireItem('pack', req.params.id!) as Pack;
      p.status = 'installed';
      return p;
    },
    disablePack: (req) => {
      const p = requireItem('pack', req.params.id!) as Pack;
      p.status = 'disabled';
      return p;
    },
    uninstallPack: (req, reply) => {
      remove('pack', req);
      reply.code(204);
    },
    previewAgentDefinition: (req, reply) => {
      const result = preview('agent', req);
      reply.code(202);
      return result;
    },
    installAgentDefinition: (req, reply) => {
      const item = apply('agent', req);
      reply.code(201);
      return item;
    },
    previewAgentDefinitionUpdate: (req, reply) => {
      const result = preview('agent', req, decodeURIComponent(req.params.id!));
      reply.code(202);
      return result;
    },
    updateAgentDefinition: (req) => apply('agent', req, decodeURIComponent(req.params.id!)),
    listAgentDefinitionVersions: (req) => versions('agent', decodeURIComponent(req.params.id!)),
    rollbackAgentDefinition: (req) => rollback('agent', req),
    uninstallAgentDefinition: (req, reply) => {
      remove('agent', req);
      reply.code(204);
    },
  };
}
