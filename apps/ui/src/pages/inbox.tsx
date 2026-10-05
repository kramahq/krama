import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import type { Decision, DecisionKind, Run } from '@kramahq/contract';
import { ApiError } from '@kramahq/sdk';
import { ArrowLeft, CheckCheck, Clock, FolderLock, Users } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { api } from '@/api/client';
import { keys, useDecisions, useMe, useResolveDecision, useRuns } from '@/api/queries';
import { ALL_PROJECTS, useProject } from '@/app/project';
import { KindIcon } from '@/components/decision-kind';
import { RichText } from '@/components/text';
import {
  Badge,
  Button,
  Card,
  Chip,
  EmptyState,
  PageHeader,
  Skeleton,
} from '@/components/ui/primitives';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/cn';
import { pluralise, relativeTime } from '@/lib/format';
import { DECISION_KIND, KIND_ORDER } from '@/lib/status';
import { LoadError } from './errors';

const BLOCKING: Run['status'][] = ['awaiting_decision'];

interface Item {
  decision: Decision;
  run: Run | undefined;
  /** A run is stopped until a person answers. */
  blocking: boolean;
}

/** Run-blocking first, then the ones that expire soonest, then newest. */
export function sortInbox(items: Item[]): Item[] {
  return [...items].sort((a, b) => {
    if (a.blocking !== b.blocking) return a.blocking ? -1 : 1;
    const da = a.decision.deadline ? Date.parse(a.decision.deadline) : Infinity;
    const db = b.decision.deadline ? Date.parse(b.decision.deadline) : Infinity;
    if (da !== db) return da - db;
    return Date.parse(b.decision.createdAt) - Date.parse(a.decision.createdAt);
  });
}

function deadlineLabel(d: Decision): { text: string; urgent: boolean } | undefined {
  if (!d.deadline) return undefined;
  const ms = Date.parse(d.deadline) - Date.now();
  if (ms <= 0) return { text: 'expired', urgent: true };
  return { text: `${relativeTime(d.deadline)}`, urgent: ms < 2 * 3_600_000 };
}

function Row({ item, active }: { item: Item; active: boolean }) {
  const { decision: d, run } = item;
  const dl = deadlineLabel(d);
  const need = d.need > 1 ? `${d.approvals?.length ?? 0}/${d.need}` : undefined;
  return (
    <Link
      to="/inbox"
      search={(prev) => ({ ...prev, id: d.id })}
      aria-current={active ? 'true' : undefined}
      className={cn(
        'flex flex-col gap-1.5 border-b border-line px-4 py-3 no-underline transition-colors',
        active ? 'bg-raised shadow-[inset_3px_0_0_var(--ink)]' : 'hover:bg-hover',
      )}
    >
      <div className="flex items-center gap-2 text-xs text-ink3">
        <KindIcon kind={d.kind} className="size-3.5" />
        <span className="font-medium text-ink2">{DECISION_KIND[d.kind].label}</span>
        {item.blocking && (
          <Badge tone="warn" dot>
            Blocks run
          </Badge>
        )}
        <span className="ml-auto">{relativeTime(d.createdAt)}</span>
      </div>
      <div className="line-clamp-2 text-sm font-medium text-ink">{d.title}</div>
      <div className="flex items-center gap-2 text-xs text-ink3">
        <span className="min-w-0 flex-1 truncate">
          {run?.title ?? (d.runId ? 'Run' : 'Not tied to a run')}
        </span>
        {need && (
          <span className="inline-flex items-center gap-1" title="Approvals so far / needed">
            <Users className="size-3" aria-hidden />
            {need}
          </span>
        )}
        {dl && (
          <span className={cn('inline-flex items-center gap-1', dl.urgent && 'text-warn')}>
            <Clock className="size-3" aria-hidden />
            {dl.text}
          </span>
        )}
      </div>
    </Link>
  );
}

const SEVERITY = { info: 'neutral', minor: 'info', major: 'warn', blocker: 'bad' } as const;

// Rendered with `key={decision.id}` by the page, so choosing another decision starts with a clean form.
function Detail({ decision: d, run }: { decision: Decision; run: Run | undefined }) {
  const me = useMe();
  const resolve = useResolveDecision();
  const toast = useToast();
  const [choice, setChoice] = useState<string | undefined>(undefined);
  const [note, setNote] = useState('');
  const pending = d.status === 'pending';
  const option = d.options.find((o) => o.id === choice);
  const mine = d.approvals?.some((a) => a.by.id === me.data?.id) ?? false;
  const approvals = d.approvals ?? [];
  const missing = Math.max(0, d.need - approvals.length);

  const needsNote = !!option?.input?.required && note.trim() === '';

  function confirm() {
    if (!option) return;
    resolve.mutate(
      {
        id: d.id,
        body: {
          optionId: option.id,
          ...(note.trim() ? { input: note.trim() } : {}),
          ...(d.kind === 'access' && option.id.includes('project')
            ? { scope: 'project' as const }
            : {}),
          ...(d.kind === 'access' && option.id.includes('once') ? { scope: 'once' as const } : {}),
        },
      },
      {
        onSuccess: () => toast.ok(`${option.label}`, option.effect),
        onError: (e) =>
          toast.error(
            e instanceof ApiError && e.code === 'decision_resolved'
              ? 'Someone already resolved this'
              : 'Could not save your answer',
            e.message,
          ),
      },
    );
  }

  const dl = deadlineLabel(d);
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-5 px-4 py-6 md:px-8">
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2 text-xs text-ink3">
          <Badge>
            <KindIcon kind={d.kind} className="size-3" />
            {DECISION_KIND[d.kind].label}
          </Badge>
          {!pending && <Badge tone={d.status === 'resolved' ? 'ok' : 'neutral'}>{d.status}</Badge>}
          <span>{relativeTime(d.createdAt)}</span>
          {dl && pending && (
            <span className={cn(dl.urgent && 'font-medium text-warn')}>
              · {d.onTimeout === 'expire' ? 'expires' : 'due'} {dl.text}
            </span>
          )}
        </div>
        <h2 className="m-0 font-serif text-[28px] leading-tight font-normal">{d.title}</h2>
        {run && (
          <div className="text-sm text-ink2">
            In{' '}
            <Link
              to="/runs/$runId"
              params={{ runId: run.id }}
              className="font-medium text-ink underline decoration-line2 underline-offset-2"
            >
              {run.title}
            </Link>
            {d.phaseId && <span className="text-ink3"> · {d.phaseId}</span>}
          </div>
        )}
      </div>

      <RichText text={d.question} className="text-[15px] leading-relaxed" />

      {d.access && (
        <Card className="flex items-start gap-3 p-4">
          <FolderLock className="mt-0.5 size-5 shrink-0 text-ink3" aria-hidden />
          <dl className="m-0 grid min-w-0 flex-1 grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-ink3">Path</dt>
            <dd className="m-0 font-mono break-all">{d.access.path}</dd>
            <dt className="text-ink3">Agent</dt>
            <dd className="m-0">{d.access.agent}</dd>
            {d.access.mode && (
              <>
                <dt className="text-ink3">Wants to</dt>
                <dd className="m-0">{d.access.mode === 'write' ? 'change this' : 'read this'}</dd>
              </>
            )}
          </dl>
        </Card>
      )}

      {d.context?.summary && (
        <Card className="bg-panel p-4">
          <div className="mb-1 text-[11px] tracking-wide text-ink3 uppercase">Summary</div>
          <RichText text={d.context.summary} className="text-sm" />
        </Card>
      )}

      {!!d.context?.findings?.length && (
        <div className="flex flex-col gap-2">
          <div className="text-[11px] tracking-wide text-ink3 uppercase">
            {pluralise(d.context.findings.length, 'finding')}
          </div>
          {d.context.findings.map((f, i) => (
            <Card key={i} className="flex items-start gap-3 p-3">
              <Badge tone={SEVERITY[f.severity]}>{f.severity}</Badge>
              <div className="min-w-0 text-sm">
                <div className="font-medium">{f.title}</div>
                {f.detail && <div className="mt-0.5 text-ink2">{f.detail}</div>}
              </div>
            </Card>
          ))}
        </div>
      )}

      {!!d.context?.artifacts?.length && run && (
        <div className="text-sm text-ink2">
          Attached: {pluralise(d.context.artifacts.length, 'artifact')} ·{' '}
          <Link
            to="/runs/$runId"
            params={{ runId: run.id }}
            search={{ tab: 'artifacts' }}
            className="text-ink underline decoration-line2 underline-offset-2"
          >
            open in the run
          </Link>
        </div>
      )}

      {d.need > 1 && (
        <Card className="flex flex-col gap-2 p-4">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Users className="size-4 text-ink3" aria-hidden />
            {approvals.length} of {d.need} approvals
          </div>
          <ul className="m-0 flex list-none flex-col gap-1 p-0 text-sm">
            {approvals.map((a, i) => (
              <li key={i} className="flex items-center gap-2 text-ink2">
                <CheckCheck className="size-4 text-ok" aria-hidden />
                {a.by.name ?? a.by.id} chose{' '}
                <span className="font-medium text-ink">
                  {d.options.find((o) => o.id === a.optionId)?.label ?? a.optionId}
                </span>
                <span className="text-ink3">{relativeTime(a.at)}</span>
              </li>
            ))}
            {pending && missing > 0 && (
              <li className="text-ink3">Waiting for {pluralise(missing, 'more approver')}</li>
            )}
          </ul>
        </Card>
      )}

      {pending ? (
        mine ? (
          <Card className="bg-panel p-4 text-sm text-ink2">
            You already answered this. It stays here until the other{' '}
            {pluralise(missing, 'approver')} {missing === 1 ? 'has' : 'have'} answered.
          </Card>
        ) : (
          <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
            <legend className="mb-1 text-[11px] tracking-wide text-ink3 uppercase">
              Your answer
            </legend>
            {d.options.map((o) => {
              const on = o.id === choice;
              return (
                <label
                  key={o.id}
                  className={cn(
                    'flex cursor-pointer items-start gap-3 rounded-card border bg-raised p-3 transition-colors',
                    on ? 'border-ink ring-1 ring-ink' : 'border-line2 hover:bg-hover',
                    o.style === 'danger' && on && 'border-bad ring-bad',
                  )}
                >
                  <input
                    type="radio"
                    name={`opt-${d.id}`}
                    checked={on}
                    onChange={() => setChoice(o.id)}
                    className="mt-1 accent-[var(--ink)]"
                  />
                  <span className="min-w-0 flex-1">
                    <span
                      className={cn(
                        'block text-sm font-medium',
                        o.style === 'danger' && 'text-bad',
                      )}
                    >
                      {o.label}
                    </span>
                    {o.effect && <span className="mt-0.5 block text-sm text-ink2">{o.effect}</span>}
                  </span>
                </label>
              );
            })}
            {option?.input && (
              <label className="mt-1 flex flex-col gap-1.5">
                <span className="text-sm font-medium">
                  {option.input.label}
                  {option.input.required && <span className="text-bad"> *</span>}
                </span>
                {option.input.kind === 'choice' && option.input.choices ? (
                  <select
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    className="h-9 rounded-lg border border-line2 bg-raised px-2.5"
                  >
                    <option value="">Choose…</option>
                    {option.input.choices.map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                  </select>
                ) : (
                  <textarea
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    rows={3}
                    className="rounded-lg border border-line2 bg-raised p-2.5 text-sm"
                    placeholder={
                      option.input.kind === 'markdown' ? 'You can use **bold** and lists' : ''
                    }
                  />
                )}
              </label>
            )}
            <div className="mt-2 flex items-center gap-3">
              <Button
                variant={option?.style === 'danger' ? 'danger' : 'primary'}
                disabled={!option || needsNote}
                busy={resolve.isPending}
                onClick={confirm}
              >
                {option ? `Confirm: ${option.label}` : 'Choose an answer'}
              </Button>
              {option?.effect && <span className="text-xs text-ink3">{option.effect}</span>}
            </div>
          </fieldset>
        )
      ) : (
        d.resolution && (
          <Card className="bg-panel p-4 text-sm">
            <span className="font-medium">
              {d.options.find((o) => o.id === d.resolution?.optionId)?.label ??
                d.resolution.optionId}
            </span>{' '}
            by {d.resolution.by.name ?? d.resolution.by.id} · {relativeTime(d.resolution.at)}
            {d.resolution.input && (
              <RichText text={d.resolution.input} className="mt-2 text-ink2" />
            )}
          </Card>
        )
      )}
    </div>
  );
}

export function InboxPage() {
  const search = useSearch({ from: '/inbox' });
  const navigate = useNavigate({ from: '/inbox' });
  const { selected: projectId } = useProject();
  const pending = useDecisions({ status: ['pending'] });
  const runs = useRuns();

  const byId = useMemo(() => new Map((runs.data?.items ?? []).map((r) => [r.id, r])), [runs.data]);
  const all: Item[] = useMemo(
    () =>
      (pending.data?.items ?? [])
        .map((decision) => {
          const run = decision.runId ? byId.get(decision.runId) : undefined;
          return { decision, run, blocking: !!run && BLOCKING.includes(run.status) };
        })
        // A project narrows what you see. Decisions that belong to no run (a pack to install) always show.
        .filter((i) => projectId === ALL_PROJECTS || !i.run || i.run.projectId === projectId),
    [pending.data, byId, projectId],
  );

  const counts = useMemo(() => {
    const c = new Map<DecisionKind, number>();
    for (const i of all) c.set(i.decision.kind, (c.get(i.decision.kind) ?? 0) + 1);
    return c;
  }, [all]);

  const kind = KIND_ORDER.find((k) => k === search.kind);
  const items = useMemo(
    () => sortInbox(all.filter((i) => !kind || i.decision.kind === kind)),
    [all, kind],
  );
  const blockingCount = all.filter((i) => i.blocking).length;

  const selectedItem = items.find((i) => i.decision.id === search.id);
  // A link can point at something already resolved; it is not in the pending list, so fetch it.
  const lone = useQuery({
    queryKey: keys.decisions({ status: ['one'], q: search.id }),
    queryFn: () => api.decisions.get(search.id!),
    enabled: !!search.id && !selectedItem && !pending.isLoading,
  });
  const detail: Item | undefined =
    selectedItem ??
    (lone.data
      ? {
          decision: lone.data,
          run: lone.data.runId ? byId.get(lone.data.runId) : undefined,
          blocking: false,
        }
      : undefined);

  // On a wide screen the first item is open by default; when the open one is answered, the next takes its place.
  useEffect(() => {
    if (pending.isLoading || search.id) return;
    const first = items[0];
    if (first && window.matchMedia('(min-width: 768px)').matches)
      void navigate({ search: (p) => ({ ...p, id: first.decision.id }), replace: true });
  }, [items, search.id, pending.isLoading, navigate]);

  if (pending.isError)
    return <LoadError error={pending.error} retry={() => void pending.refetch()} />;

  const sub = pending.isLoading
    ? 'Loading…'
    : all.length === 0
      ? 'Nothing is waiting for you'
      : `${all.length} waiting${blockingCount ? ` · ${blockingCount} ${blockingCount === 1 ? 'is' : 'are'} holding a run up` : ''}`;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader title="Inbox" sub={sub} />
      <div
        className="flex gap-1.5 overflow-x-auto px-4 pb-3 scroll-thin md:flex-wrap md:px-7"
        role="group"
        aria-label="Filter by kind"
      >
        <Chip
          active={!kind}
          count={all.length}
          onClick={() => void navigate({ search: (p) => ({ ...p, kind: undefined }) })}
        >
          All
        </Chip>
        {KIND_ORDER.filter((k) => counts.get(k)).map((k) => (
          <Chip
            key={k}
            active={kind === k}
            count={counts.get(k)}
            title={DECISION_KIND[k].hint}
            onClick={() => void navigate({ search: (p) => ({ ...p, kind: k }) })}
          >
            {DECISION_KIND[k].label}
          </Chip>
        ))}
      </div>

      <div className="grid min-h-0 flex-1 border-t border-line md:grid-cols-[380px_1fr]">
        <div
          className={cn(
            'min-h-0 overflow-y-auto border-r border-line bg-panel scroll-thin',
            search.id && 'hidden md:block',
          )}
        >
          {pending.isLoading ? (
            <div className="flex flex-col gap-3 p-4">
              {[0, 1, 2, 3].map((n) => (
                <Skeleton key={n} className="h-16" />
              ))}
            </div>
          ) : items.length === 0 ? (
            <EmptyState
              icon={<CheckCheck className="size-8" aria-hidden />}
              title={kind ? 'Nothing of this kind' : 'All clear'}
            >
              {kind
                ? 'Try another filter.'
                : 'When an agent needs you, it shows up here and the run waits for your answer.'}
            </EmptyState>
          ) : (
            <ul className="m-0 list-none p-0">
              {items.map((i) => (
                <li key={i.decision.id}>
                  <Row item={i} active={i.decision.id === search.id} />
                </li>
              ))}
            </ul>
          )}
        </div>

        <section
          className={cn('min-h-0 overflow-y-auto scroll-thin', !search.id && 'hidden md:block')}
          aria-label="Decision"
        >
          {search.id && (
            <div className="border-b border-line px-4 py-2 md:hidden">
              <Link
                to="/inbox"
                search={(p) => ({ ...p, id: undefined })}
                className="inline-flex items-center gap-1.5 text-sm text-ink2 no-underline"
              >
                <ArrowLeft className="size-4" aria-hidden /> Back to the list
              </Link>
            </div>
          )}
          {detail ? (
            <Detail key={detail.decision.id} decision={detail.decision} run={detail.run} />
          ) : lone.isError ? (
            <LoadError error={lone.error} />
          ) : (
            !pending.isLoading && (
              <EmptyState
                title={items.length ? 'Choose something from the list' : 'Nothing to show'}
              >
                {items.length
                  ? 'Each item says what is being asked and what every answer will do.'
                  : ''}
              </EmptyState>
            )
          )}
        </section>
      </div>
    </div>
  );
}
