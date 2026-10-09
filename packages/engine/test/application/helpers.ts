import type { ActorRef, Pack } from '@kramahq/contract';
import { createEngine, type Engine } from '../../src/index.js';
import { authorReviewerPack, createFakePorts, type FakePorts } from '../../src/testing/index.js';

export const priya: ActorRef = { type: 'user', id: 'u_priya', name: 'Priya' };
export const arjun: ActorRef = { type: 'user', id: 'u_arjun', name: 'Arjun' };
export { authorReviewerPack };

export interface Harness {
  p: FakePorts;
  engine: Engine;
}

export function setup(pack: Pack = authorReviewerPack(), policy = {}): Harness {
  const p = createFakePorts([pack]);
  return { p, engine: createEngine(p, policy, { delivery: { sleep: async () => undefined } }) };
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
