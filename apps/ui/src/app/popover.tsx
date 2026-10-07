import { useEffect, useRef, useState, type ReactNode } from 'react';

/** A button that opens a panel; closes on Escape and on a click outside. */
export function usePopover() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return { open, setOpen, ref };
}

export function PopoverPanel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={`absolute z-40 mt-1.5 w-full min-w-56 rounded-card border border-line2 bg-raised p-1 shadow-lg ${className ?? ''}`}
      role="menu"
    >
      {children}
    </div>
  );
}
