import { useSyncExternalStore } from 'react';

export type ThemeChoice = 'system' | 'light' | 'dark';
const KEY = 'krama.theme';

function saved(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

let choice: ThemeChoice = saved();
const listeners = new Set<() => void>();

function apply(): void {
  const dark =
    choice === 'dark' ||
    (choice === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}

/** Call once before the first render, so the page never flashes the wrong theme. */
export function initTheme(): void {
  apply();
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (choice === 'system') apply();
  });
}

export function setTheme(next: ThemeChoice): void {
  choice = next;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    /* the choice still applies for this session */
  }
  apply();
  listeners.forEach((l) => l());
}

export function useTheme(): [ThemeChoice, (t: ThemeChoice) => void] {
  const value = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => choice,
  );
  return [value, setTheme];
}
