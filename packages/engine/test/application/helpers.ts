import type { ActorRef, Pack } from '@kramahq/contract';
import { createEngine, type Engine } from '../../src/index.js';
import { createFakePorts, type FakePorts } from '../../src/testing/index.js';

export const priya: ActorRef = { type: 'user', id: 'u_priya', name: 'Priya' };
export const arjun: ActorRef = { type: 'user', id: 'u_arjun', name: 'Arjun' };

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

export interface Harness {
  p: FakePorts;
  engine: Engine;
}

export function setup(pack: Pack = authorReviewerPack(), policy = {}): Harness {
  const p = createFakePorts([pack]);
  return { p, engine: createEngine(p, policy) };
}

export const ok = { status: 'success' as const, reason: 'fine', gating: 'continue' as const };
export const loop = (feedback = 'fix it') => ({
  status: 'partial' as const,
  reason: 'issues',
  gating: 'loop_back' as const,
  loopTarget: 'draft',
  feedback,
});

export const types = async (p: FakePorts, runId?: string) =>
  (await p.events.read(runId ? { topics: [`run:${runId}`] } : {})).map((e) => e.type);
