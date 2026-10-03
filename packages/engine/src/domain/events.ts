import type { EventType } from '@kramahq/contract';

/** Something that happened in the domain; the application layer turns these into `EventEnvelope`s. */
export interface DomainEvent {
  type: EventType;
  subject: { type: string; id: string };
  runId?: string;
  data: Record<string, unknown>;
}
