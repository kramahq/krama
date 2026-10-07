import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import type { Phase, Run } from '@kramahq/contract';
import {
  AlertOctagon,
  ArrowLeft,
  CheckCircle2,
  Circle,
  CircleDot,
  Loader2,
  MinusCircle,
  OctagonX,
  Pause,
  PauseCircle,
  Play,
  RefreshCw,
  ShieldCheck,
  Square,
  TriangleAlert,
  XCircle,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { ApiError } from '@kramahq/sdk';
import {
  useAllowedBackends,
  usePack,
  useProjects,
  useRun,
  useRunAction,
  useRunDecisions,
} from '@/api/queries';
import { ActivityFeed } from '@/components/activity-feed';
import { RunStatusBadge } from '@/components/run-bits';
import { TeamPanel } from '@/components/team-panel';
import { RichText } from '@/components/text';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Fact,
  Gauge,
  RoleChip,
  Skeleton,
} from '@/components/ui/primitives';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/cn';
import { formatSpend, percentUsed, relativeTime } from '@/lib/format';
import { RUN_STATUS } from '@/lib/status';
import { LoadError } from './errors';

export type RunTab = 'overview' | 'activity' | 'artifacts' | 'workspace' | 'cost';
/** A reason from the platform or an agent, ended properly so it reads in a sentence. */
const sentence = (t: string): string => (/[.!?]$/.test(t.trim()) ? t.trim() : `${t.trim()}.`);

const TABS: { id: RunTab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'activity', label: 'Activity' },
  { id: 'artifacts', label: 'Artifacts' },
  { id: 'workspace', label: 'Workspace' },
  { id: 'cost', label: 'Cost' },
];

const PHASE_ICON: Record<Phase['status'], { icon: typeof Circle; cls: string; label: string }> = {
  completed: { icon: CheckCircle2, cls: 'text-ok', label: 'Done' },
  active: { icon: Loader2, cls: 'text-info animate-spin', label: 'Working' },
  looping: { icon: RefreshCw, cls: 'text-info', label: 'Another round' },
  awaiting_decision: { icon: CircleDot, cls: 'text-warn', label: 'Waiting for you' },
  failed: { icon: XCircle, cls: 'text-bad', label: 'Failed' },
  pending: { icon: Circle, cls: 'text-ink3', label: 'Not started' },
  skipped: { icon: MinusCircle, cls: 'text-ink3', label: 'Skipped' },
};

function PhaseList({ phases, runStatus }: { phases: readonly Phase[]; runStatus: Run['status'] }) {
  // A phase that was working is not working while the whole run is stopped or waiting.
  const stalled = !['running', 'planning'].includes(runStatus);
  return (
    <ol className="m-0 flex list-none flex-col p-0">
      {phases.map((p, i) => {
        const working = p.status === 'active' || p.status === 'looping';
        const s =
          working && stalled
            ? {
                icon: PauseCircle,
                cls: 'text-warn',
                label:
                  runStatus === 'interrupted'
                    ? 'Interrupted here'
                    : `Stopped here (${RUN_STATUS[runStatus].label.toLowerCase()})`,
              }
            : PHASE_ICON[p.status];
        return (
          <li key={p.id} className="relative flex gap-3 pb-5 last:pb-0">
            {i < phases.length - 1 && (
              <span className="absolute top-6 bottom-0 left-[9px] w-px bg-line2" aria-hidden />
            )}
            <s.icon
              className={cn('relative mt-0.5 size-5 shrink-0 bg-raised', s.cls)}
              aria-label={s.label}
            />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="font-medium">{p.label}</span>
                <span className="text-xs text-ink3">{s.label}</span>
                {p.iteration > 1 && <Badge tone="info">round {p.iteration}</Badge>}
                <span className="ml-auto font-mono text-xs text-ink3">
                  {p.status === 'pending' || p.cost === undefined ? '' : formatSpend(p.cost)}
                </span>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                {p.agentRoles.map((r) => (
                  <RoleChip key={r} role={r} />
                ))}
              </div>
              {p.outcome && (
                <div className="mt-1.5 text-sm text-ink2">
                  <span className="font-medium text-ink">{p.outcome.status}</span> ·{' '}
                  {p.outcome.reason}
                  {p.outcome.feedback && (
                    <div className="prose-lite mt-1 text-xs text-ink3">
                      Feedback: {p.outcome.feedback}
                    </div>
                  )}
                </div>
              )}
              {p.outcome?.findings?.map((f, fi) => (
                <div key={fi} className="mt-1.5 flex items-start gap-2 text-sm">
                  <Badge
                    tone={
                      f.severity === 'blocker' ? 'bad' : f.severity === 'major' ? 'warn' : 'neutral'
                    }
                  >
                    {f.severity}
                  </Badge>
                  <span>
                    {f.title}
                    {f.detail && <span className="text-ink2"> — {f.detail}</span>}
                  </span>
                </div>
              ))}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** What the platform enforces on this run, whatever the orchestrator does. Only things the API actually tells us. */
function Guardrails({ run }: { run: Run }) {
  const allowed = useAllowedBackends();
  const backends = (allowed.data?.items ?? [])
    .filter((b) => b.allowed)
    .map((b) => b.wrapper.replace(/^a2a-/, ''));
  const chip = (icon: ReactNode, text: string, key: string) => (
    <span
      key={key}
      className="inline-flex items-center gap-1.5 rounded-full border border-line2 bg-panel px-2.5 py-1 text-xs text-ink2"
    >
      {icon}
      {text}
    </span>
  );
  const ic = <ShieldCheck className="size-3.5 text-ink3" aria-hidden />;
  return (
    <div
      className="flex flex-wrap items-center gap-1.5"
      aria-label="Guardrails enforced by the platform"
    >
      <span className="mr-1 text-[11px] tracking-wide text-ink3 uppercase">
        Enforced by the platform
      </span>
      {chip(
        ic,
        `Budget cap $${run.budget.max.amount} · ${run.budget.onExceed === 'pause' ? 'pauses' : 'stops'} when reached`,
        'cap',
      )}
      {chip(
        ic,
        run.mode === 'review'
          ? 'Review mode: a person approves before it completes'
          : 'Autopilot: no final approval',
        'mode',
      )}
      {backends.length > 0 && chip(ic, `Allowed backends: ${backends.join(', ')}`, 'be')}
    </div>
  );
}

function Banner({
  tone,
  icon,
  title,
  children,
  action,
}: {
  tone: 'warn' | 'bad' | 'info';
  icon: ReactNode;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  const cls = {
    warn: 'border-warn/35 bg-warn/10',
    bad: 'border-bad/35 bg-bad/8',
    info: 'border-info/30 bg-info/8',
  }[tone];
  return (
    <div
      role="status"
      className={cn(
        'mx-4 mb-4 flex flex-wrap items-start gap-3 rounded-card border p-3.5 md:mx-7',
        cls,
      )}
    >
      <span className="mt-0.5 shrink-0">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="font-medium">{title}</div>
        {children && <div className="mt-0.5 text-sm text-ink2">{children}</div>}
      </div>
      {action}
    </div>
  );
}

function Actions({ run }: { run: Run }) {
  const pause = useRunAction('pause');
  const resume = useRunAction('resume');
  const stop = useRunAction('stop');
  const toast = useToast();
  const [confirmStop, setConfirmStop] = useState(false);
  const fail = (what: string) => (e: Error) =>
    toast.error(`Could not ${what}`, e instanceof ApiError ? e.message : e.message);
  const canPause = run.status === 'running' || run.status === 'planning';
  // An interrupted run has its own banner with Resume, so it is not offered twice.
  const canResume = ['paused', 'blocked'].includes(run.status);
  const live = RUN_STATUS[run.status].active;
  return (
    <div className="flex items-center gap-2">
      {canPause && (
        <Button
          busy={pause.isPending}
          onClick={() => pause.mutate(run.id, { onError: fail('pause') })}
        >
          <Pause className="size-4" aria-hidden /> Pause
        </Button>
      )}
      {canResume && (
        <Button
          variant="primary"
          busy={resume.isPending}
          onClick={() => resume.mutate(run.id, { onError: fail('resume') })}
        >
          <Play className="size-4" aria-hidden /> Resume
        </Button>
      )}
      {live &&
        (confirmStop ? (
          <>
            <span className="text-sm text-ink2">Stop for good?</span>
            <Button
              variant="danger"
              busy={stop.isPending}
              onClick={() =>
                stop.mutate(run.id, {
                  onError: fail('stop'),
                  onSettled: () => setConfirmStop(false),
                })
              }
            >
              Stop run
            </Button>
            <Button variant="ghost" onClick={() => setConfirmStop(false)}>
              Keep going
            </Button>
          </>
        ) : (
          <Button variant="ghost" onClick={() => setConfirmStop(true)}>
            <Square className="size-3.5" aria-hidden /> Stop
          </Button>
        ))}
    </div>
  );
}

function Overview({ run }: { run: Run }) {
  const pack = usePack(run.pack.id);
  const pending = useRunDecisions(run.id);
  const ds = pending.data?.items ?? [];
  return (
    <div className="grid gap-5 px-4 pb-8 md:px-7 lg:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
      <div className="flex min-w-0 flex-col gap-5">
        {ds.length > 0 && (
          <Card className="border-warn/40 bg-warn/8 p-4">
            <div className="mb-2 flex items-center gap-2 font-medium">
              <CircleDot className="size-4 text-warn" aria-hidden />{' '}
              {ds.length === 1
                ? 'This run is waiting for you'
                : `${ds.length} questions are waiting for you`}
            </div>
            <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
              {ds.map((d) => (
                <li key={d.id}>
                  <Link
                    to="/inbox"
                    search={{ id: d.id }}
                    className="text-sm font-medium text-ink underline decoration-line2 underline-offset-2"
                  >
                    {d.title}
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        )}
        {run.summary && (
          <Card className="p-4">
            <div className="mb-1 text-[11px] tracking-wide text-ink3 uppercase">
              What the orchestrator says
            </div>
            <RichText text={run.summary} className="text-[15px] leading-relaxed" />
          </Card>
        )}
        <Card className="p-4">
          <div className="mb-3 text-[11px] tracking-wide text-ink3 uppercase">Phases</div>
          {run.phases?.length ? (
            <PhaseList phases={run.phases} runStatus={run.status} />
          ) : (
            <div className="text-sm text-ink3">
              The orchestrator has not planned any phases yet. They appear here as it declares them.
            </div>
          )}
        </Card>
      </div>
      <div className="flex min-w-0 flex-col gap-5">
        <TeamPanel pack={pack.data} run={run} />
        <Card className="p-4">
          <div className="mb-2 text-[11px] tracking-wide text-ink3 uppercase">Request</div>
          <RichText text={run.input.text ?? 'No request text.'} className="text-sm" />
        </Card>
      </div>
    </div>
  );
}

function Later({ title, children }: { title: string; children: string }) {
  return (
    <EmptyState title={title} icon={<Loader2 className="size-8" aria-hidden />}>
      {children}
    </EmptyState>
  );
}

export function RunDetailPage() {
  const { runId } = useParams({ from: '/runs/$runId' });
  const { tab: tabParam } = useSearch({ from: '/runs/$runId' });
  const navigate = useNavigate({ from: '/runs/$runId' });
  const run = useRun(runId);
  const pack = usePack(run.data?.pack.id);
  const projects = useProjects();
  const resume = useRunAction('resume');
  const toast = useToast();
  const tab = tabParam ?? 'overview';

  if (run.isLoading)
    return (
      <div className="flex flex-col gap-4 p-7">
        <Skeleton className="h-8 w-80" />
        <Skeleton className="h-5 w-[28rem]" />
        <Skeleton className="h-40" />
      </div>
    );
  if (run.isError) return <LoadError error={run.error} retry={() => void run.refetch()} />;
  const r = run.data!;
  const project = projects.data?.items.find((p) => p.id === r.projectId);
  const pct = percentUsed(r.budget.max, r.budget.spent);

  return (
    <div className="flex min-h-full flex-col">
      <div className="px-4 pt-5 md:px-7">
        <Link
          to="/runs"
          className="inline-flex items-center gap-1.5 text-sm text-ink2 no-underline hover:text-ink"
        >
          <ArrowLeft className="size-4" aria-hidden /> Runs
        </Link>
      </div>
      <div className="flex flex-wrap items-start gap-x-6 gap-y-3 px-4 pt-2 pb-3 md:px-7">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="m-0 font-serif text-[30px] leading-tight font-normal">{r.title}</h1>
            <RunStatusBadge status={r.status} />
            <Badge>{r.mode === 'review' ? 'Review mode' : 'Autopilot'}</Badge>
          </div>
          <dl className="m-0 mt-3 grid max-w-3xl grid-cols-2 gap-x-6 gap-y-2.5 sm:grid-cols-4">
            <Fact label="Pack">
              {pack.data ? `${pack.data.name} ${r.pack.version}` : r.pack.version}
            </Fact>
            <Fact label="Project">{project?.name ?? '—'}</Fact>
            <Fact label="Started by">{r.createdBy.name ?? r.createdBy.id}</Fact>
            <Fact label="Updated">{relativeTime(r.updatedAt)}</Fact>
          </dl>
        </div>
        <div className="flex w-full flex-col gap-3 sm:w-72">
          <div className="flex flex-col gap-1.5">
            <div className="flex items-baseline justify-between text-sm">
              <span className="font-mono">{formatSpend(r.budget.spent)}</span>
              <span className="text-xs text-ink3">
                of ${r.budget.max.amount} cap{pct !== undefined && ` · ${pct}%`}
              </span>
            </div>
            <Gauge percent={pct} label="Budget used" />
          </div>
          <Actions run={r} />
        </div>
      </div>

      <div className="px-4 pb-4 md:px-7">
        <Guardrails run={r} />
      </div>

      {r.status === 'interrupted' && (
        <Banner
          tone="warn"
          icon={<TriangleAlert className="size-5 text-warn" aria-hidden />}
          title="This run was interrupted"
          action={
            <Button
              variant="primary"
              busy={resume.isPending}
              onClick={() =>
                resume.mutate(r.id, { onError: (e) => toast.error('Could not resume', e.message) })
              }
            >
              <Play className="size-4" aria-hidden /> Resume
            </Button>
          }
        >
          {sentence(r.statusReason ?? 'It stopped before it finished')} Nothing already done is
          repeated.
        </Banner>
      )}
      {r.status === 'blocked' && (
        <Banner
          tone="bad"
          icon={<OctagonX className="size-5 text-bad" aria-hidden />}
          title="This run is blocked"
        >
          {sentence(r.statusReason ?? 'It cannot continue')} Fix the cause, then resume.
        </Banner>
      )}
      {r.status === 'failed' && (
        <Banner
          tone="bad"
          icon={<AlertOctagon className="size-5 text-bad" aria-hidden />}
          title="This run failed"
        >
          {sentence(r.statusReason ?? 'No reason was recorded')}
        </Banner>
      )}

      <div
        role="tablist"
        aria-label="Run"
        className="flex gap-1 overflow-x-auto border-b border-line px-4 md:px-7"
      >
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls="tabpanel"
            onClick={() =>
              void navigate({
                search: { tab: t.id === 'overview' ? undefined : t.id },
                replace: true,
              })
            }
            className={cn(
              '-mb-px border-b-2 px-3 py-2.5 text-sm font-medium whitespace-nowrap transition-colors',
              tab === t.id ? 'border-ink text-ink' : 'border-transparent text-ink2 hover:text-ink',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div id="tabpanel" role="tabpanel" aria-labelledby={`tab-${tab}`} className="flex-1 pt-5">
        {tab === 'overview' && <Overview run={r} />}
        {tab === 'activity' && <ActivityFeed runId={r.id} />}
        {tab === 'artifacts' && (
          <Later title="Artifacts">
            Documents, code, diffs, images and media this run produced, with their version chain.
            Next in this preview.
          </Later>
        )}
        {tab === 'workspace' && (
          <Later title="Workspace">
            The files the agents are working on: tree, file viewer, git status and diff. Next in
            this preview.
          </Later>
        )}
        {tab === 'cost' && (
          <Later title="Cost">
            Spend by phase, agent, backend and tool, in the unit each provider reports, with
            &quot;not reported&quot; shown plainly. Next in this preview.
          </Later>
        )}
      </div>
    </div>
  );
}
