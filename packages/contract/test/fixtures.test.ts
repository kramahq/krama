import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  agent,
  agentDefinition,
  artifact,
  backendDescriptor,
  capabilities,
  decision,
  eventEnvelope,
  memoryRecord,
  operation,
  pack,
  problem,
  project,
  run,
  schedule,
} from '../src/index.js';

const dir = fileURLToPath(new URL('../fixtures/', import.meta.url));
const read = (f: string): unknown => JSON.parse(readFileSync(`${dir}${f}`, 'utf8'));

const bindings: Record<string, z.ZodType> = {
  'capabilities.json': capabilities,
  'pack-aidlc.json': pack,
  'run-awaiting-decision.json': run,
  'decision-review.json': decision,
  'decision-access.json': decision,
  'decision-multi-approver.json': decision,
  'artifact-doc.json': artifact,
  'artifact-video.json': artifact,
  'memory-proposal.json': memoryRecord,
  'schedule.json': schedule,
  'project.json': project,
  'agent.json': agent,
  'agent-definition.json': agentDefinition,
  'backend-descriptor.json': backendDescriptor,
  'problem-consent-incomplete.json': problem,
  'operation-preview.json': operation,
};

describe('fixtures', () => {
  it('every fixture file is bound to a schema', () => {
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    const unbound = files.filter((f) => !(f in bindings) && f !== 'events.json');
    expect(unbound).toEqual([]);
  });

  for (const [file, schema] of Object.entries(bindings)) {
    it(`${file} validates`, () => {
      const result = schema.safeParse(read(file));
      expect(
        result.success,
        result.success ? '' : JSON.stringify(result.error.issues, null, 2),
      ).toBe(true);
    });
  }

  it('events.json validates as event envelopes', () => {
    for (const e of read('events.json') as unknown[]) {
      expect(eventEnvelope.safeParse(e).success).toBe(true);
    }
  });

  it('cost may be null (not reported) and is never required to be a number', () => {
    const r = run.parse(read('run-awaiting-decision.json'));
    expect(r.phases?.[0]?.cost).toBeNull();
    const bad = {
      ...(read('run-awaiting-decision.json') as object),
      budget: {
        max: { amount: 1, currency: 'USD' },
        spent: 'n/a',
        warnAtPct: 80,
        onExceed: 'pause',
      },
    };
    expect(run.safeParse(bad).success).toBe(false);
  });

  it('decision need defaults to 1 and access kind carries a path', () => {
    const d = decision.parse({ ...(read('decision-review.json') as object), need: undefined });
    expect(d.need).toBe(1);
    expect(decision.parse(read('decision-access.json')).access?.path).toContain('Downloads');
  });

  it('rejects an unknown run status', () => {
    expect(
      run.safeParse({ ...(read('run-awaiting-decision.json') as object), status: 'nope' }).success,
    ).toBe(false);
  });
});
