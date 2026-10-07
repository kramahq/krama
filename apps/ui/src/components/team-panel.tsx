import type { Pack, Run } from '@kramahq/contract';
import { Bot, CornerDownRight, Crown } from 'lucide-react';
import { Fragment } from 'react';
import { Card, RoleChip } from './ui/primitives';

function GraphNode({
  pack,
  id,
  hint,
  depth,
  trail,
}: {
  pack: Pack;
  id: string;
  hint?: string | undefined;
  depth: number;
  trail: string[];
}) {
  const a = pack.agents?.[id];
  if (!a) return null;
  const loop = trail.includes(id);
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
            {a.external && <span className="text-[11px] text-ink3">external</span>}
            {loop && <span className="text-[11px] text-bad">cycle</span>}
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
  return (
    <Card className="p-4">
      <div className="mb-2 flex items-center gap-2 text-[11px] tracking-wide text-ink3 uppercase">
        <Bot className="size-3.5" aria-hidden /> Team
      </div>
      {run && (
        <div className="mb-2 text-sm text-ink2">
          Orchestrated by <span className="font-mono text-ink">{run.orchestrator.backend}</span>
          {run.orchestrator.model && <span className="text-ink3"> · {run.orchestrator.model}</span>}
        </div>
      )}
      {pack?.agents && pack.orchestrator ? (
        <ul className="m-0 list-none p-0">
          <GraphNode pack={pack} id={pack.orchestrator} depth={0} trail={[]} />
        </ul>
      ) : pack?.roster.length ? (
        <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
          {pack.roster.map((r) => (
            <li key={r.role} className="flex items-center gap-1.5">
              <RoleChip role={r.role} />
              {r.optional && <span className="text-[11px] text-ink3">optional</span>}
            </li>
          ))}
        </ul>
      ) : (
        <div className="text-sm text-ink3">No team information for this pack.</div>
      )}
    </Card>
  );
}
