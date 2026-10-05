import type { ActivityItem } from '@kramahq/sdk';
import {
  Brain,
  ChevronDown,
  ChevronRight,
  CircleDot,
  MessageSquare,
  Package,
  Radio,
  ScrollText,
  Wrench,
  WifiOff,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useActivity } from '@/api/live';
import { cn } from '@/lib/cn';
import { clockTime, duration } from '@/lib/format';
import { RoleChip, Button, Chip, EmptyState, Skeleton } from './ui/primitives';

type Kind = ActivityItem['type'];
const KINDS: { kind: Kind; label: string; icon: typeof Wrench }[] = [
  { kind: 'tool_call', label: 'Tool calls', icon: Wrench },
  { kind: 'thinking', label: 'Thinking', icon: Brain },
  { kind: 'status', label: 'Status', icon: Radio },
  { kind: 'message', label: 'Messages', icon: MessageSquare },
  { kind: 'artifact', label: 'Artifacts', icon: Package },
  { kind: 'decision', label: 'Decisions', icon: CircleDot },
];
const ICON: Record<Kind, typeof Wrench> = {
  tool_call: Wrench,
  tool_result: Wrench,
  thinking: Brain,
  status: Radio,
  message: MessageSquare,
  artifact: Package,
  decision: CircleDot,
};
// A call and its result are one thing to a reader.
const group = (k: Kind): Kind => (k === 'tool_result' ? 'tool_call' : k);

function Row({ item }: { item: ActivityItem }) {
  const [open, setOpen] = useState(false);
  const Icon = ICON[item.type];
  const thinking = item.type === 'thinking';
  const long = (item.text?.length ?? 0) > 140;
  return (
    <li className="flex gap-3 border-b border-line px-4 py-2 md:px-7">
      <time className="w-[66px] shrink-0 pt-0.5 font-mono text-[11px] text-ink3" dateTime={item.at}>
        {clockTime(item.at)}
      </time>
      <Icon
        className={cn('mt-1 size-3.5 shrink-0', item.isError ? 'text-bad' : 'text-ink3')}
        aria-hidden
      />
      <div className="min-w-0 flex-1 text-sm">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {item.agent && <RoleChip role={item.agent.role} />}
          {item.type === 'tool_call' && <span className="text-ink2">called</span>}
          {item.type === 'tool_result' && (
            <span className={item.isError ? 'text-bad' : 'text-ink2'}>
              {item.isError ? 'failed' : 'got a result from'}
            </span>
          )}
          {item.toolName && (
            <code className="rounded bg-hover px-1 py-px font-mono text-[12px]">
              {item.toolName}
            </code>
          )}
          {item.durationMs !== undefined && (
            <span className="font-mono text-[11px] text-ink3">{duration(item.durationMs)}</span>
          )}
          {thinking && (
            <button
              type="button"
              onClick={() => setOpen(!open)}
              aria-expanded={open}
              className="inline-flex items-center gap-1 text-xs text-ink3 hover:text-ink"
            >
              {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}{' '}
              thinking
            </button>
          )}
        </div>
        {item.text && !item.toolName && (!thinking || open) && (
          <div
            className={cn(
              'prose-lite mt-0.5 text-ink',
              thinking && 'text-ink2 italic',
              !open && long && 'line-clamp-2',
            )}
          >
            {item.text}
          </div>
        )}
        {item.text &&
          item.toolName &&
          item.type === 'tool_result' &&
          item.text !== item.toolName && (
            <div className="prose-lite mt-0.5 line-clamp-2 text-ink2">{item.text}</div>
          )}
      </div>
    </li>
  );
}

/**
 * The live account of what a run's agents are doing: tool calls, reasoning, status. Thinking is collapsed. It follows new
 * activity unless you scroll up to read, and it says plainly when the connection is not live.
 */
export function ActivityFeed({ runId }: { runId: string }) {
  const feed = useActivity(runId);
  const [kinds, setKinds] = useState<Set<Kind>>(new Set());
  const [agent, setAgent] = useState('');
  const [follow, setFollow] = useState(true);
  const scroller = useRef<HTMLDivElement>(null);
  const end = useRef<HTMLLIElement>(null);

  const agents = useMemo(
    () => [...new Set(feed.items.map((i) => i.agent?.role).filter((r): r is string => !!r))].sort(),
    [feed.items],
  );
  const items = useMemo(
    () =>
      feed.items.filter(
        (i) =>
          (kinds.size === 0 || kinds.has(group(i.type))) && (!agent || i.agent?.role === agent),
      ),
    [feed.items, kinds, agent],
  );

  useEffect(() => {
    if (follow) end.current?.scrollIntoView({ block: 'end' });
  }, [items.length, follow]);

  const toggle = (k: Kind) =>
    setKinds((s) => {
      const n = new Set(s);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });

  return (
    <div className="flex min-h-[420px] flex-col">
      {feed.status !== 'live' && (
        <div
          role="status"
          className={cn(
            'flex items-center gap-2 border-b px-4 py-2 text-sm md:px-7',
            feed.status === 'disconnected'
              ? 'border-bad/30 bg-bad/8 text-bad'
              : 'border-warn/30 bg-warn/10 text-warn',
          )}
        >
          <WifiOff className="size-4 shrink-0" aria-hidden />
          {feed.status === 'connecting'
            ? 'Connecting to the live feed…'
            : feed.status === 'reconnecting'
              ? 'The live feed dropped. Reconnecting; anything you missed will appear when it is back.'
              : `The live feed is off${feed.reason ? `: ${feed.reason}` : ''}. Reload to reconnect.`}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-1.5 border-b border-line px-4 py-2.5 md:px-7">
        {KINDS.map((k) => (
          <Chip key={k.kind} active={kinds.has(k.kind)} onClick={() => toggle(k.kind)}>
            <k.icon className="size-3" aria-hidden /> {k.label}
          </Chip>
        ))}
        {agents.length > 1 && (
          <select
            aria-label="Agent"
            value={agent}
            onChange={(e) => setAgent(e.target.value)}
            className="h-7 rounded-full border border-line2 bg-raised px-2.5 text-xs"
          >
            <option value="">All agents</option>
            {agents.map((a) => (
              <option key={a}>{a}</option>
            ))}
          </select>
        )}
        <Button
          size="sm"
          variant={follow ? 'secondary' : 'ghost'}
          className="ml-auto"
          aria-pressed={follow}
          onClick={() => setFollow(!follow)}
        >
          {follow ? 'Following' : 'Paused'}
        </Button>
      </div>

      <div
        ref={scroller}
        className="max-h-[60vh] min-h-0 flex-1 overflow-y-auto scroll-thin"
        // Reading history is a decision to stop following; getting back to the end resumes it.
        onScroll={(e) => {
          const el = e.currentTarget;
          const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          if (!atEnd && follow) setFollow(false);
          if (atEnd && !follow) setFollow(true);
        }}
      >
        {feed.loading ? (
          <div className="flex flex-col gap-3 p-5">
            {[0, 1, 2, 3].map((n) => (
              <Skeleton key={n} className="h-8" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <EmptyState
            icon={<ScrollText className="size-8" aria-hidden />}
            title={feed.items.length ? 'Nothing matches these filters' : 'No activity yet'}
          >
            {feed.items.length
              ? 'Clear a filter to see everything.'
              : 'Tool calls, reasoning and status from the agents appear here as they work.'}
          </EmptyState>
        ) : (
          <ul className="m-0 list-none p-0">
            {items.map((i) => (
              <Row key={i.id} item={i} />
            ))}
            <li ref={end} aria-hidden />
          </ul>
        )}
      </div>
    </div>
  );
}
