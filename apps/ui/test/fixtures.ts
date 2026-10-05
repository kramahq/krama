import type { Capabilities, Decision, Me, Pack, Project, Run } from '@kramahq/contract';

const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
const later = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();

export const me = {
  id: 'u_priya',
  name: 'Priya',
  email: 'p@example.com',
  roles: ['admin'],
  permissions: ['*'],
  preferences: { theme: 'system' },
} as unknown as Me;

export const capabilities = (over: Partial<Capabilities['features']> = {}): Capabilities =>
  ({
    apiVersion: 'v1',
    engineVersion: 'test',
    a2a: { versions: ['1.0'] },
    features: {
      runs: true,
      decisions: true,
      packs: true,
      memory: { enabled: true, scopes: ['project'], export: [], gitSync: false },
      schedules: { enabled: true, triggers: ['cron'] },
      builder: true,
      multiProject: true,
      eventReplay: true,
      ...over,
    },
    workItemSources: [],
    backends: [{ wrapper: 'a2a-claude', label: 'Claude', models: [], canOrchestrate: true }],
  }) as unknown as Capabilities;

export const projects: Project[] = [
  {
    id: 'proj_pay',
    name: 'payments',
    description: 'Payments (work)',
    defaultPackId: 'pack_a',
    budget: { max: { amount: 200, currency: 'USD' }, spent: null },
    createdAt: at(9000),
    links: {},
  },
  {
    id: 'proj_oss',
    name: 'a2a-wrapper',
    description: 'Open source',
    defaultPackId: 'pack_b',
    budget: { max: { amount: 100, currency: 'USD' }, spent: null },
    createdAt: at(9000),
    links: {},
  },
] as unknown as Project[];

export const packs: Pack[] = [
  {
    id: 'pack_a',
    name: 'AI-DLC',
    version: '0.3.0',
    description: 'A methodology',
    tags: ['sdlc'],
    status: 'installed',
    roster: [{ role: 'analyst', select: {} }],
    stats: { runs: 4, successRate: 0.9, avgCost: { amount: 21.4, currency: 'USD' } },
  },
  {
    id: 'pack_b',
    name: 'Explainer',
    version: '1.2.0',
    description: 'Videos',
    tags: [],
    status: 'installed',
    roster: [],
    stats: { runs: 0, successRate: 0, avgCost: null },
  },
] as unknown as Pack[];

export const run = (over: Partial<Run> = {}): Run =>
  ({
    id: 'run_1',
    title: 'Customer notifications',
    input: { text: 'Build it' },
    pack: { id: 'pack_a', version: '0.3.0', sha: 'abc' },
    projectId: 'proj_pay',
    status: 'running',
    mode: 'review',
    orchestrator: { definitionId: 'orchestrator/default', backend: 'a2a-claude' },
    budget: {
      max: { amount: 40, currency: 'USD' },
      spent: { amount: 10, currency: 'USD' },
      warnAtPct: 80,
      onExceed: 'pause',
    },
    currentPhaseIds: [],
    phases: [
      {
        id: 'p1',
        label: 'Inception',
        agentRoles: ['analyst'],
        dependsOn: [],
        status: 'completed',
        iteration: 1,
        cost: { amount: 3, currency: 'USD' },
      },
      {
        id: 'p2',
        label: 'Construction',
        agentRoles: ['developer'],
        dependsOn: ['p1'],
        status: 'active',
        iteration: 1,
        cost: null,
      },
      {
        id: 'p3',
        label: 'Operations',
        agentRoles: ['devops'],
        dependsOn: ['p2'],
        status: 'pending',
        iteration: 0,
        cost: null,
      },
    ],
    pendingDecisions: 0,
    trigger: { type: 'manual' },
    labels: [],
    createdBy: { type: 'user', id: 'u_priya', name: 'Priya' },
    createdAt: at(120),
    updatedAt: at(5),
    links: {},
    ...over,
  }) as unknown as Run;

export const decision = (over: Partial<Omit<Decision, 'id'>> & { id?: string } = {}): Decision =>
  ({
    id: 'dec_1',
    kind: 'review',
    status: 'pending',
    runId: 'run_1',
    title: 'Validate the plan',
    question: 'Check **this**',
    options: [
      { id: 'approve', label: 'Approve', style: 'primary', effect: 'Work continues' },
      {
        id: 'changes',
        label: 'Request changes',
        style: 'neutral',
        effect: 'It re-runs',
        input: { required: true, label: 'Your notes', kind: 'text' },
      },
      { id: 'reject', label: 'Reject', style: 'danger', effect: 'The run stops' },
    ],
    need: 1,
    createdAt: at(10),
    links: {},
    ...over,
  }) as unknown as Decision;

export const inFuture = later;
export const ago = at;
