import type { BackendDescriptor } from '@kramahq/contract';
import spawn from 'cross-spawn';

export interface ProbeResult {
  ok: boolean;
  output: string;
}

/** Injectable so checks are testable without installing every provider. */
export interface Prober {
  run(command: string[]): Promise<ProbeResult>;
  get(url: string): Promise<ProbeResult>;
}

export interface CheckItem {
  id: string;
  ok: boolean;
  optional?: boolean;
  detail?: string;
  fix?: string;
}

export interface CheckResult {
  items: CheckItem[];
  /** True when every non-optional item passed. */
  ok: boolean;
}

const hint = (
  h: BackendDescriptor['prerequisites'][number]['install'],
  platform: NodeJS.Platform,
): string | undefined =>
  h
    ? ((platform === 'darwin' ? h.macos : platform === 'win32' ? h.windows : h.linux) ?? h.any)
    : undefined;

/** Runs a backend's prerequisite and environment checks (what `krama doctor` prints). */
export async function checkBackend(
  d: BackendDescriptor,
  probe: Prober,
  opts: { env?: Record<string, string | undefined>; platform?: NodeJS.Platform } = {},
): Promise<CheckResult> {
  const platform = opts.platform ?? process.platform;
  const items: CheckItem[] = [];
  for (const p of d.prerequisites) {
    const fix = hint(p.install, platform);
    const base = { id: p.id, ...(p.optional ? { optional: true } : {}), ...(fix ? { fix } : {}) };
    if ('manual' in p.check) {
      items.push({ ...base, ok: true, detail: `${p.description} (verify manually)` });
      continue;
    }
    const r =
      'command' in p.check ? await probe.run(p.check.command) : await probe.get(p.check.url);
    const expect = 'command' in p.check ? p.check.expect : undefined;
    const ok = r.ok && (!expect || new RegExp(expect).test(r.output));
    items.push({
      ...base,
      ok,
      detail: ok
        ? p.description
        : `${p.description}: ${r.output.trim().split('\n')[0] || 'not found'}`,
    });
  }
  const env = opts.env ?? {};
  const groups = new Map<string, typeof d.env>();
  for (const v of d.env)
    groups.set(v.group ?? v.name, [...(groups.get(v.group ?? v.name) ?? []), v]);
  for (const [key, members] of groups) {
    const required = members.some((m) => m.required);
    const present = members.some((m) => (env[m.name] ?? '') !== '');
    if (!required && !members[0]?.group) continue;
    items.push({
      id: `env:${key}`,
      ok: present,
      optional: !required,
      detail: present
        ? `${members.map((m) => m.name).join(' / ')} is set`
        : `${members.map((m) => m.name).join(' or ')} is not set`,
      fix: members.map((m) => m.description).join(' '),
    });
  }
  return { items, ok: items.every((i) => i.ok || i.optional) };
}

/** Real prober: no shell, `cross-spawn` for Windows `.cmd` shims, 10 s timeout. */
export const nodeProber: Prober = {
  run: (command) =>
    new Promise((resolve) => {
      const [cmd, ...args] = command;
      try {
        const child = spawn(cmd!, args, {
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 10_000,
          windowsHide: true,
        });
        let out = '';
        child.stdout?.on('data', (b: Buffer) => (out += b.toString()));
        child.stderr?.on('data', (b: Buffer) => (out += b.toString()));
        child.on('error', (e) => resolve({ ok: false, output: e.message }));
        child.on('close', (code) => resolve({ ok: code === 0, output: out }));
      } catch (e) {
        resolve({ ok: false, output: (e as Error).message });
      }
    }),
  get: async (url) => {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      return { ok: res.ok || res.status < 500, output: `HTTP ${res.status}` };
    } catch (e) {
      return { ok: false, output: (e as Error).message };
    }
  },
};
