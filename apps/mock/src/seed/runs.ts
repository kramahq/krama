import type { ActivityItem, Artifact, Decision, Phase, Run, Step } from '@kramahq/contract';
import { packs } from './packs.js';

export const NOW = Date.now();
const at = (minutesAgo: number): string => new Date(NOW - minutesAgo * 60_000).toISOString();
const usd = (amount: number | null) =>
  amount === null ? null : { amount, currency: 'USD' as const };

type PS = 'done' | 'active' | 'await' | 'pend' | 'fail' | 'loop';
const PHASE_STATUS: Record<PS, Phase['status']> = {
  done: 'completed',
  active: 'active',
  await: 'awaiting_decision',
  pend: 'pending',
  fail: 'failed',
  loop: 'looping',
};

interface RunSpec {
  id: string;
  title: string;
  pack: string;
  status: Run['status'];
  mode: Run['mode'];
  ref?: string;
  spent: number | null;
  max: number;
  by: string;
  updated: number;
  started: number;
  ph: PS[];
  orch: [backend: string, model: string];
  summary: string;
  reason?: string;
  project?: string;
  pending?: number;
  iteration?: number[];
  phaseCosts?: (number | null)[];
}

const specs: RunSpec[] = [
  {
    id: 'run_01J9AIDLC',
    title: 'Customer notifications service',
    pack: 'aidlc',
    status: 'awaiting_decision',
    mode: 'review',
    ref: 'PAY-214',
    spent: 6.82,
    max: 40,
    by: 'Priya',
    updated: 2,
    started: 200,
    ph: ['await', 'pend', 'pend'],
    orch: ['a2a-codex', 'gpt-5-codex'],
    project: 'payments',
    pending: 2,
    phaseCosts: [6.82, null, null],
    summary:
      'Inception is done. The analyst drafted requirements from PAY-214 and the architect split the work into 4 units across 3 bolts. Three questions are open for the team: log retention, opt-out model and regional SMS rules. Construction starts once the team validates.',
  },
  {
    id: 'run_01J9VID',
    title: 'Explainer: How instant refunds work',
    pack: 'video',
    status: 'running',
    mode: 'autopilot',
    spent: 24.6,
    max: 30,
    by: 'Jonas',
    updated: 0,
    started: 60,
    ph: ['done', 'done', 'done', 'active', 'pend', 'pend'],
    orch: ['a2a-claude', 'claude-opus-5-5'],
    pending: 1,
    iteration: [1, 1, 1, 2, 0, 0],
    phaseCosts: [2.1, 1.8, 4.3, 14.2, null, null],
    project: 'personal',
    summary:
      'Research, script and voiceover are final. The critic found the voiceover drifting from the visuals at 00:42, so the video phase is re-rendering clips 3–5 (iteration 2 of 3). Spend is at 82% of the cap.',
  },
  {
    id: 'run_01J9DECK',
    title: 'Q3 board update',
    pack: 'deck',
    status: 'awaiting_decision',
    mode: 'review',
    ref: 'BRD-Q3',
    spent: 3.1,
    max: 15,
    by: 'Priya',
    updated: 40,
    started: 150,
    ph: ['done', 'done', 'await', 'pend'],
    orch: ['a2a-claude', 'claude-sonnet-5-5'],
    pending: 1,
    project: 'shp',
    phaseCosts: [0.4, 0.9, 1.8, null],
    summary:
      'Version 2 of the deck is ready: revenue slides merged, a churn cohort chart added and the appendix cut to 4 slides. Waiting on slide review before polish.',
  },
  {
    id: 'run_01J9PART',
    title: 'Partner onboarding API',
    pack: 'aidlc',
    status: 'running',
    mode: 'review',
    ref: 'PAY-198',
    spent: 18.2,
    max: 40,
    by: 'Arun',
    updated: 6,
    started: 1200,
    ph: ['done', 'active', 'pend'],
    orch: ['a2a-codex', 'gpt-5-codex'],
    pending: 1,
    project: 'payments',
    phaseCosts: [5.4, 12.8, null],
    iteration: [1, 2, 0],
    summary:
      'Bolt 2 is implementing token issuance. Developer-1 shipped a patch for scoped tokens; developer-2 is blocked on whether partners use API keys or OAuth client credentials.',
  },
  {
    id: 'run_01J9PRICE',
    title: 'Pricing page refresh',
    pack: 'aidlc',
    status: 'awaiting_decision',
    mode: 'review',
    ref: 'WEB-77',
    spent: 27.4,
    max: 40,
    by: 'Lena',
    updated: 60,
    started: 3000,
    ph: ['done', 'done', 'await'],
    orch: ['a2a-claude', 'claude-opus-5-5'],
    pending: 1,
    project: 'shp',
    phaseCosts: [6, 21.4, null],
    summary:
      'Construction finished in 3 bolts and staging checks pass. Production deploy needs approval.',
  },
  {
    id: 'run_01J9MOB',
    title: 'Mobile wallet top-up',
    pack: 'aidlc',
    status: 'paused',
    mode: 'autopilot',
    ref: 'PAY-230',
    spent: 12.1,
    max: 40,
    by: 'Arun',
    updated: 60,
    started: 300,
    ph: ['done', 'active', 'pend'],
    orch: ['a2a-codex', 'gpt-5-codex'],
    project: 'payments',
    phaseCosts: [4, 8.1, null],
    reason: 'Paused by Arun',
    summary: 'Paused during Construction.',
  },
  {
    id: 'run_01J9TEASE',
    title: 'Launch teaser (30 s)',
    pack: 'video',
    status: 'failed',
    mode: 'autopilot',
    spent: 9.75,
    max: 20,
    by: 'Jonas',
    updated: 1400,
    started: 1500,
    ph: ['done', 'done', 'done', 'fail', 'pend', 'pend'],
    orch: ['a2a-claude', 'claude-opus-5-5'],
    project: 'personal',
    phaseCosts: [1, 1, 2, 5.75, null, null],
    reason: 'Render timed out after 3 retries',
    summary: 'Render timed out after 3 retries. Trace id tr_8f21c0.',
  },
  {
    id: 'run_01J9SKO',
    title: 'Sales kickoff deck',
    pack: 'deck',
    status: 'blocked',
    mode: 'review',
    ref: 'SKO-26',
    spent: null,
    max: 15,
    by: 'Marco',
    updated: 180,
    started: 225,
    ph: ['done', 'active', 'pend', 'pend'],
    orch: ['a2a-antigravity', 'gemini-3'],
    project: 'shp',
    phaseCosts: [null, null, null, null],
    reason: 'Outline needs the brand kit, which is not attached',
    summary:
      'Outline is waiting for a brand kit. This backend does not report cost, so spend shows as not reported.',
  },
  {
    id: 'run_01J9RESUME',
    title: 'Webhook retries for ledger',
    pack: 'aidlc',
    status: 'interrupted',
    mode: 'review',
    ref: 'PAY-241',
    spent: 3.3,
    max: 40,
    by: 'Arun',
    updated: 25,
    started: 90,
    ph: ['done', 'active', 'pend'],
    orch: ['a2a-codex', 'gpt-5-codex'],
    project: 'payments',
    phaseCosts: [3.3, null, null],
    reason: 'Server restarted mid-phase; resume to continue',
    summary:
      'Interrupted when the server restarted. No work was lost; resume continues from the last step.',
  },
  {
    id: 'run_01J9SCAN',
    title: 'Nightly dependency scan',
    pack: 'techdebt',
    status: 'completed',
    mode: 'autopilot',
    ref: 'payments-service',
    spent: 1.92,
    max: 5,
    by: 'Schedule',
    updated: 900,
    started: 905,
    ph: ['done', 'done', 'done'],
    orch: ['a2a-codex', 'gpt-5-codex'],
    project: 'payments',
    phaseCosts: [0.4, 0.5, 1.02],
    summary: 'Completed: 2 high, 0 critical advisories; 2 fix PRs opened.',
  },
];

const packById = (key: string) => packs.find((p) => p.id === `pack_${key}`)!;

export const runs: Run[] = specs.map((s): Run => {
  const pack = packById(s.pack);
  const phases: Phase[] = pack.methodology.phases.map((t, i) => {
    const st = s.ph[i] ?? 'pend';
    const cost = s.phaseCosts?.[i];
    return {
      id: t.id,
      label: t.label,
      kind: t.kind,
      agentRoles: t.roles,
      dependsOn: t.dependsOn,
      status: PHASE_STATUS[st],
      iteration: s.iteration?.[i] ?? (st === 'pend' ? 0 : 1),
      ...(st === 'done'
        ? {
            outcome: {
              status: 'success' as const,
              reason: `${t.label} complete`,
              gating: 'continue' as const,
            },
          }
        : {}),
      ...(st === 'fail'
        ? {
            outcome: {
              status: 'failure' as const,
              reason: s.reason ?? 'Failed',
              gating: 'halt' as const,
            },
          }
        : {}),
      ...(cost !== undefined ? { cost: usd(cost) } : {}),
      ...(st !== 'pend' ? { startedAt: at(s.started - i * 10) } : {}),
    };
  });
  const current = phases
    .filter((p) => ['active', 'awaiting_decision', 'looping'].includes(p.status))
    .map((p) => p.id);
  return {
    id: s.id as Run['id'],
    title: s.title,
    input: { text: s.title },
    pack: { id: pack.id, version: pack.version, sha: pack.source.sha },
    ...(s.project ? { projectId: `proj_${s.project}` as const } : {}),
    ...(s.ref ? { workItem: { source: s.ref.includes('-') ? 'jira' : 'text', ref: s.ref } } : {}),
    status: s.status,
    ...(s.reason ? { statusReason: s.reason } : {}),
    mode: s.mode,
    orchestrator: { definitionId: 'orchestrator/default', backend: s.orch[0], model: s.orch[1] },
    budget: {
      max: { amount: s.max, currency: 'USD' },
      spent: usd(s.spent),
      warnAtPct: 80,
      onExceed: 'pause',
    },
    currentPhaseIds: current,
    phases,
    pendingDecisions: s.pending ?? 0,
    trigger:
      s.by === 'Schedule'
        ? { type: 'schedule', scheduleId: 'sch_nightly_deps' }
        : { type: 'manual' },
    labels: s.project ? [s.project] : [],
    createdBy:
      s.by === 'Schedule'
        ? { type: 'schedule', id: 'sch_nightly_deps', name: 'Schedule' }
        : { type: 'user', id: `u_${s.by.toLowerCase()}`, name: s.by },
    createdAt: at(s.started),
    updatedAt: at(s.updated),
    startedAt: at(s.started - 1),
    ...(['completed', 'failed', 'stopped'].includes(s.status) ? { endedAt: at(s.updated) } : {}),
    summary: s.summary,
    links: {},
  };
});

// ---- Decisions -------------------------------------------------------------
const opt = (
  id: string,
  label: string,
  style: 'primary' | 'danger' | 'neutral',
  effect: string,
  input?: Decision['options'][number]['input'],
) => ({ id, label, style, effect, ...(input ? { input } : {}) });
const note = { required: true, label: 'Your notes', kind: 'text' as const };

export const decisions: Decision[] = [
  {
    id: 'dec_REV',
    kind: 'review',
    status: 'pending',
    runId: 'run_01J9AIDLC',
    phaseId: 'inception',
    title: 'Validate Inception output: Mob Elaboration',
    question:
      'The analyst proposes **4 units of work** and asks **3 open questions**. Validate before Construction starts.',
    context: {
      artifacts: ['art_req1', 'art_uow1'],
      summary: 'Channels: email, SMS, push. Open: retention period, opt-out model, regional rules.',
    },
    options: [
      opt(
        'approve',
        'Approve and start Construction',
        'primary',
        'Construction starts with 3 bolts',
      ),
      opt('changes', 'Request changes', 'neutral', 'Inception re-runs with your notes', note),
      opt('reject', 'Reject', 'danger', 'Run stops; artifacts are kept'),
    ],
    need: 2,
    approvals: [
      { optionId: 'approve', by: { type: 'user', id: 'u_priya', name: 'Priya' }, at: at(11) },
    ],
    assignees: { roles: ['approver'] },
    deadline: at(-1260),
    onTimeout: 'expire',
    createdAt: at(12),
    links: {},
  },
  {
    id: 'dec_ACCESS',
    kind: 'access',
    status: 'pending',
    runId: 'run_01J9PART',
    phaseId: 'construction',
    title: 'developer-2 asks to read ~/Downloads/partner-spec.pdf',
    question: 'Agent **developer-2** wants to read a file outside the run workspace.',
    access: { path: '~/Downloads/partner-spec.pdf', agent: 'developer-2', mode: 'read' },
    options: [
      opt('allow_once', 'Allow once', 'primary', 'Grants this single read'),
      opt('allow_project', 'Allow for project', 'neutral', 'Remembered for the payments project'),
      opt('deny', 'Deny', 'danger', 'The agent continues without the file'),
    ],
    need: 1,
    createdAt: at(3),
    links: {},
  },
  {
    id: 'dec_INPUT',
    kind: 'input',
    status: 'pending',
    runId: 'run_01J9PART',
    phaseId: 'construction',
    title: 'Which partner auth flow?',
    question:
      'developer-2 needs to know whether partners authenticate with API keys or OAuth 2.0 client credentials.',
    context: { artifacts: ['art_patch', 'art_preq'] },
    options: [
      opt('oauth', 'OAuth client credentials', 'primary', 'Matches the patch already in review'),
      opt('keys', 'API keys', 'neutral', 'developer-1 patch will be reverted'),
      opt('both', 'Support both', 'neutral', 'Adds a unit of work to bolt 3'),
    ],
    need: 1,
    createdAt: at(6),
    links: {},
  },
  {
    id: 'dec_BUDGET',
    kind: 'budget',
    status: 'pending',
    runId: 'run_01J9VID',
    phaseId: 'video',
    title: 'Budget at 82%: raise the cap?',
    question: 'Spend is $24.60 against a $30 cap. The re-render and edit phases are left.',
    context: { artifacts: ['art_clips'] },
    options: [
      opt('raise', 'Raise cap to $40', 'primary', 'Run continues to Edit and Critic'),
      opt('cap', 'Keep cap, skip Critic loop', 'neutral', 'Saves a phase'),
      opt('stop', 'Stop after this render', 'danger', 'Delivers clips-v2 as is'),
    ],
    need: 1,
    createdAt: at(1),
    links: {},
  },
  {
    id: 'dec_SLIDES',
    kind: 'review',
    status: 'pending',
    runId: 'run_01J9DECK',
    phaseId: 'design',
    title: 'Slide review: Q3 board update v2',
    question: '14 slides from outline v3. The critic flagged one minor issue on slide 9.',
    context: { artifacts: ['art_deck1', 'art_deckout'] },
    options: [
      opt('approve', 'Approve and polish', 'primary', 'Speaker notes and final export'),
      opt('changes', 'Request changes', 'neutral', 'Design re-runs with your notes', note),
    ],
    need: 1,
    createdAt: at(40),
    links: {},
  },
  {
    id: 'dec_PROD',
    kind: 'approval',
    status: 'pending',
    runId: 'run_01J9PRICE',
    phaseId: 'operations',
    title: 'Approve production deploy',
    question: 'Staging checks pass for the pricing page refresh. Two approvers are required.',
    options: [
      opt('approve', 'Approve deploy', 'primary', 'Deploys to production'),
      opt('reject', 'Hold', 'danger', 'Run stays in Operations', {
        required: true,
        label: 'Reason',
        kind: 'text',
      }),
    ],
    need: 2,
    createdAt: at(60),
    links: {},
  },
  {
    id: 'dec_PACK',
    kind: 'consent',
    status: 'pending',
    subject: { type: 'pack', id: 'pack_podcast' },
    title: 'Install Podcast Producer 0.1.0',
    question:
      'Jonas asked to install an **untrusted** pack from github.com/kai-dev/podcast-pack. It requests network access and one secret.',
    options: [
      opt('review', 'Review permissions', 'primary', 'Opens the consent screen'),
      opt('decline', 'Decline', 'neutral', 'Jonas is notified'),
    ],
    need: 1,
    createdAt: at(120),
    links: {},
  },
  {
    id: 'dec_MEM',
    kind: 'memory',
    status: 'pending',
    subject: { type: 'memory', id: 'mem_01J9PROP' },
    runId: 'run_01J9PART',
    title: 'Add to project memory',
    question:
      'reviewer-1 proposes: “Partner-facing APIs use OAuth 2.0 client credentials with scoped tokens.”',
    options: [
      opt('accept', 'Accept', 'primary', 'Future runs in this project read it'),
      opt('reject', 'Reject', 'neutral', 'Proposal is discarded'),
    ],
    need: 1,
    createdAt: at(20),
    links: {},
  },
  {
    id: 'dec_OLD',
    kind: 'review',
    status: 'resolved',
    runId: 'run_01J9SCAN',
    title: 'Review scan findings',
    question: 'Two high advisories found.',
    options: [opt('approve', 'Approve patches', 'primary', 'Open PRs')],
    need: 1,
    createdAt: at(910),
    resolvedAt: at(906),
    resolution: {
      optionId: 'approve',
      by: { type: 'user', id: 'u_priya', name: 'Priya' },
      at: at(906),
    },
    links: {},
  },
];

// ---- Artifacts -------------------------------------------------------------
interface ArtSpec {
  id: string;
  run: string;
  phase: string;
  name: string;
  type: string;
  media: string;
  version: number;
  status: Artifact['status'];
  producer: string;
  content?: string;
  meta?: Record<string, unknown>;
  size?: number;
}
const md = (...lines: string[]) => lines.join('\n');
const artSpecs: ArtSpec[] = [
  {
    id: 'art_req1',
    run: 'run_01J9AIDLC',
    phase: 'inception',
    name: 'requirements.md',
    type: 'requirements',
    media: 'text/markdown',
    version: 1,
    status: 'in_review',
    producer: 'analyst-1',
    content: md(
      '# Customer notifications service',
      '',
      'Send transactional notifications to payment customers over email, SMS and push, respecting per-customer channel preferences.',
      '',
      '## Functional requirements',
      '- **FR-1** Deliver payment receipts within 30 seconds of settlement.',
      '- **FR-2** Honour per-channel opt-out.',
      '- **FR-3** Retry failed deliveries with backoff.',
      '',
      '## Open questions',
      '1. How long are delivery logs retained?',
      '2. Is opt-out per channel or global?',
      '3. Which regions restrict SMS content?',
    ),
  },
  {
    id: 'art_uow1',
    run: 'run_01J9AIDLC',
    phase: 'inception',
    name: 'units-of-work.md',
    type: 'requirements',
    media: 'text/markdown',
    version: 1,
    status: 'in_review',
    producer: 'architect-1',
    content: md(
      '# Units of work',
      '',
      '- **U1** Preferences API and storage (bolt 1)',
      '- **U2** Channel adapters for email, SMS and push (bolts 1–2)',
      '- **U3** Delivery log and retries (bolt 2)',
      '- **U4** Admin tooling (bolt 3)',
    ),
  },
  {
    id: 'art_script',
    run: 'run_01J9VID',
    phase: 'script',
    name: 'script.md',
    type: 'script',
    media: 'text/markdown',
    version: 2,
    status: 'final',
    producer: 'scriptwriter-1',
    content: md(
      '# How instant refunds work',
      '',
      '**Scene 1 · 0:00–0:14** You tap “refund”. What happens next takes less time than reading this sentence.',
      '',
      '**Scene 2 · 0:14–0:42** Your bank and the merchant’s bank agree on the amount through the card network.',
    ),
  },
  {
    id: 'art_vo',
    run: 'run_01J9VID',
    phase: 'voice',
    name: 'voiceover.mp3',
    type: 'voiceover',
    media: 'audio/mpeg',
    version: 1,
    status: 'final',
    producer: 'voice-1',
    size: 1_500_000,
    meta: { durationSeconds: 94, voice: 'Ava · warm' },
  },
  {
    id: 'art_clips',
    run: 'run_01J9VID',
    phase: 'video',
    name: 'clips-v2.mp4',
    type: 'clips',
    media: 'video/mp4',
    version: 2,
    status: 'draft',
    producer: 'video-1',
    size: 212_000_000,
    meta: { durationSeconds: 94, resolution: '1920x1080' },
  },
  {
    id: 'art_deckout',
    run: 'run_01J9DECK',
    phase: 'outline',
    name: 'outline.md',
    type: 'outline',
    media: 'text/markdown',
    version: 3,
    status: 'final',
    producer: 'writer-1',
    content: md(
      '# Q3 board update · outline v3',
      '',
      '1. Headline: revenue +18% QoQ, ahead of plan',
      '2. Revenue by segment',
      '3. Churn cohorts (new)',
      '4. Cost and runway',
    ),
  },
  {
    id: 'art_deck1',
    run: 'run_01J9DECK',
    phase: 'design',
    name: 'Q3-board-update.pptx',
    type: 'slide-deck',
    media: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    version: 2,
    status: 'in_review',
    producer: 'slide-designer-1',
    size: 4_800_000,
    meta: { slides: 14, aspect: '16:9' },
  },
  {
    id: 'art_preq',
    run: 'run_01J9PART',
    phase: 'inception',
    name: 'requirements.md',
    type: 'requirements',
    media: 'text/markdown',
    version: 1,
    status: 'final',
    producer: 'analyst-1',
    content: md(
      '# Partner onboarding API',
      '',
      'Partners self-register, receive credentials and call the payments API with scoped tokens.',
      '',
      '## Open question',
      '> API keys or OAuth 2.0 client credentials?',
    ),
  },
  {
    id: 'art_patch',
    run: 'run_01J9PART',
    phase: 'construction',
    name: 'bolt-2-oauth.patch',
    type: 'patch',
    media: 'text/x-diff',
    version: 1,
    status: 'in_review',
    producer: 'developer-1',
    content: md(
      '--- a/src/auth/clientCredentials.ts',
      '+++ b/src/auth/clientCredentials.ts',
      '@@ -12,6 +12,9 @@',
      ' import { signJwt } from "./jwt";',
      '-export async function issueToken(clientId: string) {',
      '+export async function issueToken(clientId: string, scopes: string[]) {',
      '+  if (!scopes.length) throw new Error("scopes required");',
      '   return signJwt({ sub: clientId });',
      ' }',
    ),
  },
  {
    id: 'art_scan',
    run: 'run_01J9SCAN',
    phase: 'scan',
    name: 'advisories.json',
    type: 'report',
    media: 'application/json',
    version: 1,
    status: 'final',
    producer: 'scanner-1',
    content: JSON.stringify(
      {
        high: 2,
        critical: 0,
        advisories: [
          { id: 'GHSA-xxxx-1', pkg: 'undici', severity: 'high' },
          { id: 'GHSA-xxxx-2', pkg: 'ws', severity: 'high' },
        ],
      },
      null,
      2,
    ),
  },
];

export const artifactContent = new Map<string, { body: Buffer; mediaType: string }>();
export const artifacts: Artifact[] = artSpecs.map((a): Artifact => {
  const body = Buffer.from(a.content ?? `${a.name}: mock binary placeholder (${a.media})`);
  artifactContent.set(a.id, {
    body,
    mediaType: a.content ? `${a.media}; charset=utf-8` : 'application/octet-stream',
  });
  return {
    id: a.id as Artifact['id'],
    runId: a.run as Artifact['runId'],
    phaseId: a.phase,
    name: a.name,
    type: a.type,
    mediaType: a.media,
    size: a.size ?? body.length,
    sha256: `mock${a.id.slice(4)}`,
    version: a.version,
    status: a.status,
    producer: { type: 'agent', id: `agt_${a.producer}`, name: a.producer },
    ...(a.meta ? { meta: a.meta } : {}),
    renditions: [],
    createdAt: at(30),
    links: {
      content: { href: `/api/v1/artifacts/${a.id}/content` },
      versions: { href: `/api/v1/artifacts/${a.id}/versions` },
    },
  };
});

export const phaseArtifacts = (runId: string): string[] =>
  artifacts.filter((a) => a.runId === runId).map((a) => a.id);

// ---- Steps and activity ----------------------------------------------------
export const steps: Step[] = [
  {
    id: 'step_an1',
    runId: 'run_01J9AIDLC',
    phaseId: 'inception',
    agent: { id: 'agt_analyst1', role: 'analyst', backend: 'a2a-claude' },
    summary: 'Drafted requirements.md from PAY-214',
    status: 'completed',
    a2a: { resumed: false },
    cost: usd(3.1),
    usage: [{ unit: 'tokens', quantity: 48210 }],
  },
  {
    id: 'step_ar1',
    runId: 'run_01J9AIDLC',
    phaseId: 'inception',
    agent: { id: 'agt_architect1', role: 'architect', backend: 'a2a-codex' },
    summary: 'Proposed 4 units of work and a 3-bolt plan',
    status: 'completed',
    a2a: { resumed: false },
    cost: usd(3.72),
    usage: [{ unit: 'tokens', quantity: 61800 }],
  },
  {
    id: 'step_vid1',
    runId: 'run_01J9VID',
    phaseId: 'video',
    agent: { id: 'agt_video1', role: 'video', backend: 'a2a-claude' },
    summary: 'Render job clips 3–5',
    status: 'working',
    a2a: { resumed: true },
    async: { jobId: 'job_render_88', progress: 0.62, etaSeconds: 140 },
  },
  {
    id: 'step_dev2',
    runId: 'run_01J9PART',
    phaseId: 'construction',
    agent: { id: 'agt_dev2', role: 'developer', backend: 'a2a-codex' },
    summary: 'Needs a decision: partner auth flow',
    status: 'input_required',
    a2a: { resumed: false },
    cost: null,
  },
];

const act = (
  runId: string,
  rows: [
    min: number,
    agent: string,
    type: ActivityItem['type'],
    text: string,
    extra?: Partial<ActivityItem>,
  ][],
): ActivityItem[] =>
  rows.map(([min, agent, type, text, extra], i) => ({
    id: `act_${runId.slice(-5)}_${i}`,
    at: at(min),
    type,
    runId: runId as ActivityItem['runId'],
    agent: { id: `agt_${agent}`, role: agent.replace(/-\d+$/, ''), backend: 'a2a-codex' },
    text,
    ...extra,
  }));

export const activity: ActivityItem[] = [
  ...act('run_01J9AIDLC', [
    [200, 'orchestrator', 'status', 'Planned 3 phases from ai-dlc@9f3c2ab'],
    [198, 'analyst-1', 'tool_call', 'jira.get_issue PAY-214', { toolName: 'jira.get_issue' }],
    [
      198,
      'analyst-1',
      'tool_result',
      'PAY-214: Customer notifications (12 comments)',
      { toolName: 'jira.get_issue', durationMs: 412 },
    ],
    [
      196,
      'analyst-1',
      'thinking',
      'Comparing the epic against existing notification code paths before drafting requirements.',
    ],
    [190, 'analyst-1', 'artifact', 'requirements.md v1 created'],
    [185, 'architect-1', 'message', 'Asked analyst-1: is push in scope for v1? → yes'],
    [180, 'architect-1', 'artifact', 'units-of-work.md v1 created'],
    [12, 'orchestrator', 'decision', 'Requested review: Mob Elaboration'],
  ]),
  ...act('run_01J9VID', [
    [60, 'orchestrator', 'status', 'Planned 6 phases from explainer-video@41be0d7'],
    [
      40,
      'voice-1',
      'tool_call',
      'tts.synthesize voice=Ava chars=2140',
      { toolName: 'tts.synthesize' },
    ],
    [
      38,
      'voice-1',
      'tool_result',
      'voiceover.mp3 (1:34)',
      { toolName: 'tts.synthesize', durationMs: 18200, cost: usd(4.3) },
    ],
    [10, 'critic-1', 'decision', 'Looped back to Video: voiceover desync at 00:42'],
    [9, 'video-1', 'tool_call', 'render.submit clips=3..5', { toolName: 'render.submit' }],
    [1, 'video-1', 'status', 'Render 62% · ETA 2 m 20 s'],
  ]),
  ...act('run_01J9PART', [
    [300, 'orchestrator', 'status', 'Bolt 2 started: token issuance'],
    [120, 'developer-1', 'tool_call', 'git.apply bolt-2-oauth.patch', { toolName: 'git.apply' }],
    [
      118,
      'developer-1',
      'tool_result',
      'Applied (+5 −2)',
      { toolName: 'git.apply', durationMs: 220 },
    ],
    [60, 'reviewer-1', 'message', 'Cross-backend review: 1 minor finding'],
    [6, 'developer-2', 'status', 'Blocked: waiting for decision on partner auth flow'],
    [
      3,
      'developer-2',
      'tool_call',
      'fs.read ~/Downloads/partner-spec.pdf (outside workspace)',
      { toolName: 'fs.read', isError: false },
    ],
  ]),
];

export const findings: Record<
  string,
  { severity: 'info' | 'minor' | 'major' | 'blocker'; title: string; detail?: string }[]
> = {
  run_01J9VID: [
    {
      severity: 'major',
      title: 'Voiceover desync at 00:42',
      detail: 'critic-1 · looped back to Video',
    },
    { severity: 'minor', title: 'Logo safe-area clipped in scene 4', detail: 'critic-1' },
  ],
  run_01J9DECK: [
    { severity: 'minor', title: 'Slide 9 chart lacks an axis label', detail: 'critic-1' },
  ],
  run_01J9PART: [
    { severity: 'minor', title: 'issueToken does not log rejected scopes', detail: 'reviewer-1' },
  ],
};

// ---- Workspace -------------------------------------------------------------
export const workspaceFiles: Record<string, string> = {
  'src/auth/clientCredentials.ts':
    'import { signJwt } from "./jwt";\n\nexport async function issueToken(clientId: string, scopes: string[]) {\n  if (!scopes.length) throw new Error("scopes required");\n  return signJwt({ sub: clientId, scopes });\n}\n',
  'src/auth/jwt.ts':
    'export function signJwt(claims: Record<string, unknown>): string {\n  return Buffer.from(JSON.stringify(claims)).toString("base64url");\n}\n',
  'src/index.ts': 'export * from "./auth/clientCredentials";\n',
  'package.json': '{\n  "name": "payments-service",\n  "version": "1.4.0"\n}\n',
  'README.md': '# payments-service\n\nSystem of record for payments.\n',
};
