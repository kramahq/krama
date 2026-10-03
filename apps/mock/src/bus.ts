import type { ActorRef, EventEnvelope } from '@kramahq/contract';
import type { MockState } from './state.js';

const RETAIN = 5000;
export const cursorOf = (n: number): string => String(n).padStart(9, '0');

type Listener = (e: EventEnvelope) => void;

/** In-memory, cursor-ordered event log with per-topic filtering (no cross-run leakage). */
export class EventBus {
  private listeners = new Set<Listener>();
  /** Lowest cursor still retained; older cursors get `410 gone`. */
  private floor = 1;
  constructor(private readonly state: MockState) {}

  emit(
    type: string,
    subject: { type: string; id: string },
    data: unknown,
    runId?: string,
    actor?: ActorRef,
  ): EventEnvelope {
    const e: EventEnvelope = {
      id: cursorOf(this.state.seq++),
      type,
      at: new Date().toISOString(),
      schema: 1,
      ...(runId ? { runId: runId as EventEnvelope['runId'] } : {}),
      subject,
      ...(actor ? { actor } : {}),
      data,
    };
    this.state.events.push(e);
    if (this.state.events.length > RETAIN) {
      this.state.events.shift();
      this.floor = Number(this.state.events[0]!.id);
    }
    if (!this.state.streamPaused) for (const l of this.listeners) l(e);
    return e;
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  /** True when a cursor is older than the retained window. */
  tooOld(after: string): boolean {
    const n = Number(after);
    return Number.isFinite(n) && n + 1 < this.floor;
  }

  since(after: string | undefined, topics: string[], limit = 200): EventEnvelope[] {
    const n = after ? Number(after) : 0;
    return this.state.events.filter((e) => Number(e.id) > n && matches(e, topics)).slice(0, limit);
  }
}

/** Topic filter: `run:{id}`, `runs`, `inbox`, `agent:{id}`, `agents`, `memory`, `schedules`, `packs`, `operations:{id}`, `audit`. */
export function matches(e: EventEnvelope, topics: string[]): boolean {
  if (topics.length === 0) return true;
  return topics.some((t) => {
    const [kind, id] = t.split(':') as [string, string | undefined];
    switch (kind) {
      case 'run':
        return e.runId === id;
      case 'runs':
        return e.type.startsWith('run.');
      case 'inbox':
        return e.type.startsWith('decision.');
      case 'agent':
        return e.subject.type === 'agent' && e.subject.id === id;
      case 'agents':
        return e.type.startsWith('agent.');
      case 'memory':
        return e.type.startsWith('memory.');
      case 'schedules':
        return e.type.startsWith('schedule.');
      case 'packs':
        return e.type.startsWith('pack.');
      case 'operations':
        return e.type.startsWith('operation.') && (!id || e.subject.id === id);
      case 'audit':
        return e.type === 'audit.recorded';
      default:
        return false;
    }
  });
}
