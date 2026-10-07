import type { Phase, Run } from '@kramahq/contract';
import { cn } from '@/lib/cn';
import { RUN_STATUS } from '@/lib/status';
import { Badge } from './ui/primitives';

export function RunStatusBadge({ status }: { status: Run['status'] }) {
  const s = RUN_STATUS[status];
  return (
    <Badge tone={s.tone} dot>
      {s.label}
    </Badge>
  );
}

const PHASE_FILL: Record<Phase['status'], string> = {
  completed: 'bg-ok',
  active: 'bg-info',
  looping: 'bg-info',
  awaiting_decision: 'bg-warn',
  failed: 'bg-bad',
  pending: 'bg-line2',
  skipped: 'bg-line',
};

/** One segment per phase, coloured by where it is: a run's shape at a glance. */
export function PhaseBar({
  phases,
  className,
}: {
  phases: readonly Phase[] | undefined;
  className?: string;
}) {
  if (!phases?.length) return <span className="text-xs text-ink3">plans as it goes</span>;
  const done = phases.filter((p) => p.status === 'completed').length;
  return (
    <div
      className={cn('flex items-center gap-2', className)}
      title={phases.map((p) => `${p.label}: ${p.status.replace('_', ' ')}`).join('\n')}
    >
      <div className="flex min-w-16 flex-1 gap-0.5" aria-hidden>
        {phases.map((p) => (
          <span key={p.id} className={cn('h-1.5 flex-1 rounded-full', PHASE_FILL[p.status])} />
        ))}
      </div>
      <span className="font-mono text-[11px] whitespace-nowrap text-ink3">
        {done}/{phases.length}
      </span>
    </div>
  );
}
