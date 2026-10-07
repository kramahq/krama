import { createHash, randomBytes } from 'node:crypto';
import type { Principal } from './auth.js';

export const TICKET_TTL_MS = 60_000;
/** More tickets than this outstanding at once means something is minting them in a loop; the oldest are dropped. */
const MAX_OUTSTANDING = 1000;

interface Entry {
  principal: Principal;
  expiresAt: number;
}

/**
 * Single-use, short-lived tickets for event streams. A browser `EventSource` cannot send an `Authorization` header, so
 * a caller with the bearer token asks for a ticket and opens the stream with `?ticket=`. A ticket works once and only
 * on a stream route, and only its hash is kept.
 */
export class TicketStore {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs: number = TICKET_TTL_MS,
  ) {}

  private static key(ticket: string): string {
    return createHash('sha256').update(ticket).digest('hex');
  }

  issue(principal: Principal): { ticket: string; expiresAt: string } {
    this.sweep();
    while (this.entries.size >= MAX_OUTSTANDING) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
    }
    const ticket = `tk_${randomBytes(24).toString('base64url')}`;
    const expiresAt = this.now() + this.ttlMs;
    this.entries.set(TicketStore.key(ticket), { principal, expiresAt });
    return { ticket, expiresAt: new Date(expiresAt).toISOString() };
  }

  /** The principal the ticket was issued to. The ticket is spent whether or not it was still valid. */
  consume(ticket: string | undefined): Principal | undefined {
    if (!ticket) return undefined;
    const k = TicketStore.key(ticket);
    const e = this.entries.get(k);
    if (!e) return undefined;
    this.entries.delete(k);
    return e.expiresAt > this.now() ? e.principal : undefined;
  }

  get size(): number {
    return this.entries.size;
  }

  private sweep(): void {
    const t = this.now();
    for (const [k, e] of this.entries) if (e.expiresAt <= t) this.entries.delete(k);
  }
}
