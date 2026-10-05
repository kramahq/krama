import { vi } from 'vitest';
import { capabilities, decision, me, packs, projects, run } from './fixtures';

type Fn = ReturnType<typeof vi.fn>;
const page = <T>(items: T[]) => ({ items, total: items.length });

/** A stand-in for the SDK client: every call is a spy, with sensible defaults a test can override. */
export const apiMock: Record<string, Fn | Record<string, Fn>> = {};

export const events = {
  open: vi.fn(),
  last: undefined as
    | undefined
    | { onEvent: (e: unknown) => void; onStatus?: (s: string) => void; topics?: string[] },
};

export function resetApi(): void {
  events.open.mockReset();
  events.last = undefined;
  Object.assign(apiMock, {
    capabilities: vi.fn().mockResolvedValue(capabilities()),
    me: vi.fn().mockResolvedValue(me),
    allowedBackends: vi.fn().mockResolvedValue({
      items: [
        { wrapper: 'a2a-claude', allowed: true },
        { wrapper: 'a2a-copilot', allowed: false },
      ],
    }),
    projects: { list: vi.fn().mockResolvedValue(page(projects)), get: vi.fn() },
    packs: {
      list: vi.fn().mockResolvedValue(page(packs)),
      get: vi.fn().mockImplementation(async (id: string) => packs.find((p) => p.id === id)),
    },
    runs: {
      list: vi.fn().mockResolvedValue(page([run()])),
      get: vi.fn().mockResolvedValue(run()),
      create: vi.fn().mockResolvedValue(run({ id: 'run_new' })),
      pause: vi.fn().mockResolvedValue(run({ status: 'paused' })),
      resume: vi.fn().mockResolvedValue(run()),
      stop: vi.fn().mockResolvedValue(run({ status: 'stopped' })),
      activity: vi.fn().mockResolvedValue(page([])),
      allActivity: vi.fn().mockResolvedValue(page([])),
      decisions: vi.fn().mockResolvedValue(page([])),
    },
    decisions: {
      list: vi.fn().mockResolvedValue(page([decision()])),
      get: vi.fn().mockImplementation(async (id: string) => decision({ id })),
      resolve: vi.fn().mockResolvedValue(decision({ status: 'resolved' })),
    },
    events: vi
      .fn()
      .mockImplementation(
        (o: {
          onEvent: (e: unknown) => void;
          onStatus?: (s: string) => void;
          topics?: string[];
        }) => {
          events.open(o.topics);
          events.last = o;
          queueMicrotask(() => o.onStatus?.('live'));
          return { close: vi.fn(), cursor: () => undefined };
        },
      ),
  });
}
resetApi();
