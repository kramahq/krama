import type { Operation } from '@kramahq/contract';
import type { EventLog, IdGenerator } from '@kramahq/engine';
import type { Principal } from './auth.js';
import type { Handlers } from './context.js';
import { ApiProblem, notFound } from './problems.js';

export interface OperationContext {
  /** Aborted when the operation is canceled. Long work should stop when it fires. */
  signal: AbortSignal;
  /** Reports progress (0 to 1) and an optional message; published as `operation.progress`. */
  progress(fraction: number, message?: string): void;
}

export interface StartOperation {
  type: string;
  /** The principal that asked for it; only they and an admin can read or cancel it. */
  owner: string;
  message?: string;
}

interface Record_ {
  op: Operation;
  owner: string;
  controller: AbortController;
}

const KEPT = 500;

/**
 * Long-running work behind `202 Accepted`: a pack install, a test run, an export. The registry runs it, keeps its
 * status for `GET /operations/{id}`, and publishes `operation.*` events on the `operations:{id}` topic. It lives in
 * memory, so a restart forgets finished operations; work that must survive a restart records its own state.
 */
export class OperationRegistry {
  private readonly ops = new Map<string, Record_>();

  constructor(
    private readonly events: EventLog,
    private readonly ids: IdGenerator,
    private readonly now: () => Date = () => new Date(),
  ) {}

  start(
    o: StartOperation,
    run: (c: OperationContext) => Promise<Record<string, unknown> | void>,
  ): Operation {
    const id = this.ids.next('op');
    const controller = new AbortController();
    const op: Operation = {
      id,
      type: o.type,
      status: 'queued',
      progress: 0,
      ...(o.message ? { message: o.message } : {}),
      links: { self: { href: `/api/v1/operations/${id}` } },
    };
    const rec: Record_ = { op, owner: o.owner, controller };
    this.ops.set(id, rec);
    this.evict();
    void this.execute(rec, run);
    return structuredClone(op);
  }

  private async execute(
    rec: Record_,
    run: (c: OperationContext) => Promise<Record<string, unknown> | void>,
  ): Promise<void> {
    const { op, controller } = rec;
    // Let `start` hand back the queued operation before any work begins.
    await Promise.resolve();
    if (controller.signal.aborted) return;
    op.status = 'running';
    op.startedAt = this.now().toISOString();
    await this.publish('operation.progress', rec);
    // A cancel can arrive while that event is written; the work must not start after it.
    if (controller.signal.aborted) return;
    try {
      const result = await run({
        signal: controller.signal,
        progress: (fraction, message) => {
          if (op.status !== 'running') return;
          op.progress = Math.min(Math.max(fraction, 0), 1);
          if (message !== undefined) op.message = message;
          void this.publish('operation.progress', rec);
        },
      });
      if (op.status !== 'running') return; // canceled while it ran: the answer is already given
      op.status = 'succeeded';
      op.progress = 1;
      if (result) op.result = result;
      op.endedAt = this.now().toISOString();
      await this.publish('operation.succeeded', rec);
    } catch (e) {
      if (op.status !== 'running') return;
      op.status = 'failed';
      op.endedAt = this.now().toISOString();
      op.error =
        e instanceof ApiProblem
          ? e.problem
          : {
              type: 'https://kramahq.dev/problems/internal',
              title: 'Operation failed',
              status: 500,
              code: 'internal',
              detail: 'The operation failed',
            };
      await this.publish('operation.failed', rec);
    }
  }

  /** The operation, if `principal` may see it (its owner, or an admin). */
  get(id: string, principal: Principal): Operation {
    const rec = this.ops.get(id);
    if (!rec || !this.canSee(rec, principal)) throw notFound('Operation', id);
    return structuredClone(rec.op);
  }

  /** Asks the work to stop. A finished operation cannot be canceled; canceling twice is harmless. */
  async cancel(id: string, principal: Principal): Promise<Operation> {
    const rec = this.ops.get(id);
    if (!rec || !this.canSee(rec, principal)) throw notFound('Operation', id);
    const { op } = rec;
    if (op.status === 'canceled') return structuredClone(op);
    if (op.status === 'succeeded' || op.status === 'failed')
      throw new ApiProblem('conflict', `The operation already ${op.status}`);
    op.status = 'canceled';
    op.endedAt = this.now().toISOString();
    rec.controller.abort();
    // The contract has no `operation.canceled` event: a cancel is a failure with a `canceled` status in its data.
    await this.publish('operation.failed', rec);
    return structuredClone(op);
  }

  private canSee(rec: Record_, p: Principal): boolean {
    return rec.owner === p.id || p.roles.includes('admin');
  }

  private async publish(type: string, rec: Record_): Promise<void> {
    try {
      await this.events.append({
        type,
        subject: { type: 'operation', id: rec.op.id },
        data: { operation: structuredClone(rec.op) },
      });
    } catch {
      // Publishing is best effort: the status route still answers truthfully.
    }
  }

  private evict(): void {
    if (this.ops.size <= KEPT) return;
    for (const [id, r] of this.ops) {
      if (this.ops.size <= KEPT) break;
      if (r.op.status !== 'queued' && r.op.status !== 'running') this.ops.delete(id);
    }
  }
}

export function operationHandlers(): Handlers {
  return {
    getOperation: (req) => req.ctx.operations.get(req.params['id']!, req.principal),
    cancelOperation: (req) => req.ctx.operations.cancel(req.params['id']!, req.principal),
  };
}
