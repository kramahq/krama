import { describe, expect, it } from 'vitest';
import { runDemo } from '../src/demo/run.js';

// These start real child processes (the scripted agents) over a real embedded database, so they are slow on cold CI.
const SLOW = 120_000;

const quiet = { approve: 'auto' as const, out: () => undefined, timeoutMs: 100_000 };
const tokens = (u: { unit: string; quantity: number }[]) =>
  u.find((x) => x.unit === 'tokens')?.quantity ?? 0;

describe('the walking skeleton', () => {
  it(
    'runs a two-role pack to completion with the orchestrator calling workers itself (native)',
    async () => {
      const r = await runDemo({ ...quiet, mode: 'native' });
      expect(r.status).toBe('completed');
      // The reviewer asks for changes once, so both phases take two rounds.
      expect(r.phases).toEqual([
        { id: 'draft', status: 'completed', iteration: 2 },
        { id: 'review', status: 'completed', iteration: 2 },
      ]);
      const text = r.timeline.join('\n');
      expect(text).toContain('author (sub-agent)');
      expect(text).not.toContain('delegate_to_agent');
      expect(text).toContain('decision requested: Publish approval');
      expect(text).toContain('run completed');
      // The orchestrator reports on the A2A stream. The workers, which it calls directly, report to the event sink: Krama
      // sees their tool calls and their usage even though it never relayed a call.
      expect(tokens(r.orchestratorUsage)).toBe(560);
      expect(text).toContain('author called compose');
      expect(text).toContain('reviewer called compose');
      // 2 drafts (200 each) + 2 reviews (190 each), counted once.
      expect(tokens(r.workerUsage)).toBe(780);
    },
    SLOW,
  );

  it(
    'runs the same pack with Krama relaying every delegation (krama) and sees worker usage per step',
    async () => {
      const r = await runDemo({ ...quiet, mode: 'krama' });
      expect(r.status).toBe('completed');
      expect(r.phases.map((p) => [p.id, p.status, p.iteration])).toEqual([
        ['draft', 'completed', 2],
        ['review', 'completed', 2],
      ]);
      const text = r.timeline.join('\n');
      expect(text).toContain('delegate_to_agent');
      expect(text).toContain('step completed in review');
      expect(tokens(r.orchestratorUsage)).toBe(560);
      // 2 drafts (200 each) + 2 reviews (190 each)
      expect(tokens(r.workerUsage)).toBe(780);
    },
    SLOW,
  );
});

describe('the run transcript', () => {
  // The runner closes the run's transcript when the run ends (it writes what is missing and a summary). Wait for it to,
  // rather than doing it here, so the test shows that it happens.
  const readChain = async (k: import('../src/index.js').Krama, runId: string) => {
    for (let i = 0; i < 100; i++) {
      const records = await k.ports.ledger!.read(`run:${runId}`, { limit: 5000 });
      if (records.some((r) => r.kind === 'capture.summary')) return records;
      await new Promise((r) => setTimeout(r, 50));
    }
    return k.ports.ledger!.read(`run:${runId}`, { limit: 5000 });
  };

  it.each(['native', 'krama'] as const)(
    'keeps every message and tool payload in full, with secrets masked, in a chain that verifies (%s)',
    async (mode) => {
      const seen: {
        kinds: string[];
        longest: number;
        hasEnd: boolean;
        leaked: boolean;
        tokenLeak: boolean;
        redacted: boolean;
        verify: unknown;
        feedLongest: number;
        first: unknown;
        summary: unknown;
        sources: string[];
      }[] = [];
      await runDemo({
        ...quiet,
        mode,
        inspect: async (k, runId) => {
          const records = await readChain(k, runId);
          const blobs = k.ports.auditBlobs!;
          let longest = 0;
          let hasEnd = false;
          let leaked = false;
          let tokenLeak = false;
          let redacted = false;
          for (const r of records) {
            let body = JSON.stringify(r.payload ?? null);
            if (r.blob) body = new TextDecoder().decode(await blobs.get(r.blob.sha256));
            if (body.includes('END-OF-OUTPUT')) {
              hasEnd = true;
              longest = Math.max(longest, body.length);
            }
            if (body.includes('sk-demoSECRETkeyabcdefghijklmnop')) leaked = true;
            // The tokens Krama itself issued (to agents, to the orchestrator) are in no record either.
            if (/krm_[A-Za-z0-9_-]{20,}/.test(body)) tokenLeak = true;
            if (r.redaction?.applied && r.redaction.rules.includes('api-key')) redacted = true;
          }
          // What the activity feed kept of the same events.
          const feed = await k.ports.events.read({ topics: [`run:${runId}`], limit: 5000 });
          const feedLongest = Math.max(
            0,
            ...feed
              .filter((e) => e.type.startsWith('activity.'))
              .map((e) => JSON.stringify(e.data).length),
          );
          seen.push({
            kinds: [...new Set(records.map((r) => r.kind))].sort(),
            longest,
            hasEnd,
            leaked,
            tokenLeak,
            redacted,
            verify: await k.ports.ledger!.verify(`run:${runId}`, { blobs }),
            feedLongest,
            first: records[0]?.kind,
            summary: records.at(-1)?.kind,
            sources: [...new Set(records.map((r) => r.source))].sort(),
          });
        },
      });
      const s = seen[0]!;
      // Everything a person or an agent said or did is there.
      expect(s.kinds).toEqual(
        expect.arrayContaining([
          'message.user',
          'tool.call',
          'tool.result',
          'a2a.request',
          'a2a.frame',
          'decision.requested',
          'decision.resolved',
          'capture.summary',
          // In `krama` mode Krama relays each delegation, so it also records what it asked and what came back.
          ...(mode === 'krama'
            ? ['message.delegation', 'step.state', 'artifact.created']
            : ['status']),
        ]),
      );
      expect(s.first).toBe('message.user');
      expect(s.summary).toBe('capture.summary');
      expect(s.sources).toEqual(expect.arrayContaining(['api', 'mcp', 'gateway-tap']));
      // `native`: the workers report to the event sink; `krama`: on the A2A stream Krama reads.
      expect(s.sources).toContain(mode === 'native' ? 'http-sink' : 'a2a-stream');
      // The worker's 12,000-character tool output is whole (to its last line), though the activity feed shows far less.
      expect(s.hasEnd).toBe(true);
      expect(s.longest).toBeGreaterThan(12_000);
      expect(s.feedLongest).toBeLessThan(s.longest);
      // The credential in the middle of it is not in the record, and the record says it was masked.
      expect(s.leaked).toBe(false);
      expect(s.tokenLeak).toBe(false);
      expect(s.redacted).toBe(true);
      expect(s.verify).toMatchObject({ ok: true });
    },
    SLOW,
  );
});
