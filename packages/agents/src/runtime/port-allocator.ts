import { createServer } from 'node:net';

/** True when `port` can be bound on `host` right now. */
export const canBind = (port: number, host = '127.0.0.1'): Promise<boolean> =>
  new Promise((resolve) => {
    const s = createServer();
    s.once('error', () => resolve(false));
    s.listen({ port, host, exclusive: true }, () => s.close(() => resolve(true)));
  });

/** Asks the OS for a free port. */
export const osFreePort = (host = '127.0.0.1'): Promise<number> =>
  new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen({ port: 0, host, exclusive: true }, () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });

export interface PortAllocatorOptions {
  host?: string;
  /** Restrict to a range (e.g. for firewalls). Without it the OS picks. */
  range?: { min: number; max: number };
  /** Test seams. */
  probe?: (port: number) => Promise<boolean>;
  pick?: () => Promise<number>;
}

/**
 * Dynamic port allocation: never a fixed block, so two Krama servers or other tools on the machine
 * cannot collide. A port is verified free at allocation time and remembered until released.
 */
export class PortAllocator {
  private readonly held = new Set<number>();
  private readonly host: string;
  constructor(private readonly o: PortAllocatorOptions = {}) {
    this.host = o.host ?? '127.0.0.1';
  }

  /**
   * A free port. With `preferred` (the address an agent had before it was restarted) that port is taken again when it is
   * still free, so callers that were given the agent's address keep working; otherwise another is picked.
   */
  async allocate(preferred?: number): Promise<number> {
    const probe = this.o.probe ?? ((p: number) => canBind(p, this.host));
    if (preferred !== undefined && !this.held.has(preferred) && (await probe(preferred))) {
      this.held.add(preferred);
      return preferred;
    }
    for (let attempt = 0; attempt < 50; attempt++) {
      const port = this.o.range
        ? this.o.range.min + Math.floor(Math.random() * (this.o.range.max - this.o.range.min + 1))
        : await (this.o.pick ?? (() => osFreePort(this.host)))();
      if (this.held.has(port)) continue;
      if (this.o.range && !(await probe(port))) continue;
      this.held.add(port);
      return port;
    }
    throw new Error('Could not find a free port');
  }

  release(port: number): void {
    this.held.delete(port);
  }
  has(port: number): boolean {
    return this.held.has(port);
  }
  get count(): number {
    return this.held.size;
  }
}
