import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  agentDefinition,
  agentPreview,
  packPreview,
  operation,
  type AgentDefinition,
  type Pack,
} from '@kramahq/contract';
import { api } from './client';

export type CatalogKind = 'pack' | 'agent';
export type ReviewResult =
  | { kind: 'pack'; preview: ReturnType<typeof packPreview.parse> }
  | { kind: 'agent'; preview: ReturnType<typeof agentPreview.parse> };
export interface SourceDraft {
  url: string;
  ref: string;
  path: string;
  id: string;
  secrets: Record<string, string>;
}
export interface CatalogVersion {
  sha: string;
  digest?: string;
  version?: string;
  at: string;
  by?: string;
  action: string;
  current: boolean;
}

async function allPages<T>(
  read: (cursor?: string) => Promise<{ items: T[]; nextCursor?: string }>,
) {
  const items: T[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await read(cursor);
    items.push(...page.items);
    cursor = page.nextCursor;
    if (cursor && seen.has(cursor))
      throw new Error('The catalogue returned a repeated page. Try refreshing.');
    if (cursor) seen.add(cursor);
  } while (cursor);
  return { items };
}
export const useLibraryPacks = () =>
  useQuery({
    queryKey: ['packs'],
    queryFn: () => allPages<Pack>((cursor) => api.packs.list({ limit: 100, cursor })),
    staleTime: 30_000,
  });
export const useLibraryAgents = () =>
  useQuery({
    queryKey: ['agent-definitions'],
    queryFn: () =>
      allPages<AgentDefinition>(async (cursor) => {
        const page = await api.api.listAgentDefinitions({
          query: { limit: 100, ...(cursor ? { cursor } : {}) },
        });
        return { ...page, items: page.items.map((d) => agentDefinition.parse(d)) };
      }),
    staleTime: 30_000,
  });
export const useLibraryAgent = (id: string) =>
  useQuery({
    queryKey: ['agent-definition', id],
    queryFn: async () =>
      agentDefinition.parse(await api.api.getAgentDefinition({ params: { id } })),
    staleTime: 30_000,
  });

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}
async function finish(initial: unknown, signal: AbortSignal): Promise<unknown> {
  let op = operation.parse(initial);
  const until = Date.now() + 5 * 60_000;
  while (op.status === 'running' || op.status === 'queued') {
    if (Date.now() >= until)
      throw new Error('The preview is taking longer than expected. Try again.');
    await pause(400, signal);
    op = operation.parse(await api.api.getOperation({ params: { id: op.id }, signal }));
  }
  if (op.status !== 'succeeded')
    throw new Error(
      op.error?.detail ?? op.error?.title ?? 'The preview did not complete. Try again.',
    );
  return op.result;
}
export async function previewSource(
  kind: CatalogKind,
  draft: SourceDraft,
  updateId: string | undefined,
  signal: AbortSignal,
): Promise<ReviewResult> {
  const source = {
    url: draft.url.trim(),
    ref: draft.ref.trim() || 'HEAD',
    path: draft.path.trim(),
  };
  if (kind === 'pack') {
    const op = updateId
      ? await api.api.previewPackUpdate({
          params: { id: updateId },
          body: { ref: source.ref },
          signal,
        })
      : await api.api.previewPack({ body: { source }, signal });
    return { kind, preview: packPreview.parse(await finish(op, signal)) };
  }
  const op = updateId
    ? await api.api.previewAgentDefinitionUpdate({
        params: { id: updateId },
        body: { ref: source.ref, secrets: draft.secrets },
        signal,
      })
    : await api.api.previewAgentDefinition({
        body: { id: draft.id.trim(), source, secrets: draft.secrets },
        signal,
      });
  return { kind, preview: agentPreview.parse(await finish(op, signal)) };
}
export async function applyPreview(result: ReviewResult, granted: string[], updateId?: string) {
  const body = {
    previewId: result.preview.previewId,
    manifestDigest: result.preview.manifestDigest,
    consent: { granted, declined: [] },
  };
  if (result.kind === 'pack')
    return updateId
      ? api.api.updatePack({ params: { id: updateId }, body })
      : api.api.installPack({ body });
  return updateId
    ? api.api.updateAgentDefinition({ params: { id: updateId }, body })
    : api.api.installAgentDefinition({ body });
}
export function useRefreshLibrary() {
  const client = useQueryClient();
  return async () => {
    await Promise.all(
      ['packs', 'pack', 'agent-definitions', 'agent-definition', 'catalog-versions'].map((key) =>
        client.invalidateQueries({ queryKey: [key] }),
      ),
    );
  };
}
export function useCatalogVersions(kind: CatalogKind, id: string, enabled: boolean) {
  return useQuery({
    queryKey: ['catalog-versions', kind, id],
    enabled,
    queryFn: async (): Promise<CatalogVersion[]> => {
      const page =
        kind === 'pack'
          ? await api.api.listPackVersions({ params: { id } })
          : await api.api.listAgentDefinitionVersions({ params: { id } });
      return page.items.map((raw, index) => {
        const v = raw as Record<string, unknown>;
        if (typeof v.sha !== 'string' || typeof v.at !== 'string')
          throw new Error('The server returned an unreadable version history.');
        return {
          sha: v.sha,
          at: v.at,
          action: String(v.action ?? 'install'),
          current: index === 0,
          ...(typeof v.digest === 'string' ? { digest: v.digest } : {}),
          ...(typeof v.version === 'string' ? { version: v.version } : {}),
          ...(typeof v.by === 'string' ? { by: v.by } : {}),
        };
      });
    },
  });
}
export async function restoreVersion(
  kind: CatalogKind,
  id: string,
  v: CatalogVersion,
): Promise<unknown> {
  return kind === 'pack'
    ? api.api.rollbackPack({ params: { id }, body: { sha: v.sha } })
    : api.api.rollbackAgentDefinition({
        params: { id },
        body: { sha: v.sha, ...(v.digest ? { digest: v.digest } : {}) },
      });
}
export function removeCatalogItem(kind: CatalogKind, id: string) {
  return kind === 'pack'
    ? api.api.uninstallPack({ params: { id } })
    : api.api.uninstallAgentDefinition({ params: { id } });
}
