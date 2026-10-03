import type { Pack } from '@kramahq/contract';

/** Two-role pack: author drafts, reviewer evaluates (loop back to draft, cap 2), then one human gate. */
export const authorReviewerPack = (over: Partial<Pack['methodology']> = {}): Pack =>
  ({
    id: 'pack_demo',
    name: 'Demo',
    version: '0.1.0',
    description: 'demo',
    tags: [],
    status: 'installed',
    trust: 'trusted',
    source: { type: 'git', url: 'x', ref: 'main', sha: 'abc123' },
    engine: { requires: '>=0.0.0', compatible: true },
    methodology: {
      id: 'demo',
      name: 'Demo',
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
      ...over,
    },
    roster: [],
    inputsSchema: {},
    ui: {},
    artifactTypes: [],
    requirements: { mcpServers: [], secrets: [], workItemSources: [] },
    permissions: [],
    memoryScopes: [],
    tests: { suites: 0 },
    links: {},
  }) as Pack;
