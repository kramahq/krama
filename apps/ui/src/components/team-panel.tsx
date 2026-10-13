import type { BackendDescriptor, Pack, Run } from '@kramahq/contract';
import { Bot, CornerDownRight, Crown } from 'lucide-react';
import { Fragment } from 'react';
import { useAgentDefinitions, useBackends } from '@/api/queries';
import { agentSetup, type SetupDefinition } from '@/lib/agent-setup';
import { Card, RoleChip } from './ui/primitives';

function GraphNode({
  pack,
  id,
  hint,
  depth,
  trail,
  backends,
  definitions,
  shared,
}: {
  pack: Pack;
  id: string;
  hint?: string | undefined;
  depth: number;
  trail: string[];
  backends: BackendDescriptor[];
  definitions: SetupDefinition[];
  shared: Set<string>;
}) {
  const a = pack.agents?.[id];
  if (!a)
    return (
      <li role="status" className="py-1.5 text-xs text-bad">
        Unknown agent reference: {id}
      </li>
    );
  const loop = trail.includes(id);
  const setup = agentSetup(a, backends, definitions);
  return (
    <Fragment>
      <li className="flex items-start gap-2 py-1.5" style={{ paddingLeft: depth * 20 }}>
        {depth > 0 ? (
          <CornerDownRight className="mt-1 size-3.5 shrink-0 text-ink3" aria-hidden />
        ) : (
          <Crown className="mt-1 size-3.5 shrink-0 text-ink3" aria-hidden />
        )}
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <RoleChip role={a.role ?? id} />
            {a.role && a.role !== id && (
              <span className="font-mono text-[11px] text-ink3">{id}</span>
            )}
            {shared.has(id) && <span className="text-[11px] text-ink3">shared instance</span>}
            {loop && <span className="text-[11px] text-bad">cycle</span>}
          </div>
          <div className="mt-1 text-xs text-ink3">
            {setup.source} · {setup.backend ?? 'Backend not resolved'}
            {setup.model && ` · ${setup.model}`}
          </div>
          {a.description && <div className="mt-0.5 text-sm text-ink2">{a.description}</div>}
          {hint && <div className="mt-0.5 text-xs text-ink3">When to use: {hint}</div>}
        </div>
      </li>
      {!loop &&
        a.subAgents?.map((s) => (
          <GraphNode
            key={`${id}>${s.agent}`}
            pack={pack}
            id={s.agent}
            hint={s.hint}
            depth={depth + 1}
            trail={[...trail, id]}
            backends={backends}
            definitions={definitions}
            shared={shared}
          />
        ))}
    </Fragment>
  );
}

/**
 * Who is on the run. A pack with an agent graph shows the orchestrator and the agents it can call, with the hints, as
 * nested. A pack that still has a roster shows its roles. Phases are not shown here: they appear when the orchestrator plans.
 */
export function TeamPanel({ pack, run }: { pack: Pack | undefined; run?: Run }) {
  const backends = useBackends();
  const definitions = useAgentDefinitions();
  const descriptors = backends.data?.items ?? [];
  const agents: SetupDefinition[] = definitions.data?.items ?? [];
  const root = pack?.orchestrator
    ? agentSetup(pack.agents?.[pack.orchestrator], descriptors, agents)
    : undefined;
  const incoming = new Map<string, number>();
  const visited = new Set<string>();
  const visit = (id: string) => {
    if (visited.has(id)) return;
    visited.add(id);
    for (const child of pack?.agents?.[id]?.subAgents ?? []) {
      incoming.set(child.agent, (incoming.get(child.agent) ?? 0) + 1);
      visit(child.agent);
    }
  };
  if (pack?.orchestrator) visit(pack.orchestrator);
  const shared = new Set([...incoming].filter(([, n]) => n > 1).map(([id]) => id));
  return (
    <Card className="p-4">
      <div className="mb-2 flex items-center gap-2 text-[11px] tracking-wide text-ink3 uppercase">
        <Bot className="size-3.5" aria-hidden /> Team
      </div>
      {run && (
        <div className="mb-2 text-sm text-ink2">
          Recorded backend: <span className="font-mono text-ink">{run.orchestrator.backend}</span>
          {run.orchestrator.model && <span className="text-ink3"> · {run.orchestrator.model}</span>}
        </div>
      )}
      {run && root?.backend && root.backend !== run.orchestrator.backend && (
        <p
          role="status"
          className="rounded-lg border border-warn/35 bg-warn/10 p-2 text-xs text-ink2"
        >
          The pack declares {root.backend}, but this run records {run.orchestrator.backend}. The
          active backend is not confirmed.
        </p>
      )}
      {run && (
        <p className="mb-2 text-xs text-ink3">
          Delegation:{' '}
          {run.orchestrator.delegation === 'native' ? 'Native agent calls' : 'Krama relay'}
        </p>
      )}
      {pack?.agents && pack.orchestrator ? (
        <ul className="m-0 list-none p-0">
          <GraphNode
            pack={pack}
            id={pack.orchestrator}
            depth={0}
            trail={[]}
            backends={descriptors}
            definitions={agents}
            shared={shared}
          />
        </ul>
      ) : pack?.roster.length ? (
        <>
          <p className="mb-2 text-xs text-ink3">
            Role-based pack. Agent backends are resolved when the run starts.
          </p>
          <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
            {pack.roster.map((r) => (
              <li key={r.role} className="flex items-center gap-1.5">
                <RoleChip role={r.role} />
                {r.optional && <span className="text-[11px] text-ink3">optional</span>}
              </li>
            ))}
          </ul>
        </>
      ) : (
        <div className="text-sm text-ink3">No team information for this pack.</div>
      )}
    </Card>
  );
}
