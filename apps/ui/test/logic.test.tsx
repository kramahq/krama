import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { EventEnvelope } from '@kramahq/contract';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { RichText } from '@/components/text';
import { render, screen } from '@testing-library/react';
import { activityFromEvent, invalidateFor, useActivity } from '@/api/live';
import { formatSpend, formatUsage, percentUsed, relativeTime, hueOf, duration } from '@/lib/format';
import { sortInbox } from '@/pages/inbox';
import { apiMock, events, resetApi } from './api-mock';
import { decision, ago, inFuture, run } from './fixtures';

vi.mock('@/api/client', async () => {
  const m = await import('./api-mock');
  return { api: m.apiMock, API_BASE: '/api/v1' };
});

describe('what the UI says about money and units', () => {
  it('never turns "not reported" into zero or an estimate', () => {
    expect(formatSpend(null)).toBe('not reported');
    expect(formatSpend(undefined)).toBe('not reported');
    expect(formatSpend({ amount: 0, currency: 'USD' })).toBe('$0.00');
    expect(formatSpend({ amount: 6.8, currency: 'USD' })).toBe('$6.80');
    expect(formatSpend({ amount: 1234.5, currency: 'USD' })).toBe('$1,235');
  });

  it('shows usage in the unit the provider reported', () => {
    expect(formatUsage({ unit: 'tokens', quantity: 12400 })).toBe('12,400 tokens');
    expect(formatUsage({ unit: 'credits', quantity: 3 })).toBe('3 credits');
  });

  it('computes the share of the cap, and nothing when nothing was reported', () => {
    const max = { amount: 40, currency: 'USD' as const };
    expect(percentUsed(max, { amount: 10, currency: 'USD' })).toBe(25);
    expect(percentUsed(max, { amount: 99, currency: 'USD' })).toBe(100);
    expect(percentUsed(max, null)).toBeUndefined();
  });

  it('formats time and durations for people', () => {
    expect(relativeTime(new Date(Date.now() - 5 * 60_000).toISOString())).toMatch(/5 min/);
    expect(relativeTime(undefined)).toBe('');
    expect(duration(412)).toBe('412 ms');
    expect(duration(2500)).toBe('2.5 s');
    expect(hueOf('reviewer')).toBe(hueOf('reviewer'));
    expect(hueOf('reviewer')).not.toBe(hueOf('author'));
  });
});

describe('the inbox order', () => {
  const item = (
    id: string,
    over: { blocking?: boolean; deadlineMin?: number; createdMin?: number },
  ) => ({
    decision: decision({
      id,
      createdAt: ago(over.createdMin ?? 10),
      ...(over.deadlineMin ? { deadline: inFuture(over.deadlineMin) } : {}),
    }),
    run: undefined,
    blocking: over.blocking ?? false,
  });

  it('puts what is holding a run up first, then what expires soonest, then the newest', () => {
    const sorted = sortInbox([
      item('old', { createdMin: 500 }),
      item('new', { createdMin: 1 }),
      item('soon', { deadlineMin: 30 }),
      item('blocks', { blocking: true, createdMin: 200 }),
      item('blocks-sooner', { blocking: true, deadlineMin: 10 }),
    ]);
    expect(sorted.map((i) => i.decision.id)).toEqual([
      'blocks-sooner',
      'blocks',
      'soon',
      'new',
      'old',
    ]);
  });
});

describe('text from agents and people', () => {
  it('renders bold, code and lists, and never interprets HTML', () => {
    const { container } = render(
      <RichText
        text={
          'Use **this** and `that`\n\n- one\n- two\n\n<img src=x onerror=alert(1)><script>boom()</script>'
        }
      />,
    );
    expect(container.querySelector('strong')?.textContent).toBe('this');
    expect(container.querySelector('code')?.textContent).toBe('that');
    expect(container.querySelectorAll('li')).toHaveLength(2);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect(screen.getByText(/<script>boom\(\)<\/script>/)).toBeTruthy();
  });
});

describe('live events', () => {
  const env = (type: string, data: unknown, runId: string | null = 'run_1'): EventEnvelope =>
    ({
      id: '7',
      type,
      at: new Date().toISOString(),
      schema: 1,
      runId: runId ?? undefined,
      subject: { type: 'run', id: 'run_1' },
      data,
    }) as unknown as EventEnvelope;

  it('turns an activity event into a feed row, and keeps one it does not know as status', () => {
    expect(
      activityFromEvent(
        env('activity.tool_call', {
          kind: 'tool_call',
          toolName: 'git.diff',
          agent: { id: 'a', role: 'dev', backend: 'x' },
        }),
      ),
    ).toMatchObject({
      id: '7',
      type: 'tool_call',
      toolName: 'git.diff',
      agent: { role: 'dev' },
    });
    expect(
      activityFromEvent(env('activity.mystery', { kind: 'mystery', text: 'hm' })),
    ).toMatchObject({ type: 'status', text: 'hm' });
    expect(activityFromEvent(env('run.updated', {}))).toBeUndefined();
    expect(activityFromEvent(env('activity.status', {}, null))).toBeUndefined();
  });

  it('refetches exactly what an event touches', () => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    invalidateFor(qc, env('decision.resolved', {}));
    expect(spy.mock.calls.map((c) => (c[0] as { queryKey: unknown[] }).queryKey[0])).toEqual([
      'decisions',
      'run-decisions',
    ]);
    spy.mockClear();
    invalidateFor(qc, env('run.updated', {}));
    expect(spy.mock.calls.map((c) => (c[0] as { queryKey: unknown[] }).queryKey[0])).toEqual([
      'runs',
      'run',
      'decisions',
      'run-decisions',
    ]);
    spy.mockClear();
    invalidateFor(qc, env('agent.spawned', {}));
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('the activity feed connection', () => {
  beforeEach(() => resetApi());
  // One client for the whole test: a new one per render would itself restart the stream.
  let client: QueryClient;
  beforeEach(() => {
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );

  it('opens the stream once per run, however often the screen re-renders (it used to restart on every render)', async () => {
    const { result, rerender } = renderHook(({ id }) => useActivity(id), {
      wrapper,
      initialProps: { id: 'run_1' },
    });
    await waitFor(() => expect(result.current.status).toBe('live'));
    for (let i = 0; i < 6; i++) rerender({ id: 'run_1' });
    expect(events.open).toHaveBeenCalledTimes(1);
    expect(events.open).toHaveBeenCalledWith(['run:run_1']);
    rerender({ id: 'run_2' });
    await waitFor(() => expect(events.open).toHaveBeenCalledTimes(2));
  });

  it('appends live activity after the snapshot and ignores one it already has', async () => {
    (apiMock.runs as Record<string, ReturnType<typeof vi.fn>>).allActivity!.mockResolvedValue({
      items: [{ id: 'a1', at: ago(5), type: 'status', runId: 'run_1', text: 'first' }],
    });
    const { result } = renderHook(() => useActivity('run_1'), { wrapper });
    await waitFor(() => expect(result.current.items).toHaveLength(1));
    const push = (id: string) =>
      events.last!.onEvent({
        id,
        type: 'activity.status',
        at: ago(1),
        schema: 1,
        runId: 'run_1',
        subject: { type: 'run', id: 'run_1' },
        data: { kind: 'status', text: `n${id}` },
      });
    push('b2');
    push('b2');
    push('c3');
    await waitFor(() => expect(result.current.items.map((i) => i.id)).toEqual(['a1', 'b2', 'c3']));
  });
});

void run;
