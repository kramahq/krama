import spawn from 'cross-spawn';

export interface KillOps {
  platform: NodeJS.Platform;
  /** POSIX signal to a pid or, when negative, a whole process group. */
  signal(pid: number, signal: NodeJS.Signals): void;
  /** Windows: `taskkill /pid N /T /F`. Resolves when the command ends. */
  taskkill(pid: number): Promise<void>;
  isAlive(pid: number): boolean;
  sleep(ms: number): Promise<void>;
}

export const defaultKillOps: KillOps = {
  platform: process.platform,
  signal: (pid, sig) => process.kill(pid, sig),
  taskkill: (pid) =>
    new Promise((resolve) => {
      const c = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      c.on('error', () => resolve());
      c.on('close', () => resolve());
    }),
  isAlive: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'EPERM';
    }
  },
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/**
 * Terminates a process and everything it started.
 * POSIX: the child was spawned as a group leader, so the whole group gets SIGTERM, then SIGKILL after `graceMs`.
 * Windows: `taskkill /T /F` (no reliance on signal semantics). Never throws for an already-dead process.
 */
export async function killTree(
  pid: number,
  opts: { graceMs?: number; ops?: KillOps } = {},
): Promise<void> {
  const ops = opts.ops ?? defaultKillOps;
  const graceMs = opts.graceMs ?? 3000;
  if (ops.platform === 'win32') {
    await ops.taskkill(pid);
    return;
  }
  const send = (sig: NodeJS.Signals) => {
    try {
      ops.signal(-pid, sig);
    } catch {
      try {
        ops.signal(pid, sig);
      } catch {
        /* already gone */
      }
    }
  };
  send('SIGTERM');
  const deadline = Date.now() + graceMs;
  while (ops.isAlive(pid) && Date.now() < deadline) await ops.sleep(50);
  if (ops.isAlive(pid)) send('SIGKILL');
}
