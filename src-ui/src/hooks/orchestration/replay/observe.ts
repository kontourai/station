import type { ChatUIState } from '../../../contexts/active-chats-state';
import { isTurnStreamLive } from '../../../utils/execution';
import type { OrchestrationEvent } from '../types';

export type ReplayIssueCode =
  | 'duplicate-streaming-and-settled'
  | 'streaming-after-turn-completed'
  | 'lineage-leak'
  | 'empty-after-completed-turn';

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

const PREVIEW_CHARS = 160;

function preview(text: string): string {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  return trimmed.length <= PREVIEW_CHARS
    ? trimmed
    : `${trimmed.slice(0, PREVIEW_CHARS - 1)}…`;
}

function toolNamesFromParts(
  parts: ChatUIState['streamingMessage'] extends infer Message
    ? Message extends { contentParts?: infer Parts }
      ? Parts
      : never
    : never,
): string[] {
  if (!parts) return [];
  return parts
    .map((part) => part.toolName || part.name)
    .filter((name): name is string => Boolean(name));
}

function messageRows(chat: ChatUIState): ReplayTranscriptRowObservation[] {
  return (chat.messages ?? []).map((message, index) => ({
    id: message.id ?? `message:${index}`,
    role: message.role,
    turnId: message.turnId,
    kind: 'message' as const,
    textPreview: preview(
      typeof message.content === 'string' ? message.content : '',
    ),
    toolNames: toolNamesFromParts(message.contentParts),
  }));
}

function streamingRow(
  chat: ChatUIState,
): ReplayTranscriptRowObservation | null {
  if (!isTurnStreamLive(chat)) return null;
  const streaming = chat.streamingMessage;
  return {
    id: `${chat.currentSessionId ?? 'replay'}:streaming`,
    role: 'assistant',
    turnId: chat.openTurnId,
    kind: 'streaming',
    textPreview: preview(streaming?.content ?? ''),
    toolNames: toolNamesFromParts(streaming?.contentParts),
  };
}

export function detectReplayIssues(
  chat: ChatUIState,
  event: OrchestrationEvent | undefined,
  sourceThreadId: string,
): ReplayIssue[] {
  const issues: ReplayIssue[] = [];
  const openTurnId = chat.openTurnId;
  const settledSameTurn = (chat.messages ?? []).some(
    (message) =>
      message.role === 'assistant' &&
      openTurnId &&
      message.turnId === openTurnId,
  );
  if (isTurnStreamLive(chat) && settledSameTurn) {
    issues.push({
      code: 'duplicate-streaming-and-settled',
      detail: `Streaming shell and a settled assistant row both claim turn ${openTurnId}.`,
    });
  }
  if (event?.method === 'turn.completed' && isTurnStreamLive(chat)) {
    issues.push({
      code: 'streaming-after-turn-completed',
      detail:
        'The last applied event completed the turn but the streaming shell is still live.',
    });
  }
  if (
    chat.conversationId === sourceThreadId ||
    chat.currentSessionId === sourceThreadId
  ) {
    issues.push({
      code: 'lineage-leak',
      detail:
        'Replay chat carries the source thread lineage; live SSE can fuzzy-match into it.',
    });
  }
  if (
    event?.method === 'turn.completed' &&
    (chat.messages ?? []).length === 0 &&
    !isTurnStreamLive(chat)
  ) {
    issues.push({
      code: 'empty-after-completed-turn',
      detail:
        'A turn completed but the transcript has no messages and no streaming shell.',
    });
  }
  return issues;
}

export function collectReplayScroll(
  container: HTMLElement | null,
): ReplayScrollObservation | undefined {
  if (!container) return undefined;
  const gap =
    container.scrollHeight - container.scrollTop - container.clientHeight;
  const atBottom = gap <= 32;
  const containerTop = container.getBoundingClientRect().top;
  const visibleMessageKeys = [
    ...container.querySelectorAll<HTMLElement>('[data-chat-message-key]'),
  ]
    .filter((node) => node.getBoundingClientRect().bottom > containerTop)
    .map((node) => node.dataset.chatMessageKey ?? '')
    .filter(Boolean);
  return {
    scrollTop: container.scrollTop,
    scrollHeight: container.scrollHeight,
    clientHeight: container.clientHeight,
    isUserScrolledUp: !atBottom,
    atBottom,
    visibleMessageKeys,
    accessibleText: (container.innerText ?? '').slice(0, 4_000),
  };
}

export function collectReplayObservation(input: {
  replayId: string;
  chat: ChatUIState;
  cursorIndex: number;
  eventCount: number;
  event?: OrchestrationEvent;
  sourceThreadId: string;
  transcriptElement?: HTMLElement | null;
  previous?: ReplayObservation | null;
  hasMore?: boolean;
}): ReplayObservation {
  const streaming = streamingRow(input.chat);
  const transcript = [
    ...messageRows(input.chat),
    ...(streaming ? [streaming] : []),
  ];
  const issues = detectReplayIssues(
    input.chat,
    input.event,
    input.sourceThreadId,
  );
  const streamingTextLength = input.chat.streamingMessage?.content?.length ?? 0;
  const observation: ReplayObservation = {
    schemaVersion: 1,
    replayId: input.replayId,
    cursor: {
      index: input.cursorIndex,
      eventCount: input.eventCount,
      eventId: input.event?.eventId,
      method: input.event?.method,
      turnId:
        input.event && 'turnId' in input.event
          ? (input.event.turnId as string | undefined)
          : input.chat.openTurnId,
    },
    atEnd: input.cursorIndex >= input.eventCount - 1,
    streaming: {
      present: Boolean(streaming),
      activityHint: input.chat.activityHint?.kind,
      textLength: streamingTextLength,
      toolCallCount: streaming?.toolNames.length ?? 0,
      turnId: input.chat.openTurnId,
    },
    transcript,
    history: {
      messageCount: input.chat.messages?.length ?? 0,
      hasMore: Boolean(input.hasMore),
    },
    scroll: collectReplayScroll(input.transcriptElement ?? null),
    issues,
  };
  if (input.previous) {
    const previousIds = new Set(input.previous.transcript.map((row) => row.id));
    const nextIds = new Set(transcript.map((row) => row.id));
    observation.delta = {
      addedRowIds: transcript
        .map((row) => row.id)
        .filter((id) => !previousIds.has(id)),
      removedRowIds: input.previous.transcript
        .map((row) => row.id)
        .filter((id) => !nextIds.has(id)),
      streamingTextDeltaLength:
        streamingTextLength - input.previous.streaming.textLength,
      issueCodesAdded: issues
        .map((issue) => issue.code)
        .filter(
          (code) =>
            !input.previous?.issues.some((issue) => issue.code === code),
        ),
    };
  }
  return observation;
}
