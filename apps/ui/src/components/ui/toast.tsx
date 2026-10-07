import { CheckCircle2, CircleAlert, X } from 'lucide-react';
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { cn } from '@/lib/cn';

interface Toast {
  id: number;
  tone: 'ok' | 'bad' | 'info';
  title: string;
  detail?: string | undefined;
}

interface ToastApi {
  show(t: Omit<Toast, 'id'>): void;
  ok(title: string, detail?: string): void;
  error(title: string, detail?: string): void;
}

const Ctx = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const v = useContext(Ctx);
  if (!v) throw new Error('useToast needs a <ToastProvider>');
  return v;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const next = useRef(1);
  const dismiss = useCallback((id: number) => setItems((l) => l.filter((t) => t.id !== id)), []);
  const show = useCallback(
    (t: Omit<Toast, 'id'>) => {
      const id = next.current++;
      setItems((l) => [...l.slice(-3), { ...t, id }]);
      // Errors stay until dismissed: a failure should not vanish while someone is reading it.
      if (t.tone !== 'bad') setTimeout(() => dismiss(id), 4500);
    },
    [dismiss],
  );
  const api = useMemo<ToastApi>(
    () => ({
      show,
      ok: (title, detail) => show({ tone: 'ok', title, detail }),
      error: (title, detail) => show({ tone: 'bad', title, detail }),
    }),
    [show],
  );
  return (
    <Ctx.Provider value={api}>
      {children}
      <div
        className="pointer-events-none fixed right-4 bottom-4 z-50 flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2"
        role="region"
        aria-label="Notifications"
      >
        {items.map((t) => (
          <div
            key={t.id}
            role={t.tone === 'bad' ? 'alert' : 'status'}
            className={cn(
              'pointer-events-auto flex items-start gap-2.5 rounded-card border bg-raised p-3 shadow-lg',
              t.tone === 'bad' ? 'border-bad/40' : 'border-line2',
            )}
          >
            {t.tone === 'bad' ? (
              <CircleAlert className="mt-0.5 size-4 shrink-0 text-bad" aria-hidden />
            ) : (
              <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-ok" aria-hidden />
            )}
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">{t.title}</div>
              {t.detail && <div className="prose-lite mt-0.5 text-xs text-ink2">{t.detail}</div>}
            </div>
            <button
              type="button"
              aria-label="Dismiss"
              onClick={() => dismiss(t.id)}
              className="text-ink3 hover:text-ink"
            >
              <X className="size-4" />
            </button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
