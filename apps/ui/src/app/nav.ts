import type { Capabilities } from '@kramahq/contract';
import {
  Bot,
  CalendarClock,
  Cpu,
  Hammer,
  Inbox,
  Brain,
  Package,
  Play,
  ShieldCheck,
  type LucideIcon,
} from 'lucide-react';

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Whether this server offers the feature. A screen the server cannot back is not shown. */
  show: (c: Capabilities | undefined) => boolean;
  badge?: 'inbox';
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

// While capabilities are loading everything shows, so the menu does not jump.
const on = (pick: (f: Capabilities['features']) => boolean) => (c: Capabilities | undefined) =>
  !c || pick(c.features);

export const NAV: NavGroup[] = [
  {
    label: 'Work',
    items: [
      { to: '/inbox', label: 'Inbox', icon: Inbox, show: on((f) => f.decisions), badge: 'inbox' },
      { to: '/runs', label: 'Runs', icon: Play, show: on((f) => f.runs) },
    ],
  },
  {
    label: 'Library',
    items: [
      { to: '/packs', label: 'Packs', icon: Package, show: on((f) => f.packs) },
      { to: '/agents', label: 'Agents', icon: Bot, show: on(() => true) },
      { to: '/memory', label: 'Memory', icon: Brain, show: on((f) => f.memory.enabled) },
      { to: '/studio', label: 'Studio', icon: Hammer, show: on((f) => f.builder) },
    ],
  },
  {
    label: 'Operate',
    items: [
      { to: '/fleet', label: 'Fleet', icon: Cpu, show: on(() => true) },
      {
        to: '/schedules',
        label: 'Schedules',
        icon: CalendarClock,
        show: on((f) => f.schedules.enabled),
      },
      { to: '/governance', label: 'Governance', icon: ShieldCheck, show: on(() => true) },
    ],
  },
];
