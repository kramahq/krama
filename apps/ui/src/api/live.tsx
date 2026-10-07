import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { EventEnvelope } from '@kramahq/contract';
import type { ActivityItem, EventStream, Page, StreamStatus } from '@kramahq/sdk';
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { api } from './client';
import { keys } from './queries';

interface LiveState {
  status: StreamStatus;
  reason?: string | undefined;
}
const Ctx = createContext<LiveState>({ status: 'connecting' });

/** The state of the connection that keeps every screen current. */
export const useLiveStatus = (): LiveState => useContext(Ctx);

/**
 * What an event means for what is on screen. Run and decision events refetch the lists and the run being looked at; the
 * request is coalesced, so a burst of events costs one refetch.
 */
export function invalidateFor(qc: QueryClient, e: EventEnvelope): void {
  const t = e.type;
  if (
    t.startsWith('run.') ||
    t.startsWith('phase.') ||
    t.startsWith('cost.') ||
    t.startsWith('budget.')
  ) {
    void qc.invalidateQueries({ queryKey: ['runs'] });
    if (e.runId) void qc.invalidateQueries({ queryKey: keys.run(e.runId) });
  }
  if (t.startsWith('decision.') || t.startsWith('run.')) {
    void qc.invalidateQueries({ queryKey: ['decisions'] });
    void qc.invalidateQueries({ queryKey: ['run-decisions'] });
  }
}

/** Opens the platform-wide stream (`runs` and `inbox`) once for the whole app. */
export function LiveProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [state, setState] = useState<LiveState>({ status: 'connecting' });
  const pending = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    const queue: EventEnvelope[] = [];
    const flush = () => {
      pending.current = undefined;
      for (const e of queue.splice(0)) invalidateFor(qc, e);
    };
    const stream: EventStream = api.events({
      topics: ['runs', 'inbox'],
      onEvent: (e) => {
        queue.push(e);
        pending.current ??= setTimeout(flush, 150);
      },
      onStatus: (status, info) => setState({ status, reason: info?.reason }),
      // Our position is too old: take a fresh snapshot of everything on screen instead of replaying.
      onGone: () => void qc.invalidateQueries(),
    });
    return () => {
      stream.close();
      clearTimeout(pending.current);
    };
  }, [qc]);

  return <Ctx.Provider value={state}>{children}</Ctx.Provider>;
}

/** An `activity.*` event as a row of the feed. */
export function activityFromEvent(e: EventEnvelope): ActivityItem | undefined {
  if (!e.type.startsWith('activity.') || !e.runId) return undefined;
  const d = (e.data ?? {}) as Record<string, unknown>;
  const kind = String(d.kind ?? e.type.slice('activity.'.length));
  const known = [
    'tool_call',
    'tool_result',
    'thinking',
    'status',
    'message',
    'artifact',
    'decision',
  ] as const;
  const type = (known as readonly string[]).includes(kind)
    ? (kind as ActivityItem['type'])
    : 'status';
  const agent = d.agent as ActivityItem['agent'] | undefined;
  return {
    id: e.id,
    at: e.at,
    type,
    runId: e.runId,
    ...(agent ? { agent } : {}),
    ...(typeof d.phaseId === 'string' ? { phaseId: d.phaseId } : {}),
    ...(typeof d.text === 'string' ? { text: d.text } : {}),
    ...(typeof d.toolName === 'string' ? { toolName: d.toolName } : {}),
    ...(typeof d.isError === 'boolean' ? { isError: d.isError } : {}),
    ...(typeof d.durationMs === 'number' ? { durationMs: d.durationMs } : {}),
  };
}

/**
 * A run's activity: what has happened so far, plus what arrives while the screen is open. It has its own connection, so it
 * can show "reconnecting" for this run alone, and it resumes from where it left off.
 */
export function useActivity(runId: string): {
  items: ActivityItem[];
  loading: boolean;
  status: StreamStatus;
  reason?: string | undefined;
} {
  const qc = useQueryClient();
  // A new array every render would restart the stream every render, so the key is made once per run.
  const key = useMemo(() => keys.activity(runId), [runId]);
  const snapshot = useQuery({
    queryKey: key,
    queryFn: () => api.runs.allActivity(runId),
    staleTime: Infinity,
  });
  const [conn, setConn] = useState<LiveState>({ status: 'connecting' });

  useEffect(() => {
    const stream = api.events({
      topics: [`run:${runId}`],
      onEvent: (e) => {
        const item = activityFromEvent(e);
        if (!item) return;
        qc.setQueryData<Page<ActivityItem>>(key, (old) => {
          const items = old?.items ?? [];
          return items.some((i) => i.id === item.id)
            ? old
            : { ...(old ?? {}), items: [...items, item] };
        });
      },
      onStatus: (status, info) => setConn({ status, reason: info?.reason }),
      onGone: () => void qc.invalidateQueries({ queryKey: key }),
    });
    return () => stream.close();
  }, [qc, runId, key]);

  const items = useMemo(() => snapshot.data?.items ?? [], [snapshot.data]);
  return { items, loading: snapshot.isLoading, ...conn };
}
