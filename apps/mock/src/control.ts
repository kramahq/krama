import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { eventEnvelope, type ActivityItem, type EventEnvelope } from '@kramahq/contract';
import type { FastifyInstance } from 'fastify';
import type { EventBus } from './bus.js';
import { ProblemError } from './problems.js';
import type { MockState } from './state.js';

interface ControlCtx {
  handle: { state: MockState; bus: EventBus };
  reset(): void;
  scenariosDir: string | undefined;
  autoProgress: boolean;
}

const defaultDir = fileURLToPath(new URL('../scenarios/', import.meta.url));
const nameOf = (file: string) => file.replace(/^events-/, '').replace(/\.ndjson$/, '');

/** Mirrors an event into mock state so refetching after the event shows the change. */
function apply(s: MockState, e: EventEnvelope): void {
  const d = (e.data ?? {}) as Record<string, any>;
  const run = s.runs.find((r) => r.id === e.runId);
  if (e.type.startsWith('activity.') && run) {
    const type = e.type.replace('activity.', '') as ActivityItem['type'];
    s.activity.push({
      id: `act_${e.id}`,
      at: e.at,
      type,
      runId: run.id,
      ...(d.phaseId ? { phaseId: d.phaseId } : {}),
      ...(d.agent
        ? {
            agent: {
              id: `agt_${d.agent.role ?? d.agent}`,
              role: d.agent.role ?? String(d.agent),
              backend: d.agent.backend ?? 'a2a-codex',
            },
          }
        : {}),
      ...(d.toolName ? { toolName: d.toolName } : {}),
      ...(d.isError !== undefined ? { isError: d.isError } : {}),
      ...(d.durationMs ? { durationMs: d.durationMs } : {}),
      text: d.text,
    });
  } else if (e.type === 'cost.updated' && run && d.spent) {
    run.budget.spent = d.spent;
  } else if (e.type === 'run.updated' && run && d.status) {
    run.status = d.status;
    run.updatedAt = e.at;
  }
}

export function registerMockControl(app: FastifyInstance, ctx: ControlCtx): void {
  const dir = ctx.scenariosDir ?? defaultDir;
  let speed = 1;
  let timers: NodeJS.Timeout[] = [];
  const stop = () => {
    timers.forEach(clearTimeout);
    timers = [];
  };

  const files = () => {
    try {
      return readdirSync(dir).filter((f) => /^events-.*\.ndjson$/.test(f));
    } catch {
      return [];
    }
  };

  app.get('/__mock/scenarios', () => ({
    speed,
    items: files().map((f) => ({
      name: nameOf(f),
      file: f,
      events: readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean).length,
    })),
  }));

  app.post<{ Params: { name: string }; Body: { speed?: number } | undefined }>(
    '/__mock/scenarios/:name/play',
    (req) => {
      const file = files().find((f) => nameOf(f) === req.params.name);
      if (!file)
        throw new ProblemError(
          'not_found',
          'Scenario not found',
          `Available: ${files().map(nameOf).join(', ')}`,
        );
      if (req.body?.speed) speed = req.body.speed;
      const events = readFileSync(join(dir, file), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => eventEnvelope.parse(JSON.parse(l)));
      const t0 = Date.parse(events[0]!.at);
      for (const ev of events) {
        const delay = (Date.parse(ev.at) - t0) / speed;
        const fire = () => {
          const e = ctx.handle.bus.emit(ev.type, ev.subject, ev.data, ev.runId, ev.actor);
          apply(ctx.handle.state, e);
        };
        if (delay <= 0) fire();
        else timers.push(setTimeout(fire, delay).unref());
      }
      return {
        playing: req.params.name,
        events: events.length,
        speed,
        durationMs: Math.round((Date.parse(events.at(-1)!.at) - t0) / speed),
      };
    },
  );

  app.post('/__mock/scenarios/stop', () => {
    stop();
    return { stopped: true };
  });
  app.post<{ Body: { speed: number } }>('/__mock/speed', (req) => {
    speed = Math.max(0.1, Number(req.body?.speed) || 1);
    return { speed };
  });
  app.post<{ Body: Record<string, unknown> }>('/__mock/capabilities', async (req) => {
    const { deepMerge } = await import('./app.js');
    return deepMerge(ctx.handle.state.capabilities as any, req.body ?? {});
  });
  app.post<{ Body: { paused: boolean } }>('/__mock/stream', (req) => {
    ctx.handle.state.streamPaused = Boolean(req.body?.paused);
    return { paused: ctx.handle.state.streamPaused };
  });
  app.post('/__mock/reset', () => {
    stop();
    ctx.reset();
    return { reset: true };
  });
}
