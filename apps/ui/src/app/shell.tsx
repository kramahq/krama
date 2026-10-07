import { Link, Outlet, useRouterState } from '@tanstack/react-router';
import {
  Check,
  ChevronsUpDown,
  FolderKanban,
  Laptop,
  Menu,
  Moon,
  Plus,
  Sun,
  X,
} from 'lucide-react';
import { useState } from 'react';
import { useLiveStatus } from '@/api/live';
import { useCapabilities, useDecisions, useMe } from '@/api/queries';
import { Button } from '@/components/ui/primitives';
import { cn } from '@/lib/cn';
import { NAV } from './nav';
import { PopoverPanel, usePopover } from './popover';
import { ALL_PROJECTS, useProject } from './project';
import { useTheme, type ThemeChoice } from './theme';

function Brand() {
  return (
    <Link to="/" className="flex items-center gap-2.5 px-2 py-1 no-underline">
      <span className="grid size-7 place-items-center rounded-[7px] bg-ink text-bg" aria-hidden>
        <svg
          viewBox="0 0 32 32"
          className="size-4"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M10 8v16M10 16l9-8M10 16l9 8" />
        </svg>
      </span>
      <span className="font-serif text-xl text-ink">Krama</span>
    </Link>
  );
}

function ProjectSwitcher() {
  const { selected, project, projects, select, enabled } = useProject();
  const { open, setOpen, ref } = usePopover();
  if (!enabled) return null;
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Switch project"
        className="flex w-full items-center gap-2 rounded-lg border border-line2 bg-raised px-2.5 py-2 text-left hover:bg-hover"
      >
        <FolderKanban className="size-4 shrink-0 text-ink3" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block text-[10px] tracking-wide text-ink3 uppercase">Project</span>
          <span className="block truncate text-sm font-medium">
            {project?.name ?? 'All projects'}
          </span>
        </span>
        <ChevronsUpDown className="size-4 shrink-0 text-ink3" aria-hidden />
      </button>
      {open && (
        <PopoverPanel>
          {[
            { id: ALL_PROJECTS, name: 'All projects', description: 'Everything you can see' },
            ...projects,
          ].map((p) => (
            <button
              key={p.id}
              type="button"
              role="menuitemradio"
              aria-checked={p.id === selected}
              onClick={() => {
                select(p.id);
                setOpen(false);
              }}
              className="flex w-full items-start gap-2 rounded-md px-2.5 py-2 text-left hover:bg-hover"
            >
              <Check
                className={cn(
                  'mt-0.5 size-4 shrink-0',
                  p.id === selected ? 'text-ink' : 'text-transparent',
                )}
                aria-hidden
              />
              <span className="min-w-0">
                <span className="block text-sm font-medium">{p.name}</span>
                {'description' in p && p.description && (
                  <span className="block truncate text-xs text-ink3">{p.description}</span>
                )}
              </span>
            </button>
          ))}
        </PopoverPanel>
      )}
    </div>
  );
}

function Nav({ onNavigate }: { onNavigate?: () => void }) {
  const caps = useCapabilities();
  const pending = useDecisions({ status: ['pending'], limit: 1 });
  const count = pending.data?.total ?? pending.data?.items.length ?? 0;
  const path = useRouterState({ select: (s) => s.location.pathname });
  return (
    <nav
      aria-label="Main"
      className="flex flex-1 flex-col gap-4 overflow-y-auto px-2 py-1 scroll-thin"
    >
      {NAV.map((g) => {
        const items = g.items.filter((i) => i.show(caps.data));
        if (items.length === 0) return null;
        return (
          <div key={g.label} className="flex flex-col gap-0.5">
            <div className="px-2.5 pb-1 text-[10px] tracking-wide text-ink3 uppercase">
              {g.label}
            </div>
            {items.map((i) => {
              const active = path === i.to || path.startsWith(`${i.to}/`);
              return (
                <Link
                  key={i.to}
                  to={i.to}
                  onClick={onNavigate}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm no-underline transition-colors',
                    active
                      ? 'bg-hover font-medium text-ink'
                      : 'text-ink2 hover:bg-hover hover:text-ink',
                  )}
                >
                  <i.icon className="size-4 shrink-0" aria-hidden />
                  <span className="flex-1">{i.label}</span>
                  {i.badge === 'inbox' && count > 0 && (
                    <span
                      className="rounded-full bg-warn/20 px-1.5 font-mono text-[11px] text-warn"
                      aria-label={`${count} waiting for you`}
                    >
                      {count}
                    </span>
                  )}
                </Link>
              );
            })}
          </div>
        );
      })}
    </nav>
  );
}

function ConnectionStatus() {
  const { status, reason } = useLiveStatus();
  const map = {
    live: { dot: 'bg-ok', label: 'Live' },
    connecting: { dot: 'bg-ink3', label: 'Connecting…' },
    reconnecting: { dot: 'bg-warn', label: 'Reconnecting…' },
    disconnected: { dot: 'bg-bad', label: 'Offline' },
  } as const;
  const s = map[status];
  return (
    <div className="flex items-center gap-2 px-2.5 text-xs text-ink2" role="status" title={reason}>
      <span
        className={cn('size-2 rounded-full', s.dot, status === 'reconnecting' && 'animate-pulse')}
        aria-hidden
      />
      {s.label}
    </div>
  );
}

const THEMES: { value: ThemeChoice; icon: typeof Sun; label: string }[] = [
  { value: 'system', icon: Laptop, label: 'System' },
  { value: 'light', icon: Sun, label: 'Light' },
  { value: 'dark', icon: Moon, label: 'Dark' },
];

function Footer() {
  const me = useMe();
  const [theme, setTheme] = useTheme();
  return (
    <div className="flex flex-col gap-2.5 border-t border-line px-2 pt-3 pb-2">
      <ConnectionStatus />
      <div className="flex items-center gap-2 px-1">
        <span
          className="grid size-7 shrink-0 place-items-center rounded-full bg-hover text-xs font-semibold uppercase"
          aria-hidden
        >
          {me.data?.name.slice(0, 1) ?? '·'}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm">{me.data?.name ?? 'Signing in…'}</span>
        <div
          role="radiogroup"
          aria-label="Theme"
          className="flex gap-0.5 rounded-md border border-line bg-panel p-0.5"
        >
          {THEMES.map((t) => (
            <button
              key={t.value}
              type="button"
              role="radio"
              aria-checked={theme === t.value}
              aria-label={t.label}
              title={t.label}
              onClick={() => setTheme(t.value)}
              className={cn(
                'grid size-6 place-items-center rounded',
                theme === t.value
                  ? 'bg-raised text-ink ring-1 ring-line'
                  : 'text-ink3 hover:text-ink',
              )}
            >
              <t.icon className="size-3.5" />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <div className="flex h-full flex-col gap-3 p-2">
      <Brand />
      <div className="px-1">
        <ProjectSwitcher />
      </div>
      <div className="px-1">
        <Link to="/runs/new" onClick={onNavigate} className="block no-underline">
          <Button variant="primary" className="w-full">
            <Plus className="size-4" aria-hidden /> New run
          </Button>
        </Link>
      </div>
      <Nav {...(onNavigate ? { onNavigate } : {})} />
      <Footer />
    </div>
  );
}

/** The frame around every screen: sidebar on a wide window, a drawer on a narrow one. */
export function Shell() {
  const path = useRouterState({ select: (s) => s.location.pathname });
  // The drawer belongs to the page it was opened on: going anywhere else closes it, with no effect to run.
  const [drawerFor, setDrawerFor] = useState<string | null>(null);
  const drawer = drawerFor === path;
  const setDrawer = (v: boolean) => setDrawerFor(v ? path : null);
  return (
    <div className="flex h-dvh bg-bg text-ink">
      <aside
        className="hidden w-[248px] shrink-0 border-r border-line bg-panel md:block"
        aria-label="Sidebar"
      >
        <Sidebar />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-2 border-b border-line bg-panel px-3 py-2 md:hidden">
          <Button variant="ghost" size="sm" aria-label="Open menu" onClick={() => setDrawer(true)}>
            <Menu className="size-4" />
          </Button>
          <Brand />
        </header>
        <main id="main" className="min-h-0 flex-1 overflow-y-auto scroll-thin">
          <Outlet />
        </main>
      </div>

      {drawer && (
        <div
          className="fixed inset-0 z-50 md:hidden"
          role="dialog"
          aria-modal="true"
          aria-label="Menu"
        >
          <button
            type="button"
            aria-label="Close menu"
            className="absolute inset-0 bg-black/40"
            onClick={() => setDrawer(false)}
          />
          <aside className="relative h-full w-[280px] max-w-[85vw] border-r border-line bg-panel shadow-xl">
            <Button
              variant="ghost"
              size="sm"
              aria-label="Close menu"
              className="absolute top-2 right-2"
              onClick={() => setDrawer(false)}
            >
              <X className="size-4" />
            </Button>
            <Sidebar onNavigate={() => setDrawer(false)} />
          </aside>
        </div>
      )}
    </div>
  );
}
