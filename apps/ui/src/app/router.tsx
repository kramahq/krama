import { QueryClient } from '@tanstack/react-query';
import {
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
  type RouterHistory,
} from '@tanstack/react-router';
import { InboxPage } from '@/pages/inbox';
import { NewRunPage } from '@/pages/new-run';
import { NotFound, RouteError } from '@/pages/errors';
import { Placeholder } from '@/pages/placeholder';
import { RunDetailPage, type RunTab } from '@/pages/run-detail';
import { RunsPage } from '@/pages/runs';
import { Shell } from './shell';

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
/** Only the params that are set, so a link does not have to name the ones it does not care about. */
const given = <K extends string>(key: K, v: unknown): { [P in K]?: string } => {
  const s = str(v);
  return s === undefined ? {} : ({ [key]: s } as { [P in K]?: string });
};

const root = createRootRoute({
  component: Shell,
  notFoundComponent: NotFound,
  errorComponent: RouteError,
});

const index = createRoute({
  getParentRoute: () => root,
  path: '/',
  beforeLoad: () => {
    throw redirect({ to: '/inbox' });
  },
});

export const inboxRoute = createRoute({
  getParentRoute: () => root,
  path: '/inbox',
  component: InboxPage,
  validateSearch: (s: Record<string, unknown>): { kind?: string; id?: string } => ({
    ...given('kind', s.kind),
    ...given('id', s.id),
  }),
});

export const runsRoute = createRoute({
  getParentRoute: () => root,
  path: '/runs',
  component: RunsPage,
  validateSearch: (s: Record<string, unknown>): { view?: string; q?: string } => ({
    ...given('view', s.view),
    ...given('q', s.q),
  }),
});

const newRunRoute = createRoute({
  getParentRoute: () => root,
  path: '/runs/new',
  component: NewRunPage,
});

const TABS: readonly RunTab[] = ['overview', 'activity', 'artifacts', 'workspace', 'cost'];
export const runRoute = createRoute({
  getParentRoute: () => root,
  path: '/runs/$runId',
  component: RunDetailPage,
  validateSearch: (s: Record<string, unknown>): { tab?: RunTab } =>
    (TABS as readonly unknown[]).includes(s.tab) ? { tab: s.tab as RunTab } : {},
});

const later = (path: string, title: string, sub: string, task: string, text: string) =>
  createRoute({
    getParentRoute: () => root,
    path,
    component: () => (
      <Placeholder title={title} sub={sub} task={task}>
        {text}
      </Placeholder>
    ),
  });

const tree = root.addChildren([
  index,
  inboxRoute,
  runsRoute,
  newRunRoute,
  runRoute,
  later(
    '/packs',
    'Packs',
    'What your agents can do, and what each pack is allowed to touch',
    'U4',
    'The catalog, install consent (tools, folders outside the workspace, secrets, memory, backends) and update diffs.',
  ),
  later(
    '/agents',
    'Agents',
    'The pool of agents your packs are built from',
    'U4',
    'Add an agent from a git URL, see what it declares, and register it.',
  ),
  later(
    '/memory',
    'Memory',
    'What agents have learned, and what they are proposing to remember',
    'U4',
    'Scopes, the proposals queue with provenance, and the untrusted-source badge.',
  ),
  later(
    '/studio',
    'Studio',
    'Build packs from your agent pool',
    'U6',
    'The builder chat beside a live draft: the agent graph with hints, validation and tests.',
  ),
  later(
    '/fleet',
    'Fleet',
    'The agents that are running, and how each backend is doing',
    'U5',
    'Instances, backend load, health and cost where reported, and the playground.',
  ),
  later(
    '/schedules',
    'Schedules',
    'Runs that start on their own',
    'U5',
    'Cron and one-shot schedules, enable and disable.',
  ),
  later(
    '/governance',
    'Governance',
    'Budgets, audit, permissions and allowed backends',
    'U5',
    'Unit-aware budgets and usage, the audit log, and what each pack and agent holds.',
  ),
]);

/** The app's router. Tests pass an in-memory history; the browser uses its own. */
export function createAppRouter(_qc: QueryClient, history?: RouterHistory) {
  return createRouter({
    routeTree: tree,
    defaultPreload: 'intent',
    defaultNotFoundComponent: NotFound,
    ...(history ? { history } : {}),
  });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
