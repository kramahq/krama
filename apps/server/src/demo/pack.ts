import type { AgentDefinition, BackendDescriptorInput, Pack } from '@kramahq/contract';
import type { DefinitionBundle } from '../compose.js';

/** The demo backend is data only: the runtime runs the scripted agent instead of a real wrapper. */
export const DEMO_BACKEND: BackendDescriptorInput = {
  id: 'a2a-demo',
  label: 'Scripted demo agent',
  package: {
    name: 'krama-demo-agent',
    bin: 'krama-demo-agent',
    install: 'built into @kramahq/server',
  },
  launch: { defaultPort: 4999, startupTimeoutMs: 15_000 },
  providerKey: 'demo',
  mapping: { workspace: 'cwd', systemPrompt: 'persona' },
  options: [
    { key: 'cwd', type: 'string', description: 'Workspace.' },
    { key: 'persona', type: 'string', description: 'System prompt.' },
    { key: 'script', type: 'string', description: 'Which scripted persona to play.' },
  ],
  env: [],
  prerequisites: [],
  capabilities: { canOrchestrate: true, cost: 'partial', sideband: true, resumableSessions: false },
};

const definition = (role: string, script: string, description: string): AgentDefinition => ({
  id: `${role}/default`,
  role,
  variant: 'default',
  name: role,
  description,
  backend: { wrapper: 'a2a-demo', options: { script } },
  skills: [],
  mcpServers: [],
  permissions: { tools: {} },
  memory: { enabled: false, scopes: [] },
  capabilities: [role],
  source: { type: 'local' },
  links: {},
});

export const DEMO_DEFINITIONS: DefinitionBundle[] = [
  { definition: definition('orchestrator', 'orchestrator', 'Plans and drives the run') },
  { definition: definition('author', 'author', 'Writes the release notes') },
  { definition: definition('reviewer', 'reviewer', 'Reviews the release notes') },
];

/** Two roles: an author drafts, a reviewer evaluates (loop back to the draft, at most twice), then one human gate. */
export const DEMO_PACK: Pack = {
  id: 'pack_demo' as Pack['id'],
  name: 'Release notes (demo)',
  version: '0.1.0',
  description: 'An author and a reviewer with one revision loop and a human approval.',
  tags: ['demo'],
  status: 'installed',
  trust: 'trusted',
  source: { type: 'git', url: 'builtin:demo', ref: 'main', sha: '0000000' },
  engine: { requires: '>=0.0.0', compatible: true },
  methodology: {
    id: 'draft-review',
    name: 'Draft and review',
    phases: [
      { id: 'draft', label: 'Draft', roles: ['author'], dependsOn: [] },
      { id: 'review', label: 'Review', roles: ['reviewer'], dependsOn: ['draft'] },
    ],
    gates: [
      {
        afterPhase: 'review',
        kind: 'approval',
        policy: 'human_required',
        label: 'Publish approval',
      },
    ],
    evaluators: [{ producer: 'author', evaluator: 'reviewer', maxLoops: 2 }],
  },
  roster: [
    { role: 'author', select: { definitionId: 'author/default' } },
    { role: 'reviewer', select: { definitionId: 'reviewer/default' } },
  ],
  inputsSchema: {},
  ui: {},
  artifactTypes: [],
  requirements: { mcpServers: [], secrets: [], workItemSources: [] },
  permissions: [],
  memoryScopes: [],
  tests: { suites: 0 },
  links: {},
} as Pack;
