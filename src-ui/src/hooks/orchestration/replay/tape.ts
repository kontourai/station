import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import type { ChatUIState } from '../../../contexts/active-chats-state';
import type {
  OrchestrationEvent,
  OrchestrationSnapshotPayload,
} from '../types';
import type { ReplayHistoryState } from './history';

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
  if (!value || typeof value !== 'object') return false;
  const record = value as SessionTape;
  return (
    record.schemaVersion === 1 &&
    record.kind === SESSION_TAPE_KIND &&
    typeof record.recordedAt === 'string' &&
    Boolean(record.source?.threadId) &&
    typeof record.source?.agentSlug === 'string' &&
    Array.isArray(record.events) &&
    record.events.every(
      (event) =>
        typeof event?.method === 'string' &&
        typeof event?.threadId === 'string',
    ) &&
    (record.frames === undefined ||
      (Array.isArray(record.frames) &&
        record.frames.every(
          (frame) =>
            Number.isFinite(frame?.atMs) &&
            frame.atMs >= 0 &&
            (frame.kind === 'clock' ||
              (frame.kind === 'runtime'
                ? typeof frame.event?.method === 'string'
                : frame.kind === 'history'
                  ? Array.isArray(frame.state?.events)
                  : frame.kind === 'snapshot'
                    ? Array.isArray(frame.payload?.sessions)
                    : frame.kind === 'connection' &&
                      [
                        'receiving',
                        'interrupted',
                        'closed',
                        'caught-up',
                      ].includes(frame.status))),
        )))
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
    coverage: 'server-events',
  };
}
