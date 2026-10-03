import { randomBytes } from 'node:crypto';
import type { Clock, IdGenerator, Notifier, SecretResolver } from './ports/index.js';

/** Wall-clock time. */
export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Prefixed ULIDs (`run_01J9…`): 48-bit millisecond time then 80 random bits, Crockford base32, so ids sort by creation.
 * Monotonic within a millisecond.
 */
export class UlidIdGenerator implements IdGenerator {
  private lastTime = -1;
  private lastRandom = new Uint8Array(10);

  next<P extends string>(prefix: P): `${P}_${string}` {
    let t = Date.now();
    if (t === this.lastTime) {
      t = this.lastTime;
      for (let i = 9; i >= 0; i--) {
        if (this.lastRandom[i]! < 255) {
          this.lastRandom[i]!++;
          break;
        }
        this.lastRandom[i] = 0;
      }
    } else {
      this.lastTime = t;
      this.lastRandom = new Uint8Array(randomBytes(10));
    }
    let time = '';
    for (let i = 0; i < 10; i++) {
      time = CROCKFORD[t % 32] + time;
      t = Math.floor(t / 32);
    }
    let bits = 0n;
    for (const b of this.lastRandom) bits = (bits << 8n) | BigInt(b);
    let rand = '';
    for (let i = 0; i < 16; i++) {
      rand = CROCKFORD[Number(bits & 31n)] + rand;
      bits >>= 5n;
    }
    return `${prefix}_${time}${rand}`;
  }
}

/** Resolves secret references from environment variables (`my-key` → `KRAMA_SECRET_MY_KEY`). Values are never logged. */
export class EnvSecretResolver implements SecretResolver {
  constructor(
    private readonly env: Record<string, string | undefined> = process.env,
    private readonly prefix = 'KRAMA_SECRET_',
  ) {}
  async resolve(ref: string): Promise<string | undefined> {
    return this.env[`${this.prefix}${ref.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`];
  }
}

/** Does nothing; decisions are still visible through the event log and the inbox. */
export class NullNotifier implements Notifier {
  async notify(): Promise<void> {}
}
