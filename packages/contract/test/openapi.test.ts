import { describe, expect, it } from 'vitest';
import { API_VERSION, CUT1_ROUTES, ROUTES, buildOpenApi } from '../src/index.js';

const doc = buildOpenApi('0.0.0');

const refs = (node: unknown, out: string[] = []): string[] => {
  if (Array.isArray(node)) node.forEach((n) => refs(n, out));
  else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === '$ref' && typeof v === 'string') out.push(v);
      else refs(v, out);
    }
  }
  return out;
};

describe('openapi', () => {
  it('is OpenAPI 3.1 for v1', () => {
    expect(doc.openapi).toBe('3.1.0');
    expect(API_VERSION).toBe('v1');
    expect(doc.servers[0]?.url).toBe('/api/v1');
  });

  it('has one operation per route with unique operationIds', () => {
    const ids = ROUTES.map((r) => r.operationId);
    expect(new Set(ids).size).toBe(ids.length);
    const ops = Object.values(doc.paths).flatMap((p) => Object.values(p));
    expect(ops.length).toBe(ROUTES.length);
  });

  it('every $ref resolves to a component schema', () => {
    const names = new Set(Object.keys(doc.components.schemas));
    const missing = refs(doc).filter((r) => !names.has(r.replace('#/components/schemas/', '')));
    expect(missing).toEqual([]);
  });

  it('covers the Cut 1 endpoints', () => {
    for (const must of [
      'listRuns',
      'getRun',
      'listDecisions',
      'resolveDecision',
      'getRunCost',
      'listActivity',
      'getWorkspaceTree',
      'getCapabilities',
      'streamEvents',
    ]) {
      expect(
        CUT1_ROUTES.some((r) => r.operationId === must),
        must,
      ).toBe(true);
    }
  });

  it('does not forbid unknown properties (additive v1)', () => {
    expect(JSON.stringify(doc)).not.toContain('"additionalProperties":false');
  });
});
