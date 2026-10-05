import type { DecisionKind } from '@kramahq/contract';
import {
  BadgeCheck,
  Brain,
  ClipboardCheck,
  FolderLock,
  MessageSquareText,
  Package,
  Send,
  Wallet,
  type LucideIcon,
} from 'lucide-react';

const ICON: Record<DecisionKind, LucideIcon> = {
  review: ClipboardCheck,
  input: MessageSquareText,
  budget: Wallet,
  approval: BadgeCheck,
  access: FolderLock,
  consent: Package,
  memory: Brain,
  publish: Send,
};

export function KindIcon({ kind, className }: { kind: DecisionKind; className?: string }) {
  const I = ICON[kind];
  return <I className={className} aria-hidden />;
}
