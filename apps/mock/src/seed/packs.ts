import type { AgentDefinition, Pack } from '@kramahq/contract';
import { fixture } from '../fixtures.js';

const base = fixture<Pack>('pack-aidlc.json');

interface PackSpec {
  id: string;
  name: string;
  version: string;
  sha: string;
  trust: Pack['trust'];
  description: string;
  runs: number;
  successRate: number;
  tags: string[];
  phases: [id: string, label: string, roles: string[]][];
  gates?: [afterPhase: string, label: string, kind?: 'review' | 'approval'][];
  fields: Record<string, unknown>;
  terminology?: Record<string, string>;
}

const mk = (s: PackSpec): Pack => ({
  ...base,
  id: `pack_${s.id}`,
  name: s.name,
  version: s.version,
  description: s.description,
  tags: s.tags,
  trust: s.trust,
  source: {
    type: 'git',
    url: 'https://github.com/kramahq/krama-packs',
    ref: `v${s.version}`,
    sha: s.sha,
    path: s.id,
  },
  methodology: {
    id: s.id,
    name: s.name,
    phases: s.phases.map(([id, label, roles], i) => ({
      id,
      label,
      roles,
      dependsOn: i ? [s.phases[i - 1]![0]] : [],
    })),
    gates: (s.gates ?? []).map(([afterPhase, label, kind]) => ({
      afterPhase,
      label,
      kind: kind ?? 'review',
      policy: 'human_required' as const,
    })),
    evaluators: [],
  },
  roster: s.phases
    .flatMap(([, , roles]) => roles)
    .map((role) => ({ role, select: { capabilities: [role] } })),
  inputsSchema: { type: 'object', properties: s.fields },
  ui: { terminology: s.terminology ?? { run: 'Run', runs: 'Runs' } },
  artifactTypes: base.artifactTypes,
  requirements: { mcpServers: [], secrets: [], workItemSources: [] },
  permissions: [],
  memoryScopes: [{ scope: 'project', access: 'propose' }],
  tests: { suites: 1, lastRun: { status: 'passed', at: '2026-10-02T21:10:00Z' } },
  stats: { runs: s.runs, successRate: s.successRate, avgCost: null },
  links: {},
});

const text = (title: string, d?: string) => ({
  type: 'string',
  title,
  ...(d ? { default: d } : {}),
});

export const packs: Pack[] = [
  { ...base, stats: { runs: 42, successRate: 0.88, avgCost: { amount: 21.4, currency: 'USD' } } },
  mk({
    id: 'video',
    name: 'Explainer Video',
    version: '1.2.0',
    sha: '41be0d7',
    trust: 'trusted',
    runs: 17,
    successRate: 0.76,
    description:
      'Research, script, voice, render and edit a short explainer, with a critic loop on the cut.',
    tags: ['media', 'video'],
    phases: [
      ['research', 'Research', ['researcher']],
      ['script', 'Script', ['scriptwriter']],
      ['voice', 'Voice', ['voice']],
      ['video', 'Video', ['video']],
      ['edit', 'Edit', ['editor']],
      ['critic', 'Critic', ['critic']],
    ],
    gates: [['script', 'Script sign-off']],
    fields: {
      topic: text('Topic'),
      length: text('Length', '90 seconds'),
      voice: text('Voice', 'Ava · warm'),
    },
  }),
  mk({
    id: 'deck',
    name: 'Deck Studio',
    version: '0.9.1',
    sha: 'c71d2e0',
    trust: 'verified',
    runs: 29,
    successRate: 0.91,
    description: 'Turn a brief and source documents into a reviewed slide deck with speaker notes.',
    tags: ['documents', 'slides'],
    phases: [
      ['brief', 'Brief', ['strategist']],
      ['outline', 'Outline', ['writer']],
      ['design', 'Design', ['slide-designer', 'critic']],
      ['polish', 'Polish', ['editor']],
    ],
    gates: [
      ['outline', 'Outline sign-off'],
      ['design', 'Slide review'],
    ],
    fields: { brief: text('Brief'), brandKit: text('Brand kit', 'Acme 2026') },
  }),
  mk({
    id: 'techdebt',
    name: 'Tech-debt Scanner',
    version: '2.1.0',
    sha: 'c0de4f1',
    trust: 'trusted',
    runs: 118,
    successRate: 0.97,
    description: 'Scan repositories for vulnerable dependencies and open fix pull requests.',
    tags: ['sdlc', 'maintenance'],
    phases: [
      ['scan', 'Scan', ['scanner']],
      ['triage', 'Triage', ['triager']],
      ['patch', 'Patch', ['developer']],
    ],
    fields: { repo: text('Repository'), severity: text('Severity floor', 'High') },
  }),
  {
    ...mk({
      id: 'podcast',
      name: 'Podcast Producer',
      version: '0.1.0',
      sha: 'bad1dea',
      trust: 'untrusted',
      runs: 0,
      successRate: 0,
      description: 'Produce a podcast episode from notes (community pack).',
      tags: ['media', 'audio'],
      phases: [
        ['plan', 'Plan', ['producer']],
        ['record', 'Record', ['voice']],
      ],
      fields: { notes: text('Notes') },
    }),
    status: 'available',
    source: {
      type: 'git',
      url: 'https://github.com/kai-dev/podcast-pack',
      ref: 'main',
      sha: 'bad1dea',
    },
    permissions: [
      {
        id: 'n1',
        kind: 'network',
        subject: 'api.tts-provider.example',
        risk: 'medium',
        requestedBy: 'voice',
      },
      {
        id: 's1',
        kind: 'secret_ref',
        subject: 'TTS_API_KEY',
        risk: 'medium',
        requestedBy: 'voice',
      },
    ],
    tests: { suites: 0, lastRun: { status: 'never' } },
  },
];

const def = (
  role: string,
  variant: string,
  wrapper: string,
  model: string,
  caps: string[],
  packId: `pack_${string}` = 'pack_aidlc',
): AgentDefinition => ({
  id: `${role}/${variant}`,
  role,
  variant,
  name: `${role[0]!.toUpperCase()}${role.slice(1)}`,
  description: `${role} agent (${variant}).`,
  backend: { wrapper, model },
  skills: [],
  mcpServers: [],
  permissions: { tools: { shell: 'ask', write: 'allow', network: 'off' } },
  memory: { enabled: true, scopes: [{ scope: 'project', access: 'propose' }] },
  capabilities: caps,
  source: { type: 'pack', packId, sha: '9f3c2ab' },
  links: {},
});

export const definitions: AgentDefinition[] = [
  def('analyst', 'default', 'a2a-claude', 'claude-sonnet-5-5', ['requirements']),
  def('architect', 'default', 'a2a-codex', 'gpt-5-codex', ['design', 'architecture']),
  def('developer', 'default', 'a2a-codex', 'gpt-5-codex', ['code', 'tests']),
  def('reviewer', 'default', 'a2a-claude', 'claude-opus-5-5', ['code-review']),
  def('qa', 'default', 'a2a-claude', 'claude-sonnet-5-5', ['testing']),
  def('orchestrator', 'default', 'a2a-codex', 'gpt-5-codex', ['orchestrate']),
  def('slide-designer', 'default', 'a2a-antigravity', 'gemini-3', ['slides'], 'pack_deck'),
];
