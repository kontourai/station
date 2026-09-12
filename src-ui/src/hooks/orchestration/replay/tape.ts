import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import type { OrchestrationEvent } from '../types';

const SESSION_TAPE_KIND = 'station.session-tape' as const;

export interface SessionTapeSource {
  threadId: string;
  conversationId?: string;
  agentSlug: string;
  provider?: string;
  model?: string;
}

export interface SessionTape {
  schemaVersion: 1;
  kind: typeof SESSION_TAPE_KIND;
  recordedAt: string;
  source: SessionTapeSource;
  events: OrchestrationEvent[];
}

export function isSessionTape(value: unknown): value is SessionTape {
  if (!value || typeof value !== 'object') return false;
  const record = value as SessionTape;
  return (
    record.schemaVersion === 1 &&
    record.kind === SESSION_TAPE_KIND &&
    typeof record.recordedAt === 'string' &&
    Boolean(record.source?.threadId) &&
    Array.isArray(record.events)
  );
}

export function tapeFromSessionEvents(
  source: SessionTapeSource,
  events: CanonicalRuntimeEvent[] | OrchestrationEvent[],
  recordedAt = new Date().toISOString(),
): SessionTape {
  return {
    schemaVersion: 1,
    kind: SESSION_TAPE_KIND,
    recordedAt,
    source,
    events: events as OrchestrationEvent[],
  };
}
