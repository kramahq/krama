import { createHash } from 'node:crypto';
import { ApiProblem } from './problems.js';

export interface StoredResponse {
  status: number;
  body: unknown;
  headers: Record<string, string>;
}

type Entry =
  | { state: 'pending'; fingerprint: string }
  | { state: 'done'; fingerprint: string; response: StoredResponse; at: number };

export const IDEMPOTENCY_HEADER = 'idempotency-key';
const MAX_KEY_LENGTH = 255;

/**
 * Replays the first response for a repeated `Idempotency-Key` on a `POST` create. A key is scoped to the caller,
 * the method and path; reusing it with a different body is a conflict, and so is repeating it while the first
 * call is still running. Failed (5xx) calls are forgotten so a retry can succeed. In memory, bounded, with a TTL:
 * a restart forgets keys, which only matters for a client retrying across a restart.
 */
export class IdempotencyStore {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly o: { ttlMs?: number; max?: number; now?: () => number } = {}) {}

  private now() {
    return (this.o.now ?? Date.now)();
  }

  static fingerprint(method: string, url: string, body: unknown): string {
    return createHash('sha256')
      .update(`${method} ${url}\n${JSON.stringify(body ?? null)}`)
      .digest('hex');
  }

  /**
   * Starts a keyed call. Returns a stored response to replay, or `undefined` after reserving the key (the caller
   * must then `complete` or `abandon` it).
   */
  begin(principal: string, key: string, fingerprint: string): StoredResponse | undefined {
    if (key.length === 0 || key.length > MAX_KEY_LENGTH)
      throw new ApiProblem('validation_failed', 'The Idempotency-Key is not valid', {
        errors: [{ field: 'Idempotency-Key', message: `1 to ${MAX_KEY_LENGTH} characters` }],
      });
    this.expire();
    const id = `${principal}\n${key}`;
    const found = this.entries.get(id);
    if (found) {
      if (found.fingerprint !== fingerprint)
        throw new ApiProblem(
          'conflict',
          'This Idempotency-Key was already used for a different request',
        );
      if (found.state === 'pending')
        throw new ApiProblem(
          'conflict',
          'A request with this Idempotency-Key is still being processed',
          {
            headers: { 'retry-after': '1' },
          },
        );
      return found.response;
    }
    this.entries.set(id, { state: 'pending', fingerprint });
    return undefined;
  }

  complete(principal: string, key: string, response: StoredResponse): void {
    const id = `${principal}\n${key}`;
    const e = this.entries.get(id);
    if (!e) return;
    if (response.status >= 500) return void this.entries.delete(id);
    this.entries.set(id, { state: 'done', fingerprint: e.fingerprint, response, at: this.now() });
    this.trim();
  }

  abandon(principal: string, key: string): void {
    this.entries.delete(`${principal}\n${key}`);
  }

  private expire() {
    const ttl = this.o.ttlMs ?? 24 * 60 * 60 * 1000;
    const cutoff = this.now() - ttl;
    for (const [k, e] of this.entries)
      if (e.state === 'done' && e.at < cutoff) this.entries.delete(k);
  }

  private trim() {
    const max = this.o.max ?? 10_000;
    while (this.entries.size > max) this.entries.delete(this.entries.keys().next().value!);
  }
}
