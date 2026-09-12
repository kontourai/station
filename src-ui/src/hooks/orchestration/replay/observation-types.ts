import type { ReplayRenderMeasurement } from './render-observation';

export type ReplayIssueCode =
  | 'duplicate-streaming-and-settled'
  | 'streaming-after-turn-completed'
  | 'lineage-leak'
  | 'empty-after-completed-turn'
  | 'no-text-after-completed-turn'
  | 'completed-answer-not-rendered'
  | 'rendered-duplicate-turn'
  | 'unhandled-canonical-method'
  | 'unbound-extension-notification'
  | 'in-flight-content-dropped-on-session-exit';

export interface ReplayIssue {
  code: ReplayIssueCode;
  detail: string;
}

export interface ReplayTranscriptRowObservation {
  id: string;
  role: string;
  turnId?: string;
  kind: 'message' | 'streaming';
  textPreview: string;
  toolNames: string[];
}

export interface ReplayScrollObservation {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  isUserScrolledUp: boolean;
  atBottom: boolean;
  visibleMessageKeys: string[];
  /** Visible transcript text, so an agent can read what the dock actually shows. */
  accessibleText: string;
}

export interface ReplayObservationDelta {
  addedRowIds: string[];
  removedRowIds: string[];
  streamingTextDeltaLength: number;
  issueCodesAdded: ReplayIssueCode[];
  stateChanges?: Array<{ field: string; before: unknown; after: unknown }>;
}

export interface ReplayObservation {
  schemaVersion: 1;
  replayId: string;
  cursor: {
    index: number;
    eventCount: number;
    eventId?: string;
    method?: string;
    turnId?: string;
  };
  atEnd: boolean;
  frame?: { kind: string; atMs: number; coverage: string; connection: string };
  playback?: { playing: boolean; speed: number };
  performance?: { foldMs: number; render?: ReplayRenderMeasurement };
  execution: {
    status?: string;
    orchestrationStatus?: string;
    turnOpen: boolean;
    openTurnId?: string;
    shellSuperseded: boolean;
  };
  renderedConnection?: string;
  renderedRows?: Array<{
    key: string;
    turnId?: string;
    role?: string;
    textLength: number;
    textPreview: string;
  }>;
  streaming: {
    present: boolean;
    activityHint?: string;
    textLength: number;
    toolCallCount: number;
    turnId?: string;
  };
  transcript: ReplayTranscriptRowObservation[];
  history: {
    messageCount: number;
    hasMore: boolean;
  };
  scroll?: ReplayScrollObservation;
  issues: ReplayIssue[];
  delta?: ReplayObservationDelta;
}
