#!/usr/bin/env node
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { BackendRegistry } from '@kramahq/agents';
import type { DelegationMode, EventEnvelope, Run, Usage } from '@kramahq/contract';
import { aggregateUsage } from '@kramahq/engine';
import { createKrama } from '../compose.js';
import { DEMO_BACKEND, DEMO_DEFINITIONS, DEMO_PACK } from './pack.js';

export interface DemoOptions {
  mode: DelegationMode;
  /** Data directory; a temporary one is created (and removed) when omitted. */
  home?: string;
  /** `auto` approves the gate; `prompt` asks on the terminal. */
  approve: 'auto' | 'prompt';
  out?: (line: string) => void;
  /** Give up after this long. */
  timeoutMs?: number;
}

export interface DemoResult {
  runId: string;
  status: Run['status'];
  timeline: string[];
  /** Usage reported by the orchestrator itself (no step). */
  orchestratorUsage: Usage[];
  /** Usage workers reported: through relayed steps (`krama`) or to the event sink (`native`). */
  workerUsage: Usage[];
  phases: { id: string; status: string; iteration: number }[];
}

// The scripted agent is a separate process, so it always runs from the build output (also when this file runs from source in tests).
const AGENT = fileURLToPath(
  new URL(
    import.meta.url.endsWith('.ts') ? '../../dist/demo/agent.js' : './agent.js',
    import.meta.url,
  ),
);

const fmtUsage = (u: Usage[]) =>
  u.length ? u.map((x) => `${x.quantity} ${x.unit}`).join(', ') : 'not reported';

function describe(e: EventEnvelope): string | undefined {
  const d = (e.data ?? {}) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  switch (e.type) {
    case 'agent.spawned':
      return `agent started: ${d.role ?? e.subject.id} on ${d.backend ?? ''}`.trim();
    case 'phase.started':
      return `phase ${d.phaseId} started${d.iteration > 1 ? ` (round ${d.iteration})` : ''}`;
    case 'phase.looped':
      return `phase ${d.phaseId} sent back for another round`;
    case 'phase.completed':
      return `phase ${d.phaseId} completed`;
    case 'activity.tool_call':
      return `${d.agent?.role ?? 'agent'} called ${d.toolName ?? d.text ?? 'a tool'}`;
    case 'step.started':
      return `step started in ${d.phaseId}`;
    case 'step.completed':
      return `step completed in ${d.phaseId}`;
    case 'decision.requested':
      return `decision requested: ${d.title ?? e.subject.id}`;
    case 'decision.resolved':
      return `decision resolved: ${d.optionId ?? ''}`;
    case 'cost.updated':
      return `usage recorded: ${fmtUsage((d.usage ?? []) as Usage[])}`;
    case 'run.completed':
    case 'run.failed':
    case 'run.stopped':
      return `run ${d.status}`;
    default:
      return undefined;
  }
}

/** Runs the walking skeleton end to end on scripted agents: run, activity, decision, resolve, completed, usage totals. */
export async function runDemo(o: DemoOptions): Promise<DemoResult> {
  const out = o.out ?? ((l: string) => console.log(l));
  const ownHome = o.home === undefined;
  const home = o.home ?? (await mkdtemp(join(tmpdir(), 'krama-demo-')));
  const backends = BackendRegistry.withBuiltins();
  backends.register(DEMO_BACKEND, 'user');
  const errors: string[] = [];
  const k = await createKrama({
    home,
    packs: [DEMO_PACK],
    definitions: DEMO_DEFINITIONS,
    backends,
    resolveCommand: () => ({ command: process.execPath, args: [AGENT] }),
    policy: {
      defaultOrchestrator: { definitionId: 'orchestrator/default', backend: 'a2a-demo' },
      defaultDelegation: o.mode,
    },
    onError: (e, where) => errors.push(`${where}: ${(e as Error).message ?? String(e)}`),
  });
  const timeline: string[] = [];
  const t0 = Date.now();
  const log = (line: string) => {
    const t = `+${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s`;
    const full = `${t}  ${line}`;
    timeline.push(full);
    out(full);
  };

  try {
    out(`Krama walking skeleton (${o.mode} delegation)\n`);
    const actor = { type: 'user' as const, id: 'demo', name: 'Demo user' };
    const run = await k.engine.runs.create(
      {
        packId: DEMO_PACK.id,
        input: { text: 'Write the release notes for 1.2' },
        budget: { max: 5 },
      },
      actor,
    );
    log(`run created: "${run.title}" with ${run.orchestrator.backend} as orchestrator`);

    let gate: Promise<void> | undefined;
    const unsubscribe = k.ports.events.subscribe((e) => {
      const line = describe(e);
      if (line) log(line);
      if (e.type === 'decision.requested' && e.runId === run.id)
        gate = (async () => {
          const dec = (await k.ports.store.decisions.get(e.subject.id))!.value.decision;
          let option = 'approve';
          if (o.approve === 'prompt') {
            const rl = createInterface({ input: process.stdin, output: process.stdout });
            const a = await rl.question(`\n${dec.title}: approve? [Y/n] `);
            rl.close();
            if (/^n/i.test(a.trim())) option = 'reject';
          }
          await k.engine.decisions.resolve(dec.id, { optionId: option }, actor);
        })();
    });

    await k.runner.start(run.id);
    const deadline = Date.now() + (o.timeoutMs ?? 90_000);
    let status: Run['status'] = run.status;
    for (;;) {
      status = (await k.ports.store.runs.get(run.id))!.value.run.status;
      if (['completed', 'failed', 'stopped'].includes(status)) break;
      if (status === 'blocked' || status === 'interrupted') {
        const why = (await k.ports.store.runs.get(run.id))!.value.run.statusReason;
        throw new Error(
          `The run is ${status}${why ? `: ${why}` : ''}${errors.length ? ` (${errors.join('; ')})` : ''}`,
        );
      }
      if (Date.now() > deadline)
        throw new Error(`Timed out waiting for the run (status ${status})`);
      await new Promise((r) => setTimeout(r, 100));
    }
    await gate;
    await k.runner.idle(run.id);
    unsubscribe();

    const final = (await k.ports.store.runs.get(run.id))!.value.run;
    // Usage by who reported it: the orchestrator, or a worker (a relayed step, or a worker reporting to the event sink).
    const spent = (await k.ports.events.read({ topics: [`run:${run.id}`] })).filter(
      (e) => e.type === 'cost.updated',
    );
    const byAgent = (isOrchestrator: boolean) =>
      aggregateUsage(
        spent
          .filter((e) => {
            const role = (e.data as { agent?: { role?: string } }).agent?.role;
            return role !== undefined && (role === 'orchestrator') === isOrchestrator;
          })
          .map((e) => ((e.data as { usage?: Usage[] }).usage ?? []) as Usage[]),
      );
    const orchestratorUsage = byAgent(true);
    const workerUsage = byAgent(false);

    out('\nSummary');
    out(`  status:        ${final.status}`);
    out(
      `  phases:        ${(final.phases ?? []).map((p) => `${p.id} ${p.status}${p.iteration > 1 ? ` (${p.iteration} rounds)` : ''}`).join(', ')}`,
    );
    out(`  orchestrator:  ${fmtUsage(orchestratorUsage)}`);
    out(
      `  workers:       ${
        workerUsage.length
          ? fmtUsage(workerUsage)
          : o.mode === 'native'
            ? 'not reported (they are called directly and did not report to the event sink)'
            : 'not reported'
      }`,
    );
    out(
      `  cost (USD):    ${final.budget.spent ? `$${final.budget.spent.amount}` : 'not reported'}`,
    );
    if (errors.length) out(`  errors:        ${errors.join('; ')}`);
    return {
      runId: run.id,
      status: final.status,
      timeline,
      orchestratorUsage,
      workerUsage,
      phases: (final.phases ?? []).map((p) => ({
        id: p.id,
        status: p.status,
        iteration: p.iteration,
      })),
    };
  } finally {
    await k.close();
    if (ownHome) await rm(home, { recursive: true, force: true }).catch(() => undefined);
  }
}

// ---- command line -------------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flag = (n: string) => args.includes(n);
  const value = (n: string) => args[args.indexOf(n) + 1];
  const mode = (flag('--mode') ? value('--mode') : 'native') as DelegationMode;
  if (mode !== 'native' && mode !== 'krama') {
    console.error('Usage: krama-demo [--mode native|krama] [--yes] [--home <dir>]');
    process.exit(2);
  }
  const home = flag('--home') ? value('--home') : undefined;
  const r = await runDemo({
    mode,
    approve: flag('--yes') || !process.stdin.isTTY ? 'auto' : 'prompt',
    ...(home ? { home } : {}),
  });
  process.exit(r.status === 'completed' ? 0 : 1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  main().catch((e: unknown) => {
    console.error(e);
    process.exit(1);
  });
