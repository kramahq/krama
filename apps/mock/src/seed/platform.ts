import type {
  Agent,
  AuditEntry,
  MemoryRecord,
  MemoryScope,
  Project,
  Schedule,
} from '@kramahq/contract';
import { fixture } from '../fixtures.js';
import { NOW } from './runs.js';

const at = (minutesAgo: number): string => new Date(NOW - minutesAgo * 60_000).toISOString();
const usd = (amount: number) => ({ amount, currency: 'USD' as const });

export const projects: Project[] = [
  {
    id: 'proj_payments',
    name: 'payments',
    description: 'Payments platform (work)',
    defaultPackId: 'pack_aidlc',
    workItemSource: 'jira',
    memoryScope: { type: 'project', id: 'proj_payments' },
    budget: { max: usd(200), spent: usd(60.4) },
    createdAt: at(40_000),
    links: {},
  },
  {
    id: 'proj_a2a',
    name: 'a2a-wrapper',
    description: 'Open-source A2A wrapper',
    defaultPackId: 'pack_aidlc',
    workItemSource: 'github',
    memoryScope: { type: 'project', id: 'proj_a2a' },
    budget: { max: usd(100), spent: null },
    createdAt: at(30_000),
    links: {},
  },
  {
    id: 'proj_shp',
    name: 'shp',
    description: 'Work: decks and web',
    defaultPackId: 'pack_deck',
    memoryScope: { type: 'project', id: 'proj_shp' },
    budget: { max: usd(150), spent: usd(31.3) },
    createdAt: at(20_000),
    links: {},
  },
  {
    id: 'proj_personal',
    name: 'personal',
    description: 'Personal experiments',
    defaultPackId: 'pack_video',
    memoryScope: { type: 'project', id: 'proj_personal' },
    budget: { max: usd(50), spent: usd(34.35) },
    createdAt: at(10_000),
    links: {},
  },
];

const mkAgent = (
  id: string,
  role: string,
  backend: string,
  model: string,
  status: Agent['status'],
  run?: string,
  phase?: string,
): Agent =>
  ({
    id: id as Agent['id'],
    definitionId: `${role}/default`,
    role,
    backend,
    model,
    status,
    url: `http://127.0.0.1:${41000 + Math.abs((id.length * 37) % 900)}`,
    port: 41000 + Math.abs((id.length * 37) % 900),
    startedAt: at(180),
    lastHealthAt: at(0),
    ...(run
      ? {
          assignment: {
            runId: run as Agent['id'] & `run_${string}`,
            ...(phase ? { phaseId: phase } : {}),
          },
        }
      : {}),
    workspace: { mode: 'isolated', path: `/work/${id}` },
    session: { contextId: `ctx_${id}`, resumable: true },
    links: {},
  }) as Agent;

export const agents: Agent[] = [
  { ...fixture<Agent>('agent.json') },
  mkAgent(
    'agt_dev1',
    'developer',
    'a2a-codex',
    'gpt-5-codex',
    'idle',
    'run_01J9PART',
    'construction',
  ),
  mkAgent(
    'agt_rev1',
    'reviewer',
    'a2a-claude',
    'claude-opus-5-5',
    'idle',
    'run_01J9PART',
    'construction',
  ),
  mkAgent('agt_video1', 'video', 'a2a-claude', 'claude-opus-5-5', 'busy', 'run_01J9VID', 'video'),
  mkAgent(
    'agt_slide1',
    'slide-designer',
    'a2a-antigravity',
    'gemini-3',
    'unhealthy',
    'run_01J9DECK',
    'design',
  ),
  mkAgent('agt_orch1', 'orchestrator', 'a2a-codex', 'gpt-5-codex', 'busy', 'run_01J9AIDLC'),
];

export const memory: MemoryRecord[] = [
  fixture<MemoryRecord>('memory-proposal.json'),
  ...(
    [
      [
        'org',
        'org_acme',
        'Writing style',
        'Use sentence case for headings. Avoid “leverage”.',
        'Marco · manual',
      ],
      [
        'project',
        'proj_payments',
        'Repositories',
        'payments-service is the system of record; ledger-core is read-only for agents.',
        'Priya · manual',
      ],
      [
        'project',
        'proj_payments',
        'Retention',
        'Delivery logs are retained 13 months (finance policy FIN-7).',
        'run_01J8NOTIF · accepted',
      ],
      [
        'pack',
        'pack_aidlc',
        'Bolt size',
        'Keep bolts under 400 changed lines; split otherwise.',
        'pack default',
      ],
      [
        'pack',
        'pack_deck',
        'Board decks',
        'Board decks: 14 slides max, appendix at most 4.',
        'run_01J7BRD · accepted',
      ],
    ] as const
  ).map(
    ([scope, sid, kind, content, src], i): MemoryRecord =>
      ({
        id: `mem_seed${i}` as MemoryRecord['id'],
        scope: { type: scope, id: sid },
        type: 'semantic',
        kind,
        content,
        tags: [kind.toLowerCase()],
        status: 'active',
        trust: 'trusted',
        confidence: { initial: 0.9, current: 0.9 },
        provenance: {
          method: src.includes('manual') ? 'human' : 'agent_inference',
          ...(src.startsWith('run_')
            ? { runId: src.split(' ')[0] as MemoryRecord['id'] & `run_${string}` }
            : {}),
        },
        contentHash: `sha256:seed${i}`,
        version: 1,
        access: { read: ['*'], write: [] },
        createdAt: at(5000),
        updatedAt: at(5000),
        usage: { reads: 20 + i * 14 },
        links: {},
      }) as MemoryRecord,
  ),
  {
    ...fixture<MemoryRecord>('memory-proposal.json'),
    id: 'mem_untrusted1',
    trust: 'untrusted',
    content: 'The staging cluster accepts unsigned webhooks.',
    provenance: {
      method: 'agent_inference',
      runId: 'run_01J9PART',
      agent: 'developer-2',
      evidence: [{ type: 'web_fetch', ref: 'https://example.com/forum/thread/42' }],
    },
  },
];

export const memoryScopes: MemoryScope[] = [
  {
    type: 'org',
    id: 'org_acme',
    label: 'Org',
    acl: [{ principal: 'role:admin', access: 'admin' }],
    stats: { records: 1, proposed: 0, untrusted: 0 },
  },
  {
    type: 'project',
    id: 'proj_payments',
    label: 'Project · payments',
    acl: [{ principal: 'role:operator', access: 'write' }],
    stats: { records: 2, proposed: 2, untrusted: 1 },
  },
  {
    type: 'pack',
    id: 'pack_aidlc',
    label: 'Pack · AI-DLC',
    acl: [{ principal: 'role:author', access: 'write' }],
    stats: { records: 1, proposed: 0, untrusted: 0 },
  },
  {
    type: 'pack',
    id: 'pack_deck',
    label: 'Pack · Deck Studio',
    acl: [],
    stats: { records: 1, proposed: 0, untrusted: 0 },
  },
];

export const schedules: Schedule[] = [
  fixture<Schedule>('schedule.json'),
  {
    id: 'sch_weekly_deck',
    name: 'Weekly metrics deck',
    pack: { id: 'pack_deck', pin: 'latest' },
    trigger: { type: 'cron', expression: '0 7 * * MON', timezone: 'Asia/Kolkata' },
    input: { brief: 'Weekly metrics' },
    policies: { overlap: 'skip', missedFire: 'drop', maxConcurrent: 1 },
    budget: { perRun: usd(8) },
    status: 'active',
    nextFireAt: at(-6000),
    lastRun: { runId: 'run_01J9SCAN', status: 'completed', at: at(10_000) },
    links: {},
  },
  {
    id: 'sch_quarterly',
    name: 'Quarterly architecture review',
    pack: { id: 'pack_aidlc', pin: 'latest' },
    trigger: { type: 'cron', expression: '0 9 1 */3 *', timezone: 'Asia/Kolkata' },
    input: {},
    policies: { overlap: 'skip', missedFire: 'drop', maxConcurrent: 1 },
    budget: { perRun: usd(40) },
    status: 'paused',
    links: {},
  },
];

export const audit: AuditEntry[] = [
  ['orchestrator', 'system', 'decision.requested', 'run', 'run_01J9VID', 1],
  ['Priya', 'user', 'decision.resolved', 'decision', 'dec_REV', 11],
  ['Marco', 'user', 'policy.changed', 'policy', 'production-approvals', 120],
  ['Jonas', 'user', 'pack.install_requested', 'pack', 'pack_podcast', 125],
  ['Priya', 'user', 'run.created', 'run', 'run_01J9DECK', 150],
  ['Schedule', 'schedule', 'run.created', 'run', 'run_01J9SCAN', 905],
].map(([name, type, action, st, sid, ago], i): AuditEntry => ({
  id: `aud_${i}`,
  at: at(ago as number),
  actor: { type: type as 'user', id: String(name).toLowerCase(), name: String(name) },
  action: action as string,
  subject: { type: st as string, id: sid as string },
}));
