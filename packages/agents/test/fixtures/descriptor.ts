import type { AgentDefinition, BackendDescriptorInput } from '@kramahq/contract';

/** A backend that exists only as data: it is run by the fake wrapper script. */
export const fakeBackend = (
  over: Partial<BackendDescriptorInput> = {},
): BackendDescriptorInput => ({
  id: 'a2a-fake',
  label: 'Fake',
  package: { name: 'a2a-fake', bin: 'a2a-fake', install: 'npm i -g a2a-fake' },
  launch: { defaultPort: 3999, startupTimeoutMs: 5000 },
  providerKey: 'fake',
  mapping: { workspace: 'cwd', systemPrompt: 'persona' },
  options: [
    { key: 'cwd', type: 'string', description: 'Workspace.' },
    { key: 'model', type: 'string', description: 'Model.' },
    { key: 'persona', type: 'string', description: 'Prompt.' },
    { key: 'fake', type: 'object', description: 'Test behaviour.' },
  ],
  env: [{ name: 'FAKE_KEY', description: 'Key', required: false, secret: true }],
  prerequisites: [],
  capabilities: { canOrchestrate: true, cost: 'unknown', sideband: true, resumableSessions: true },
  ...over,
});

export const definition = (
  options: Record<string, unknown> = {},
  over: Partial<AgentDefinition> = {},
): AgentDefinition => ({
  id: 'developer/default',
  role: 'developer',
  variant: 'default',
  name: 'Developer',
  description: 'Dev agent',
  backend: { wrapper: 'a2a-fake', model: 'm-1', options: { fake: options } },
  skills: [],
  mcpServers: [],
  permissions: { tools: {} },
  memory: { enabled: false, scopes: [] },
  capabilities: ['code'],
  source: { type: 'local' },
  links: {},
  ...over,
});
