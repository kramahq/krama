import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface LedgerEntry {
  id: string;
  pid: number;
  port: number;
  startedAt: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Atomic write: temp file then rename, retrying the transient `EBUSY`/`EPERM` that Windows can raise. */
export async function writeFileAtomic(file: string, data: string): Promise<void> {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, data);
  for (let i = 0; ; i++) {
    try {
      renameSync(tmp, file);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (i >= 8 || (code !== 'EBUSY' && code !== 'EPERM' && code !== 'EACCES')) throw e;
      await sleep(25 * (i + 1));
    }
  }
}

export interface OrphanOps {
  isAlive(pid: number): boolean;
  /** True when something on `port` still answers like our agent. Guards against pid reuse. */
  answers(port: number): Promise<boolean>;
  kill(pid: number): Promise<void>;
}

/**
 * Records the processes Krama started so a crash (which leaves detached wrappers holding ports) can be
 * cleaned up on the next start. Only processes that are still alive AND still answer on their port are killed.
 */
export class Ledger {
  constructor(private readonly file: string) {}

  private read(): LedgerEntry[] {
    try {
      const v = JSON.parse(readFileSync(this.file, 'utf8')) as unknown;
      return Array.isArray(v) ? (v as LedgerEntry[]) : [];
    } catch {
      return [];
    }
  }

  async add(e: LedgerEntry): Promise<void> {
    await writeFileAtomic(
      this.file,
      JSON.stringify([...this.read().filter((x) => x.id !== e.id), e], null, 2),
    );
  }

  async remove(id: string): Promise<void> {
    const rest = this.read().filter((x) => x.id !== id);
    await writeFileAtomic(this.file, JSON.stringify(rest, null, 2));
  }

  entries(): LedgerEntry[] {
    return this.read();
  }

  /** Kills leftovers from a previous run; returns the ids that were reaped. Clears the ledger. */
  async reapOrphans(ops: OrphanOps): Promise<string[]> {
    const reaped: string[] = [];
    for (const e of this.read()) {
      if (ops.isAlive(e.pid) && (await ops.answers(e.port))) {
        await ops.kill(e.pid);
        reaped.push(e.id);
      }
    }
    await writeFileAtomic(this.file, '[]');
    return reaped;
  }
}
