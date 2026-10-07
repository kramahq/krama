import type { DecisionKind, Run } from '@kramahq/contract';

export type Tone = 'neutral' | 'ok' | 'warn' | 'bad' | 'info';

/** What a run status means to a person, in the words the product uses. */
export const RUN_STATUS: Record<Run['status'], { label: string; tone: Tone; active: boolean }> = {
  planning: { label: 'Planning', tone: 'info', active: true },
  running: { label: 'Running', tone: 'info', active: true },
  paused: { label: 'Paused', tone: 'warn', active: true },
  awaiting_decision: { label: 'Needs you', tone: 'warn', active: true },
  blocked: { label: 'Blocked', tone: 'bad', active: true },
  completed: { label: 'Completed', tone: 'ok', active: false },
  failed: { label: 'Failed', tone: 'bad', active: false },
  stopped: { label: 'Stopped', tone: 'neutral', active: false },
  interrupted: { label: 'Interrupted', tone: 'warn', active: true },
};

export const DECISION_KIND: Record<DecisionKind, { label: string; hint: string }> = {
  review: { label: 'Review', hint: 'Check the work and approve or send it back' },
  input: { label: 'Input', hint: 'An agent needs an answer from you' },
  budget: { label: 'Budget', hint: 'A spending cap was reached' },
  approval: { label: 'Approval', hint: 'A person has to approve before this continues' },
  access: { label: 'Access', hint: 'An agent asks to use a folder outside its workspace' },
  consent: { label: 'Pack install', hint: 'Review what a pack will be allowed to do' },
  memory: { label: 'Memory', hint: 'Something an agent wants to remember' },
  publish: { label: 'Publish', hint: 'A draft is ready to be published' },
};

/** Inbox filter order, as in the design. */
export const KIND_ORDER: DecisionKind[] = [
  'review',
  'input',
  'budget',
  'approval',
  'access',
  'consent',
  'memory',
  'publish',
];
