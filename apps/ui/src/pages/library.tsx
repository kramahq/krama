import { useMutation } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import type { AgentDefinition, Pack } from '@kramahq/contract';
import { Bot, ChevronRight, GitBranch, Package, Plus, RefreshCw, Search } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { api } from '@/api/client';
import {
  removeCatalogItem,
  useLibraryAgent,
  useLibraryAgents,
  useLibraryPacks,
  useRefreshLibrary,
  type CatalogKind,
} from '@/api/catalog';
import { useMe, usePack } from '@/api/queries';
import { GitReview } from '@/components/catalog/review';
import { Permissions } from '@/components/catalog/permissions';
import { VersionHistory } from '@/components/catalog/history';
import { TeamPanel } from '@/components/team-panel';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Fact,
  PageHeader,
  RoleChip,
  Segmented,
  Skeleton,
} from '@/components/ui/primitives';
import { useToast } from '@/components/ui/toast';
import { LoadError } from './errors';

const rights = (roles: string[] = []) => ({
  preview: roles.some((r) => ['owner', 'admin', 'operator', 'author'].includes(r)),
  manage: roles.some((r) => ['owner', 'admin'].includes(r)),
});
const short = (sha?: string) => (sha ? sha.slice(0, 12) : 'Not pinned');
function ItemLink({ kind, id, children }: { kind: CatalogKind; id: string; children: ReactNode }) {
  const className =
    'block h-full rounded-card border border-line bg-raised p-4 text-inherit no-underline transition-colors hover:border-line2 hover:bg-hover';
  return kind === 'pack' ? (
    <Link to="/packs/$packId" params={{ packId: id }} className={className}>
      {children}
    </Link>
  ) : (
    <Link to="/agents/$definitionId" params={{ definitionId: id }} className={className}>
      {children}
    </Link>
  );
}
interface LibraryRow {
  id: string;
  name: string;
  description: string;
  status: string;
  source: string;
  meta: string;
  tags: string[];
  trust?: string;
}
function LibraryList({
  kind,
  rows,
  loading,
  refreshing,
  error,
  retry,
}: {
  kind: CatalogKind;
  rows: LibraryRow[];
  loading: boolean;
  refreshing: boolean;
  error: Error | null;
  retry: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const me = useMe();
  const access = rights(me.data?.roles);
  const search = useSearch({ strict: false });
  const navigate = useNavigate();
  const q = 'q' in search ? (search.q ?? '') : '';
  const filter = 'filter' in search && search.filter === 'installed' ? 'installed' : 'all';
  const title = kind === 'pack' ? 'Packs' : 'Agents';
  const visible = rows.filter(
    (r) =>
      (filter !== 'installed' ||
        ['installed', 'update_available', 'disabled', 'git'].includes(r.status)) &&
      (!q ||
        `${r.name} ${r.description} ${r.tags.join(' ')}`.toLowerCase().includes(q.toLowerCase())),
  );
  const setSearch = (next: { q?: string; filter?: string }) =>
    void navigate({ to: kind === 'pack' ? '/packs' : '/agents', search: next, replace: true });
  if (error) return <LoadError error={error} retry={retry} />;
  return (
    <div>
      <PageHeader
        title={title}
        sub={
          kind === 'pack'
            ? 'Reusable teams, pinned to the versions you choose.'
            : 'Reusable agents for your teams. Registered here, started when a run needs them.'
        }
      >
        <Button
          size="sm"
          aria-label={`Refresh ${title.toLowerCase()}`}
          onClick={retry}
          disabled={refreshing}
        >
          <RefreshCw className={`size-3.5 ${refreshing ? 'animate-spin' : ''}`} aria-hidden />
        </Button>
        {access.preview && (
          <Button variant="primary" onClick={() => setAdding(true)}>
            <Plus className="size-4" aria-hidden />
            {kind === 'pack' ? 'Add pack' : 'Add agent'}
          </Button>
        )}
      </PageHeader>
      <div className="space-y-5 px-4 pb-8 md:px-7">
        {adding && (
          <GitReview
            key={kind}
            kind={kind}
            onCancel={() => setAdding(false)}
            onDone={(id) => {
              setAdding(false);
              if (kind === 'pack') void navigate({ to: '/packs/$packId', params: { packId: id } });
              else void navigate({ to: '/agents/$definitionId', params: { definitionId: id } });
            }}
          />
        )}
        <div className="flex flex-wrap items-center gap-3">
          <Segmented
            label={`Show ${title.toLowerCase()}`}
            value={filter}
            onChange={(filter) => setSearch({ q, filter })}
            options={[
              { value: 'all', label: 'All', count: rows.length },
              {
                value: 'installed',
                label: kind === 'pack' ? 'Installed' : 'From Git',
                count: rows.filter((r) =>
                  ['installed', 'update_available', 'disabled', 'git'].includes(r.status),
                ).length,
              },
            ]}
          />
          <label className="relative ml-auto w-full sm:w-72">
            <Search className="absolute top-2.5 left-3 size-4 text-ink3" aria-hidden />
            <span className="sr-only">Search {title.toLowerCase()}</span>
            <input
              type="search"
              value={q}
              onChange={(e) => setSearch({ q: e.target.value || undefined, filter })}
              placeholder={`Search ${title.toLowerCase()}`}
              className="h-9 w-full rounded-lg border border-line2 bg-raised pr-3 pl-9 text-sm"
            />
          </label>
        </div>
        {loading ? (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-48" />
            ))}
          </div>
        ) : !visible.length ? (
          <Card>
            <EmptyState
              icon={kind === 'pack' ? <Package className="size-8" /> : <Bot className="size-8" />}
              title={
                rows.length ? `No ${title.toLowerCase()} match` : `No ${title.toLowerCase()} yet`
              }
            >
              {rows.length
                ? 'Try a different filter or search.'
                : access.preview
                  ? `Add ${kind === 'pack' ? 'a pack' : 'an agent'} from Git to review its tools and access.`
                  : 'An administrator can add Git sources to this library.'}
            </EmptyState>
          </Card>
        ) : (
          <div className="grid items-stretch gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {visible.map((r) => (
              <ItemLink key={r.id} kind={kind} id={r.id}>
                <div className="mb-4 flex items-start justify-between gap-3">
                  <span className="flex size-10 items-center justify-center rounded-lg border border-line bg-panel text-ink2">
                    {kind === 'pack' ? (
                      <Package className="size-5" aria-hidden />
                    ) : (
                      <Bot className="size-5" aria-hidden />
                    )}
                  </span>
                  <Badge
                    tone={
                      r.status === 'disabled' ? 'warn' : r.status === 'available' ? 'neutral' : 'ok'
                    }
                  >
                    {r.status === 'git' ? 'Git installed' : r.status}
                  </Badge>
                </div>
                <h2 className="m-0 flex items-center gap-2 font-serif text-2xl font-normal">
                  {r.name}
                  <ChevronRight className="ml-auto size-4 text-ink3" aria-hidden />
                </h2>
                <p className="mt-2 mb-4 line-clamp-2 min-h-10 text-sm text-ink2">{r.description}</p>
                <div className="mb-3 flex flex-wrap gap-1.5">
                  {r.tags.slice(0, 4).map((t) => (
                    <Badge key={t}>{t}</Badge>
                  ))}
                </div>
                <div className="border-t border-line pt-3 text-xs text-ink3">
                  <div className="mb-1">{r.meta}</div>
                  <div className="flex items-center gap-1.5 font-mono">
                    <GitBranch className="size-3 shrink-0" aria-hidden />
                    <span className="truncate">{r.source}</span>
                  </div>
                </div>
              </ItemLink>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
export function PacksPage() {
  const packs = useLibraryPacks();
  return (
    <LibraryList
      kind="pack"
      rows={(packs.data?.items ?? []).map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        status: p.status,
        source: `${p.source?.ref ?? 'Source supplied by server'} · ${short(p.source?.sha)}`,
        meta: `v${p.version} · ${Object.keys(p.agents ?? {}).length || p.roster?.length || 0} agents`,
        tags: p.tags,
        trust: p.trust,
      }))}
      loading={packs.isLoading}
      refreshing={packs.isFetching}
      error={packs.error}
      retry={() => void packs.refetch()}
    />
  );
}
export function AgentsPage() {
  const agents = useLibraryAgents();
  return (
    <LibraryList
      kind="agent"
      rows={(agents.data?.items ?? []).map((a) => ({
        id: a.id,
        name: a.name,
        description: a.description,
        status: a.source.type,
        source:
          a.source.type === 'git'
            ? `${a.source.ref ?? 'Git'} · ${short(a.source.sha)}`
            : a.source.type === 'pack'
              ? 'From a pack'
              : 'Local definition',
        meta: `${a.backend.wrapper}${a.backend.model ? ` · ${a.backend.model}` : ''}`,
        tags: a.capabilities,
      }))}
      loading={agents.isLoading}
      refreshing={agents.isFetching}
      error={agents.error}
      retry={() => void agents.refetch()}
    />
  );
}

function SourceFacts({ source }: { source: Pack['source'] | AgentDefinition['source'] }) {
  return (
    <Card className="p-4">
      <h2 className="mb-3 font-serif text-xl font-normal">Pinned source</h2>
      <dl className="space-y-3">
        <Fact label="Repository">
          <span className="break-all whitespace-normal">
            {'url' in source && source.url
              ? source.url
              : source.type === 'pack'
                ? 'Provided by a pack'
                : 'Provided by this server'}
          </span>
        </Fact>
        {source.ref && <Fact label="Git ref">{source.ref}</Fact>}
        {source.path && <Fact label="Path">{source.path}</Fact>}
        <Fact label="Commit">
          <code title={source.sha}>{short(source.sha)}</code>
        </Fact>
        {'digest' in source && source.digest && (
          <details className="break-all text-xs text-ink3">
            <summary className="cursor-pointer">Configuration digest</summary>
            <code>{source.digest}</code>
          </details>
        )}
      </dl>
    </Card>
  );
}
function Actions({
  kind,
  id,
  managed,
  enabled,
  onUpdate,
  onRemoved,
}: {
  kind: CatalogKind;
  id: string;
  managed: boolean;
  enabled?: boolean;
  onUpdate: () => void;
  onRemoved: () => void;
}) {
  const me = useMe();
  const access = rights(me.data?.roles);
  const refresh = useRefreshLibrary();
  const toast = useToast();
  const [confirm, setConfirm] = useState(false);
  const action = useMutation({
    mutationFn: async (mode: 'remove' | 'toggle') => {
      if (mode === 'remove') await removeCatalogItem(kind, id);
      else if (enabled) await api.api.disablePack({ params: { id } });
      else await api.api.enablePack({ params: { id } });
    },
    onSuccess: async (_, mode) => {
      await refresh();
      toast.ok(
        mode === 'remove'
          ? `${kind === 'pack' ? 'Pack' : 'Agent'} removed`
          : enabled
            ? 'Pack disabled'
            : 'Pack enabled',
      );
      if (mode === 'remove') onRemoved();
    },
  });
  if (!managed)
    return (
      <p className="text-sm text-ink3">
        This {kind === 'pack' ? 'pack' : 'definition'} is provided by the server. Git management is
        unavailable for it.
      </p>
    );
  return (
    <div className="space-y-3">
      {access.manage ? (
        <div className="flex flex-wrap gap-2">
          <Button onClick={onUpdate} disabled={action.isPending}>
            Check for updates
          </Button>
          {kind === 'pack' && (
            <Button
              busy={action.isPending && action.variables === 'toggle'}
              onClick={() => action.mutate('toggle')}
            >
              {enabled ? 'Disable pack' : 'Enable pack'}
            </Button>
          )}
          <Button
            variant="danger"
            disabled={action.isPending}
            onClick={() => {
              action.reset();
              setConfirm(true);
            }}
          >
            Remove {kind}
          </Button>
        </div>
      ) : (
        <p className="text-sm text-ink3">
          An administrator can update, restore or remove this {kind}.
        </p>
      )}
      {confirm && (
        <Card className="border-bad/25 p-4">
          <p className="mt-0 text-sm">
            Remove this {kind} from the library? Future runs cannot select it. Active runs may
            prevent removal.
          </p>
          <div className="flex gap-2">
            <Button
              variant="danger"
              busy={action.isPending}
              onClick={() => action.mutate('remove')}
            >
              Confirm removal
            </Button>
            <Button disabled={action.isPending} onClick={() => setConfirm(false)}>
              Cancel removal
            </Button>
          </div>
        </Card>
      )}
      {action.isError && (
        <p role="alert" className="text-sm text-bad">
          {action.error.message}
        </p>
      )}
    </div>
  );
}
export function PackDetailPage() {
  const { packId } = useParams({ from: '/packs/$packId' });
  const query = usePack(packId);
  const [update, setUpdate] = useState(false);
  const navigate = useNavigate();
  const me = useMe();
  if (query.isError) return <LoadError error={query.error} retry={() => void query.refetch()} />;
  if (!query.data)
    return (
      <div className="p-7">
        <Skeleton className="h-48" />
      </div>
    );
  const pack = query.data;
  const managed = !!pack.links?.update;
  return (
    <div key={pack.id}>
      <div className="px-4 pt-5 text-sm md:px-7">
        <Link to="/packs" className="text-ink3 no-underline hover:text-ink">
          ← Packs
        </Link>
      </div>
      <PageHeader title={pack.name} sub={pack.description}>
        <Badge tone={pack.status === 'disabled' ? 'warn' : 'ok'}>{pack.status}</Badge>
        <Badge>{pack.trust ?? 'Trust not reported'}</Badge>
      </PageHeader>
      <div className="grid gap-5 px-4 pb-8 md:px-7 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-5">
          <div className="flex items-center gap-3 text-sm">
            <code>v{pack.version}</code>
            {pack.engine.compatible ? (
              <Badge tone="ok">Compatible</Badge>
            ) : (
              <Badge tone="bad">Requires {pack.engine.requires}</Badge>
            )}
          </div>
          <Actions
            kind="pack"
            id={pack.id}
            managed={managed}
            enabled={pack.status !== 'disabled'}
            onUpdate={() => setUpdate(true)}
            onRemoved={() => void navigate({ to: '/packs' })}
          />
          {update && (
            <GitReview
              key={pack.id}
              kind="pack"
              updateId={pack.id}
              initial={{ url: pack.source.url, ref: pack.source.ref, path: pack.source.path ?? '' }}
              onCancel={() => setUpdate(false)}
              onDone={() => setUpdate(false)}
            />
          )}
          <TeamPanel pack={pack} />
          <Card className="p-4">
            <h2 className="mb-3 font-serif text-xl font-normal">Declared access</h2>
            <Permissions permissions={pack.permissions} />
          </Card>
        </div>
        <aside className="min-w-0 space-y-5">
          <SourceFacts source={pack.source} />
          {managed && (
            <VersionHistory kind="pack" id={pack.id} canManage={rights(me.data?.roles).manage} />
          )}
          <Card className="p-4 text-sm text-ink2">
            Disabling a pack prevents new runs. Existing runs keep the version they started with.
          </Card>
        </aside>
      </div>
    </div>
  );
}
export function AgentDetailPage() {
  const { definitionId } = useParams({ from: '/agents/$definitionId' });
  const query = useLibraryAgent(definitionId);
  const [update, setUpdate] = useState(false);
  const navigate = useNavigate();
  const me = useMe();
  if (query.isError) return <LoadError error={query.error} retry={() => void query.refetch()} />;
  if (!query.data)
    return (
      <div className="p-7">
        <Skeleton className="h-48" />
      </div>
    );
  const agent = query.data;
  const managed = agent.source.type === 'git';
  return (
    <div key={agent.id}>
      <div className="px-4 pt-5 text-sm md:px-7">
        <Link to="/agents" className="text-ink3 no-underline hover:text-ink">
          ← Agents
        </Link>
      </div>
      <PageHeader title={agent.name} sub={agent.description}>
        <RoleChip role={agent.role} />
        <Badge>{managed ? 'Git installed' : agent.source.type}</Badge>
      </PageHeader>
      <div className="grid gap-5 px-4 pb-8 md:px-7 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-5">
          <dl className="grid gap-3 sm:grid-cols-3">
            <Fact label="Agent ID">
              <code>{agent.id}</code>
            </Fact>
            <Fact label="Backend">{agent.backend.wrapper}</Fact>
            <Fact label="Model">{agent.backend.model ?? 'Backend default'}</Fact>
          </dl>
          <Actions
            kind="agent"
            id={agent.id}
            managed={managed}
            onUpdate={() => setUpdate(true)}
            onRemoved={() => void navigate({ to: '/agents' })}
          />
          {update && (
            <GitReview
              key={agent.id}
              kind="agent"
              updateId={agent.id}
              initial={{
                url: agent.source.url ?? '',
                ref: agent.source.ref ?? 'HEAD',
                path: agent.source.path ?? '',
                id: agent.id,
                secrets: agent.backend.secrets ?? {},
              }}
              onCancel={() => setUpdate(false)}
              onDone={() => setUpdate(false)}
            />
          )}
          <Card className="p-4">
            <h2 className="mb-3 font-serif text-xl font-normal">Capabilities and tools</h2>
            <div className="flex flex-wrap gap-2">
              {agent.capabilities.map((c) => (
                <Badge key={c}>{c}</Badge>
              ))}
            </div>
            <h3 className="mt-4 mb-2 text-sm font-medium">MCP servers</h3>
            <p className="m-0 text-sm text-ink2">
              {agent.mcpServers.length ? agent.mcpServers.join(', ') : 'None declared'}
            </p>
            <h3 className="mt-4 mb-2 text-sm font-medium">Secret references</h3>
            {Object.entries(agent.backend.secrets ?? {}).length ? (
              <dl className="space-y-1 text-xs">
                {Object.entries(agent.backend.secrets ?? {}).map(([name, ref]) => (
                  <div key={name} className="flex flex-wrap gap-2">
                    <dt className="font-mono text-ink3">{name}</dt>
                    <dd className="m-0 font-mono">{ref}</dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p className="text-sm text-ink3">None declared</p>
            )}
          </Card>
        </div>
        <aside className="min-w-0 space-y-5">
          <SourceFacts source={agent.source} />
          {managed && (
            <VersionHistory kind="agent" id={agent.id} canManage={rights(me.data?.roles).manage} />
          )}
          <Card className="p-4 text-sm text-ink2">
            Registration keeps a reusable configuration. It does not start an agent or confirm that
            its backend is installed and signed in.
          </Card>
        </aside>
      </div>
    </div>
  );
}
