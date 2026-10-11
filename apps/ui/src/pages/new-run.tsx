import { useNavigate } from '@tanstack/react-router';
import type { DelegationMode, Pack } from '@kramahq/contract';
import { Sparkles } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useCreateRun, usePacks } from '@/api/queries';
import { ALL_PROJECTS, useProject } from '@/app/project';
import { TeamPanel } from '@/components/team-panel';
import { PackInputs } from '@/components/pack-inputs';
import { BackendSetup } from '@/components/backend-setup';
import { Badge, Button, Card, PageHeader, Segmented, Skeleton } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/cn';
import { formatSpend } from '@/lib/format';
import { inputModel, readInputs, type InputDraft } from '@/lib/pack-inputs';

/** History only: what runs of this pack have cost, as the providers reported it. No history, nothing is shown. */
function typical(p: Pack): string | undefined {
  const s = p.stats;
  if (!s || s.runs === 0 || s.avgCost === null || s.avgCost === undefined) return undefined;
  return `${formatSpend(s.avgCost)} per run, across ${s.runs} ${s.runs === 1 ? 'run' : 'runs'}`;
}

export function NewRunPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const packs = usePacks();
  const create = useCreateRun();
  const { selected, projects } = useProject();

  const installed = useMemo(
    () =>
      (packs.data?.items ?? []).filter(
        (p) => p.status === 'installed' || p.status === 'update_available',
      ),
    [packs.data],
  );

  const [text, setText] = useState('');
  const [packId, setPackId] = useState<string | undefined>(undefined);
  // Until you pick one here, the project is the one chosen in the sidebar.
  const [chosenProject, setProjectId] = useState<string | undefined>(undefined);
  const projectId = chosenProject ?? (selected === ALL_PROJECTS ? '' : selected);
  const project = projects.find((p) => p.id === projectId);
  const suggestedId =
    installed.find((p) => p.id === project?.defaultPackId)?.id ?? installed[0]?.id;
  const [mode, setMode] = useState<'review' | 'autopilot'>('review');
  const [budget, setBudget] = useState<string>('');
  const [delegation, setDelegation] = useState<DelegationMode>('native');
  const [drafts, setDrafts] = useState<Record<string, InputDraft>>({});

  // Until you choose, the pack is the suggestion: the project's default.
  const chosenId = packId ?? suggestedId;
  const pack = installed.find((p) => p.id === chosenId);
  const graph = !!pack?.orchestrator && !!pack.agents;
  const effectiveDelegation = graph ? 'native' : delegation;
  const inputKey = pack ? `${pack.id}@${pack.version}` : '';
  const model = useMemo(() => inputModel(pack?.inputsSchema ?? {}), [pack?.inputsSchema]);
  const draft = drafts[inputKey] ?? {};
  const inputs = readInputs(model, draft);

  const cap = Number(budget);
  const budgetOk = budget === '' || (Number.isFinite(cap) && cap > 0);
  const ready =
    text.trim().length > 0 &&
    !!pack &&
    pack.engine.compatible &&
    budgetOk &&
    inputs.errors.length === 0;

  function start() {
    if (!pack || !ready || create.isPending) return;
    create.mutate(
      {
        packId: pack.id,
        input: {
          text: text.trim(),
          ...(Object.keys(inputs.params).length ? { params: inputs.params } : {}),
        },
        title: text.trim().split('\n')[0]!.slice(0, 80),
        mode,
        orchestrator: { delegation: effectiveDelegation },
        ...(projectId ? { projectId: projectId as never } : {}),
        ...(budget !== '' ? { budget: { max: cap } } : {}),
      },
      {
        onSuccess: (run) => void navigate({ to: '/runs/$runId', params: { runId: run.id } }),
        onError: (e) => toast.error('Could not start the run', e.message),
      },
    );
  }

  return (
    <div className="mx-auto flex max-w-5xl flex-col">
      <PageHeader
        title="New run"
        sub="Say what you want done. A team of agents plans it, and you stay in the loop."
      />
      <div className="grid gap-5 px-4 pb-10 md:px-7 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-5">
          <label className="flex flex-col gap-2">
            <span className="text-sm font-medium">What should the team do?</span>
            <textarea
              autoFocus
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={7}
              placeholder="Describe the outcome you want, in your own words. Link a ticket or paste the details if there are any."
              className="rounded-card border border-line2 bg-raised p-3.5 text-[15px] leading-relaxed"
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Project</span>
            <select
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              className="h-9 rounded-lg border border-line2 bg-raised px-2.5 text-sm"
            >
              <option value="">No project</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
            <legend className="mb-1 flex items-center gap-2 text-sm font-medium">
              Pack
              {!packId && suggestedId && (
                <span className="inline-flex items-center gap-1 text-xs font-normal text-ink3">
                  <Sparkles className="size-3" aria-hidden /> suggested
                  {project && project.defaultPackId === suggestedId
                    ? ` as the default for ${project.name}`
                    : project?.defaultPackId
                      ? ' · project default is not installed'
                      : ' · first installed pack'}
                </span>
              )}
            </legend>
            {packs.isLoading ? (
              <Skeleton className="h-20" />
            ) : installed.length === 0 ? (
              <Card className="bg-panel p-4 text-sm text-ink2">No packs are installed yet.</Card>
            ) : (
              <div className="grid gap-2 sm:grid-cols-2">
                {installed.map((p) => {
                  const on = p.id === chosenId;
                  return (
                    <label
                      key={p.id}
                      className={cn(
                        'flex cursor-pointer items-start gap-3 rounded-card border bg-raised p-3 transition-colors',
                        on ? 'border-ink ring-1 ring-ink' : 'border-line2 hover:bg-hover',
                      )}
                    >
                      <input
                        type="radio"
                        name="pack"
                        checked={on}
                        onChange={() => setPackId(p.id)}
                        className="mt-1 accent-[var(--ink)]"
                      />
                      <span className="min-w-0">
                        <span className="flex items-center gap-2 text-sm font-medium">
                          {p.name}
                          <span className="font-mono text-[11px] font-normal text-ink3">
                            {p.version}
                          </span>
                        </span>
                        <span className="mt-0.5 line-clamp-2 block text-xs text-ink2">
                          {p.description}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>
            )}
          </fieldset>
          {pack && (
            <PackInputs
              model={model}
              draft={draft}
              errors={inputs.errors}
              onChange={(next) => setDrafts((current) => ({ ...current, [inputKey]: next }))}
            />
          )}
          {pack && !pack.engine.compatible && (
            <p role="alert" className="text-sm text-bad">
              This pack requires a different engine version. Update the pack or server before
              starting.
            </p>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">Mode</span>
              <Segmented
                label="Mode"
                value={mode}
                onChange={setMode}
                options={[
                  { value: 'review', label: 'Review' },
                  { value: 'autopilot', label: 'Autopilot' },
                ]}
              />
            </div>
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">Budget cap (USD)</span>
              <input
                inputMode="decimal"
                value={budget}
                onChange={(e) => setBudget(e.target.value)}
                placeholder="Pack default"
                aria-invalid={!budgetOk}
                className={cn(
                  'h-9 rounded-lg border bg-raised px-2.5 text-sm',
                  budgetOk ? 'border-line2' : 'border-bad',
                )}
              />
            </label>
          </div>
          <p className="m-0 text-xs text-ink3">
            {mode === 'review'
              ? 'Review pauses for the pack’s required reviews and decisions requested by agents. A final human approval is not guaranteed yet.'
              : 'Autopilot skips optional reviews. Required decisions still pause the run.'}
          </p>
          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium">Delegation</span>
            {graph ? (
              <p className="m-0 text-sm text-ink2">Native agent calls · required by this pack</p>
            ) : (
              <Segmented
                label="Delegation"
                value={delegation}
                onChange={setDelegation}
                options={[
                  { value: 'native', label: 'Native agent calls' },
                  { value: 'krama', label: 'Krama relay' },
                ]}
              />
            )}
            <p className="m-0 text-xs text-ink3">
              {effectiveDelegation === 'native'
                ? 'Agents call their assigned teammates directly. Budget limits act on reported usage; a call may already be in progress.'
                : 'The orchestrator asks Krama to dispatch its worker calls. Krama checks the budget before dispatch.'}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="primary"
              size="lg"
              disabled={!ready}
              busy={create.isPending}
              onClick={start}
            >
              Start run
            </Button>
            <span className="text-xs text-ink3">
              Starts in planning. You can pause or stop at any time.
            </span>
          </div>
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          {pack ? (
            <>
              <TeamPanel pack={pack} />
              <BackendSetup pack={pack} />
              <Card className="p-4">
                <div className="mb-1 text-[11px] tracking-wide text-ink3 uppercase">
                  Typical for this pack
                </div>
                {typical(pack) ? (
                  <div className="text-sm">{typical(pack)}</div>
                ) : (
                  <div className="text-sm text-ink3">
                    No history yet, so nothing to compare with.
                  </div>
                )}
                <div className="mt-1.5 text-xs text-ink3">
                  From past runs only. Cost is shown when the provider reports it.
                </div>
              </Card>
              {pack.tags.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {pack.tags.map((t) => (
                    <Badge key={t}>{t}</Badge>
                  ))}
                </div>
              )}
            </>
          ) : (
            <Card className="bg-panel p-4 text-sm text-ink3">
              Choose a pack to see who would be on the team.
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
