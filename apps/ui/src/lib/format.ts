import type { Money, Spend, Usage } from '@kramahq/contract';

/** "$6.82". Provider-reported only: `null` is "not reported", never zero and never an estimate. */
export function formatSpend(s: Spend | undefined): string {
  if (s === null || s === undefined) return 'not reported';
  return formatMoney(s);
}

export function formatMoney(m: Money): string {
  const digits = m.amount >= 100 ? 0 : 2;
  return `$${m.amount.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

const UNIT: Record<Usage['unit'], string> = {
  usd: 'USD',
  tokens: 'tokens',
  characters: 'characters',
  seconds: 's',
  images: 'images',
  calls: 'calls',
  credits: 'credits',
};

/** Usage in the unit the provider reported it in ("12,400 tokens"). */
export function formatUsage(u: Usage): string {
  return `${u.quantity.toLocaleString('en-US')} ${UNIT[u.unit]}`;
}

/** Share of the cap used, or undefined when nothing was reported. */
export function percentUsed(max: Money, spent: Spend | undefined): number | undefined {
  if (!spent || max.amount <= 0) return undefined;
  return Math.min(100, Math.round((spent.amount / max.amount) * 100));
}

const RTF = new Intl.RelativeTimeFormat('en', { numeric: 'auto', style: 'short' });
const STEPS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 31_536_000],
  ['month', 2_592_000],
  ['week', 604_800],
  ['day', 86_400],
  ['hour', 3600],
  ['minute', 60],
];

/** "5 min. ago", "in 2 hr.". `now` is injectable so tests and screenshots are stable. */
export function relativeTime(iso: string | undefined, now: number = Date.now()): string {
  if (!iso) return '';
  const seconds = Math.round((new Date(iso).getTime() - now) / 1000);
  for (const [unit, size] of STEPS) {
    if (Math.abs(seconds) >= size) return RTF.format(Math.round(seconds / size), unit);
  }
  return Math.abs(seconds) < 10 ? 'just now' : RTF.format(seconds, 'second');
}

export function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function duration(ms: number | undefined): string {
  if (ms === undefined) return '';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
  return `${Math.round(ms / 60_000)} min`;
}

/** A stable hue (0-359) for a name, so a role keeps its colour everywhere. */
export function hueOf(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return h;
}

export const pluralise = (n: number, one: string, many = `${one}s`): string =>
  `${n} ${n === 1 ? one : many}`;
