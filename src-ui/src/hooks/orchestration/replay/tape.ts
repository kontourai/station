import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import type { ChatUIState } from '../../../contexts/active-chats-state';
import type {
  OrchestrationEvent,
  OrchestrationSnapshotPayload,
} from '../types';
import type { ReplayHistoryState } from './history';
import { validateTapeContents } from './tape-validation';

export const SESSION_TAPE_KIND = 'station.session-tape' as const;

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
  /** Absent for historical server tapes, whose client transport ordering is unknown. */
  frames?: ReplayFrame[];
  initialChat?: Partial<ChatUIState>;
  initialHistory?: ReplayHistoryState;
  coverage?: 'server-events' | 'client-capture';
  stoppedReason?: string;
  redacted?: boolean;
}

export type ReplayFrame = { atMs: number } & (
  | { kind: 'clock' }
  | { kind: 'runtime'; event: OrchestrationEvent; provenance?: unknown }
  | { kind: 'history'; state: ReplayHistoryState }
  | {
      kind: 'snapshot';
      payload: OrchestrationSnapshotPayload;
      reconnect: boolean;
    }
  | {
      kind: 'connection';
      status: 'receiving' | 'interrupted' | 'closed' | 'caught-up';
    }
);

export function replayFrames(tape: SessionTape): ReplayFrame[] {
  if (tape.frames) return tape.frames;
  const start = Date.parse(tape.events[0]?.createdAt ?? '') || 0;
  return tape.events.map((event) => ({
    kind: 'runtime',
    event,
    atMs: Math.max(0, (Date.parse(event.createdAt) || start) - start),
  }));
}

export function isSessionTape(value: unknown): value is SessionTape {
  return validateTapeContents(value, SESSION_TAPE_KIND);
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
    coverage: 'server-events',
  };
}
