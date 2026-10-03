/** Keeps the last N lines of a process's output for diagnostics (never the whole stream). */
export class LogTail {
  private lines: string[] = [];
  private partial = '';
  constructor(private readonly max = 200) {}

  push(chunk: string): void {
    const parts = (this.partial + chunk).split(/\r?\n/);
    this.partial = parts.pop() ?? '';
    for (const l of parts) this.lines.push(l);
    if (this.lines.length > this.max) this.lines.splice(0, this.lines.length - this.max);
  }

  tail(n = 20): string[] {
    return [...this.lines, ...(this.partial ? [this.partial] : [])].slice(-n);
  }
}
