import type { AuditActor } from '@kramahq/contract';
import { Redactor } from '../domain/redactor.js';
import type { Transcript, TranscriptWrite } from '../ports/index.js';
import type { AuditWriter } from './audit-writer.js';

export interface TranscriptStats {
  written: number;
  duplicates: number;
  redacted: number;
  failed: number;
}

export interface TranscriptRecorderOptions {
  writer: AuditWriter;
  redactor?: Redactor;
  /** Throw when a record cannot be written, instead of counting it and carrying on. Default false. */
  strict?: boolean;
  onError?: (e: unknown, where: string) => void;
}

interface AgentSeen {
  role?: string;
  expectsSink: boolean;
  sinkEvents: number;
  streamEvents: number;
  activity: number;
  started: Set<string>;
  ended: Set<string>;
}

interface RunState extends TranscriptStats {
  agents: Map<string, AgentSeen>;
}

const SYSTEM: AuditActor = { type: 'system', id: 'krama-capture' };

/**
 * Writes a run's transcript to the audit ledger: redact first, then write, then return (so the caller shows the thing
 * only after it is on record). Remembers what it saw per agent so that, when the run closes, it can say where the record
 * has holes: an agent that was meant to report to the sink and never did, a start with no end, records that could not
 * be written. Silence is a finding, not an assumption.
 */
export class TranscriptRecorder implements Transcript {
  readonly redactor: Redactor;
  readonly stats: TranscriptStats = { written: 0, duplicates: 0, redacted: 0, failed: 0 };
  private readonly runs = new Map<string, RunState>();
  /** The last write queued for each run. Writes to one run go in the order they were asked for, whoever waits. */
  private readonly tails = new Map<string, Promise<void>>();

  constructor(private readonly o: TranscriptRecorderOptions) {
    this.redactor = o.redactor ?? new Redactor();
  }

  private run(runId: string): RunState {
    let r = this.runs.get(runId);
    if (!r) {
      r = { written: 0, duplicates: 0, redacted: 0, failed: 0, agents: new Map() };
      this.runs.set(runId, r);
    }
    return r;
  }

  private agent(runId: string, id: string, role?: string): AgentSeen {
    const run = this.run(runId);
    let a = run.agents.get(id);
    if (!a) {
      a = {
        expectsSink: false,
        sinkEvents: 0,
        streamEvents: 0,
        activity: 0,
        started: new Set(),
        ended: new Set(),
      };
      run.agents.set(id, a);
    }
    if (role && !a.role) a.role = role;
    return a;
  }

  expectSink(runId: string, agent: { id: string; role?: string }): void {
    this.agent(runId, agent.id, agent.role).expectsSink = true;
  }

  noteActivity(runId: string, agentId: string): void {
    this.agent(runId, agentId).activity++;
  }

  /**
   * Queues the write behind the run's earlier ones. A caller that must not run ahead of the record awaits the result; one
   * that only wants it recorded (the gateway tap, which must not slow a stream) need not, and still gets the order.
   */
  record(w: TranscriptWrite): Promise<void> {
    const prior = this.tails.get(w.runId) ?? Promise.resolve();
    const next = prior.then(() => this.recordNow(w));
    this.tails.set(
      w.runId,
      next.catch(() => undefined),
    );
    return next;
  }

  private async recordNow(w: TranscriptWrite): Promise<void> {
    const run = this.run(w.runId);
    if (w.observe) {
      const a = this.agent(w.runId, w.observe.agentId, w.observe.role);
      if (w.observe.channel === 'sink') a.sinkEvents++;
      else a.streamEvents++;
      const t = w.observe.traceId ?? '';
      if (w.observe.lifecycle === 'started') a.started.add(t);
      if (w.observe.lifecycle === 'finished' || w.observe.lifecycle === 'error') a.ended.add(t);
    }
    await this.write(`run:${w.runId}`, w, run);
  }

  async recordControl(w: Omit<TranscriptWrite, 'runId'> & { runId?: string }): Promise<void> {
    await this.write('control', w, undefined);
  }

  private async write(
    chain: string,
    w: Omit<TranscriptWrite, 'runId'> & { runId?: string },
    run: RunState | undefined,
  ): Promise<void> {
    try {
      const body = this.redactor.redact({ payload: w.payload, correlation: w.correlation });
      const res = await this.o.writer.write({
        chain,
        actor: w.actor,
        kind: w.kind,
        source: w.source,
        ...(w.at ? { at: w.at } : {}),
        ...(w.runId ? { runId: w.runId } : {}),
        ...(w.phaseId ? { phaseId: w.phaseId } : {}),
        ...(w.stepId ? { stepId: w.stepId } : {}),
        ...(w.decisionId ? { decisionId: w.decisionId } : {}),
        ...(w.sourceEventId !== undefined ? { sourceEventId: w.sourceEventId } : {}),
        ...(body.value.correlation ? { correlation: body.value.correlation } : {}),
        ...(body.value.payload !== undefined ? { payload: body.value.payload } : {}),
        ...(body.rules.length ? { redaction: { applied: true, rules: body.rules } } : {}),
      });
      for (const s of run ? [this.stats, run] : [this.stats]) {
        if (res.duplicate) s.duplicates++;
        else s.written++;
        if (body.rules.length && !res.duplicate) s.redacted++;
      }
    } catch (e) {
      for (const s of run ? [this.stats, run] : [this.stats]) s.failed++;
      this.o.onError?.(e, 'transcript.record');
      if (this.o.strict) throw e;
    }
  }

  async closeRun(runId: string): Promise<void> {
    await this.tails.get(runId); // everything asked for so far is on record first
    this.tails.delete(runId);
    const run = this.runs.get(runId);
    if (!run) return;
    this.runs.delete(runId);
    const gaps: {
      reason: string;
      agent: string;
      role?: string;
      detail: Record<string, unknown>;
    }[] = [];
    for (const [id, a] of run.agents) {
      if (a.expectsSink && a.sinkEvents === 0 && a.activity > 0)
        gaps.push({
          reason: 'sink_silent',
          agent: id,
          ...(a.role ? { role: a.role } : {}),
          detail: { activity: a.activity, streamEvents: a.streamEvents },
        });
      const open = [...a.started].filter((t) => !a.ended.has(t));
      if (open.length)
        gaps.push({
          reason: 'lifecycle_unbalanced',
          agent: id,
          ...(a.role ? { role: a.role } : {}),
          detail: { startedWithoutEnd: open.length, traces: open.slice(0, 20) },
        });
    }
    if (run.failed > 0)
      gaps.push({ reason: 'capture_failed', agent: '', detail: { records: run.failed } });
    for (const g of gaps)
      await this.write(
        `run:${runId}`,
        { runId, actor: SYSTEM, kind: 'capture.gap', source: 'system', payload: g },
        undefined,
      );
    await this.write(
      `run:${runId}`,
      {
        runId,
        actor: SYSTEM,
        kind: 'capture.summary',
        source: 'system',
        payload: {
          written: run.written,
          duplicates: run.duplicates,
          redacted: run.redacted,
          failed: run.failed,
          gaps: gaps.map((g) => g.reason),
        },
      },
      undefined,
    );
  }

  /** Closes every run still open (server shutdown). */
  async closeAll(): Promise<void> {
    for (const id of [...this.runs.keys()]) await this.closeRun(id);
  }
}
