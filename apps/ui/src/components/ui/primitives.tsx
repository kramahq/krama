import { cva, type VariantProps } from 'class-variance-authority';
import { Loader2 } from 'lucide-react';
import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { hueOf } from '@/lib/format';
import type { Tone } from '@/lib/status';

const button = cva(
  'inline-flex items-center justify-center gap-1.5 rounded-lg border font-medium whitespace-nowrap transition-colors disabled:opacity-50 select-none',
  {
    variants: {
      variant: {
        primary: 'border-ink bg-ink text-bg hover:opacity-90',
        secondary: 'border-line2 bg-raised text-ink hover:bg-hover',
        ghost: 'border-transparent bg-transparent text-ink2 hover:bg-hover hover:text-ink',
        danger: 'border-bad/40 bg-bad/10 text-bad hover:bg-bad/15',
      },
      size: { sm: 'h-7 px-2.5 text-xs', md: 'h-9 px-3.5 text-sm', lg: 'h-10 px-4 text-sm' },
    },
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof button> {
  busy?: boolean;
}

export function Button({
  variant,
  size,
  busy,
  className,
  children,
  disabled,
  ...rest
}: ButtonProps) {
  return (
    <button
      type="button"
      className={cn(button({ variant, size }), className)}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      {...rest}
    >
      {busy && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
      {children}
    </button>
  );
}

const TONE: Record<Tone, string> = {
  neutral: 'bg-hover text-ink2 border-line',
  ok: 'bg-ok/12 text-ok border-ok/25',
  warn: 'bg-warn/14 text-warn border-warn/30',
  bad: 'bg-bad/12 text-bad border-bad/25',
  info: 'bg-info/12 text-info border-info/25',
};

/** A small state label. The tone is the state; the words carry the meaning, never the colour alone. */
export function Badge({
  tone = 'neutral',
  children,
  className,
  dot,
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
  dot?: boolean;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] leading-4 font-medium whitespace-nowrap',
        TONE[tone],
        className,
      )}
    >
      {dot && <span className="size-1.5 rounded-full bg-current" aria-hidden />}
      {children}
    </span>
  );
}

/** A role or agent, coloured by a stable hue so it reads the same on every screen. */
export function RoleChip({ role, className }: { role: string; className?: string }) {
  const h = hueOf(role);
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-md px-1.5 py-px font-mono text-[11px] leading-4 whitespace-nowrap',
        className,
      )}
      style={{
        background: `color-mix(in oklch, oklch(0.6 0.12 ${h}) 15%, transparent)`,
        color: `color-mix(in oklch, oklch(0.55 0.13 ${h}) 80%, var(--ink))`,
      }}
    >
      {role}
    </span>
  );
}

export function Card({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('rounded-card border border-line bg-raised', className)} {...rest} />;
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-md bg-hover', className)} aria-hidden />;
}

export function EmptyState({
  icon,
  title,
  children,
  action,
}: {
  icon?: ReactNode;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-14 text-center">
      {icon && <div className="text-ink3">{icon}</div>}
      <h3 className="m-0 font-serif text-xl font-normal">{title}</h3>
      {children && <p className="m-0 max-w-md text-ink2">{children}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

/** A page title in the serif the design uses, with an optional line under it and actions on the right. */
export function PageHeader({
  title,
  sub,
  children,
}: {
  title: string;
  sub?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end gap-x-5 gap-y-3 px-4 pt-6 pb-3.5 md:px-7">
      <div className="flex min-w-0 flex-col gap-1">
        <h1 className="m-0 font-serif text-[32px] leading-[1.1] font-normal">{title}</h1>
        {sub && <span className="text-ink2">{sub}</span>}
      </div>
      {children && <div className="ml-auto flex items-center gap-2">{children}</div>}
    </div>
  );
}

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  count?: number | undefined;
}

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
}: {
  value: T;
  onChange: (v: T) => void;
  options: readonly SegmentOption<T>[];
  label: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="inline-flex gap-0.5 rounded-lg border border-line bg-panel p-[3px]"
    >
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(o.value)}
            className={cn(
              'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
              on ? 'bg-raised text-ink shadow-sm ring-1 ring-line' : 'text-ink2 hover:text-ink',
            )}
          >
            {o.label}
            {o.count !== undefined && (
              <span className="ml-1.5 font-mono text-[11px] text-ink3">{o.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** A small filter chip with a count, used for the Inbox kinds. */
export function Chip({
  active,
  count,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean; count?: number }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      className={cn(
        'inline-flex h-7 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors',
        active
          ? 'border-ink bg-ink text-bg'
          : 'border-line2 bg-raised text-ink2 hover:bg-hover hover:text-ink',
      )}
      {...rest}
    >
      {children}
      {count !== undefined && (
        <span className={cn('font-mono text-[11px]', active ? 'text-bg/70' : 'text-ink3')}>
          {count}
        </span>
      )}
    </button>
  );
}

/** Spend against a cap. Unit-aware: with nothing reported it says so, it does not draw an empty bar as if it were zero. */
export function Gauge({
  percent,
  label,
  tone,
}: {
  percent: number | undefined;
  label: string;
  tone?: Tone;
}) {
  const t =
    tone ??
    (percent === undefined ? 'neutral' : percent >= 100 ? 'bad' : percent >= 80 ? 'warn' : 'info');
  const fill: Record<Tone, string> = {
    neutral: 'bg-ink3',
    ok: 'bg-ok',
    warn: 'bg-warn',
    bad: 'bg-bad',
    info: 'bg-info',
  };
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div
        className="h-1.5 w-full overflow-hidden rounded-full bg-hover"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        {...(percent !== undefined ? { 'aria-valuenow': percent } : {})}
      >
        {percent !== undefined && (
          <div className={cn('h-full rounded-full', fill[t])} style={{ width: `${percent}%` }} />
        )}
      </div>
    </div>
  );
}

/** A labelled field value, for the header facts of a run or a decision. */
export function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-[11px] tracking-wide text-ink3 uppercase">{label}</dt>
      <dd className="m-0 truncate text-sm">{children}</dd>
    </div>
  );
}
