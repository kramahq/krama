import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import type { Run } from '@kramahq/contract';
import { Play, Search } from 'lucide-react';
import { useMemo } from 'react';
import { usePacks, useRuns } from '@/api/queries';
import { ALL_PROJECTS, useProject } from '@/app/project';
import { PhaseBar, RunStatusBadge } from '@/components/run-bits';
import {
  Button,
  EmptyState,
  Gauge,
  PageHeader,
  Segmented,
  Skeleton,
} from '@/components/ui/primitives';
import { formatSpend, percentUsed, relativeTime } from '@/lib/format';
import { RUN_STATUS } from '@/lib/status';
import { LoadError } from './errors';

type View = 'all' | 'active' | 'needs-you' | 'done' | 'failed';
const NEEDS_YOU: Run['status'][] = ['awaiting_decision', 'blocked', 'interrupted'];

const inView = (r: Run, v: View): boolean =>
  v === 'all' ||
  (v === 'active' && RUN_STATUS[r.status].active) ||
  (v === 'needs-you' && NEEDS_YOU.includes(r.status)) ||
  (v === 'done' && (r.status === 'completed' || r.status === 'stopped')) ||
  (v === 'failed' && r.status === 'failed');

function RunRow({ run, pack, project }: { run: Run; pack: string; project: string | undefined }) {
  const pct = percentUsed(run.budget.max, run.budget.spent);
  return (
    <Link
      to="/runs/$runId"
      params={{ runId: run.id }}
      className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-2 border-b border-line px-4 py-3.5 no-underline transition-colors hover:bg-hover md:grid-cols-[minmax(0,2.4fr)_150px_minmax(0,1.3fr)_180px_90px] md:items-center md:px-7"
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium text-ink">{run.title}</span>
          {run.workItem?.ref && (
            <span className="font-mono text-[11px] text-ink3">{run.workItem.ref}</span>
          )}
        </div>
        <div className="mt-0.5 truncate text-xs text-ink3">
          {pack}
          {project && ` · ${project}`}
          {run.mode === 'review' ? ' · review mode' : ' · autopilot'}
        </div>
      </div>
      <div className="justify-self-end md:justify-self-start">
        <RunStatusBadge status={run.status} />
      </div>
      <PhaseBar phases={run.phases} className="col-span-2 md:col-span-1" />
      <div className="col-span-2 flex flex-col gap-1 md:col-span-1">
        <div className="flex items-baseline justify-between text-xs">
          <span className="font-mono text-ink2">{formatSpend(run.budget.spent)}</span>
          <span className="text-ink3">of ${run.budget.max.amount}</span>
        </div>
        <Gauge percent={pct} label="Budget used" />
      </div>
      <div className="hidden text-right text-xs text-ink3 md:block">
        {relativeTime(run.updatedAt)}
      </div>
    </Link>
  );
}

export function RunsPage() {
  const { view: viewParam, q } = useSearch({ from: '/runs' });
  const navigate = useNavigate({ from: '/runs' });
  const { selected, projects } = useProject();
  const runs = useRuns(selected === ALL_PROJECTS ? undefined : { project: selected });
  const packs = usePacks();

  const view =
    (['all', 'active', 'needs-you', 'done', 'failed'] as const).find((v) => v === viewParam) ??
    'all';
  const packName = useMemo(
    () => new Map((packs.data?.items ?? []).map((p) => [p.id, p.name])),
    [packs.data],
  );
  const projectName = useMemo(() => new Map(projects.map((p) => [p.id, p.name])), [projects]);

  const all = runs.data?.items ?? [];
  const text = (q ?? '').trim().toLowerCase();
  const matches = (r: Run) =>
    !text ||
    r.title.toLowerCase().includes(text) ||
    (r.workItem?.ref ?? '').toLowerCase().includes(text);
  const visible = all.filter((r) => inView(r, view) && matches(r));
  const count = (v: View) => all.filter((r) => inView(r, v) && matches(r)).length;

  if (runs.isError) return <LoadError error={runs.error} retry={() => void runs.refetch()} />;

  const needs = all.filter((r) => NEEDS_YOU.includes(r.status)).length;
  return (
    <div className="flex min-h-full flex-col">
      <PageHeader
        title="Runs"
        sub={
          runs.isLoading
            ? 'Loading…'
            : `${all.filter((r) => RUN_STATUS[r.status].active).length} active${needs ? ` · ${needs} need you` : ''}`
        }
      />

      <div className="flex flex-wrap items-center gap-3 px-4 pb-3.5 md:px-7">
        <Segmented<View>
          label="Show"
          value={view}
          onChange={(v) =>
            void navigate({ search: (p) => ({ ...p, view: v === 'all' ? undefined : v }) })
          }
          options={[
            { value: 'all', label: 'All', count: count('all') },
            { value: 'active', label: 'Active', count: count('active') },
            { value: 'needs-you', label: 'Needs you', count: count('needs-you') },
            { value: 'done', label: 'Done', count: count('done') },
            { value: 'failed', label: 'Failed', count: count('failed') },
          ]}
        />
        <label className="relative ml-auto w-full max-w-xs md:w-64">
          <span className="sr-only">Search runs</span>
          <Search
            className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-ink3"
            aria-hidden
          />
          <input
            type="search"
            value={q ?? ''}
            onChange={(e) =>
              void navigate({
                search: (p) => ({ ...p, q: e.target.value || undefined }),
                replace: true,
              })
            }
            placeholder="Search title or ticket"
            className="h-9 w-full rounded-lg border border-line2 bg-raised pr-3 pl-8 text-sm"
          />
        </label>
      </div>

      <div className="hidden grid-cols-[minmax(0,2.4fr)_150px_minmax(0,1.3fr)_180px_90px] gap-x-4 border-y border-line bg-panel px-7 py-2 text-[11px] tracking-wide text-ink3 uppercase md:grid">
        <span>Run</span>
        <span>Status</span>
        <span>Progress</span>
        <span>Spend</span>
        <span className="text-right">Updated</span>
      </div>

      <div className="flex-1 border-t border-line bg-raised md:border-t-0">
        {runs.isLoading ? (
          <div className="flex flex-col gap-3 p-5">
            {[0, 1, 2, 3, 4].map((n) => (
              <Skeleton key={n} className="h-14" />
            ))}
          </div>
        ) : visible.length === 0 ? (
          <EmptyState
            icon={<Play className="size-8" aria-hidden />}
            title={all.length === 0 ? 'No runs yet' : 'No runs match'}
            action={
              all.length === 0 ? (
                <Link to="/runs/new" className="no-underline">
                  <Button variant="primary">Start your first run</Button>
                </Link>
              ) : undefined
            }
          >
            {all.length === 0
              ? 'A run is a piece of work you hand to a team of agents.'
              : 'Try another view, or clear the search.'}
          </EmptyState>
        ) : (
          visible.map((r) => (
            <RunRow
              key={r.id}
              run={r}
              pack={packName.get(r.pack.id) ?? r.pack.id}
              project={r.projectId ? projectName.get(r.projectId) : undefined}
            />
          ))
        )}
      </div>
    </div>
  );
}
