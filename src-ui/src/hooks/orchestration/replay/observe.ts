import { extensionNotificationBinding } from '@shared/extension-notification-bindings';
import type { ChatUIState } from '../../../contexts/active-chats-state';
import { isTurnStreamLive } from '../../../utils/execution';
import type { OrchestrationEvent } from '../types';
import type {
  ReplayIssue,
  ReplayObservation,
  ReplayScrollObservation,
  ReplayTranscriptRowObservation,
} from './observation-types';

export type * from './observation-types';

/** Methods `handleOrchestrationEvent` actually folds. Keep in lockstep with its switch. */
const UI_FOLDED_ORCHESTRATION_METHODS = [
  'session.started',
  'session.configured',
  'session.state-changed',
  'session.exited',
  'turn.started',
  'content.text-delta',
  'content.reasoning-delta',
  'tool.started',
  'tool.progress',
  'tool.completed',
  'request.opened',
  'request.resolved',
  'turn.completed',
  'turn.aborted',
  'runtime.error',
  'runtime.warning',
  'flow.run-attached',
  'flow.gate-verdict',
  'plan.updated',
  'extension.notification',
  'token-usage.updated',
  'session.stop-settled',
  'policy.hooks-attached',
  'policy.stop-verdict',
  'platform.mutation',
  'workflow.state-changed',
  'conversation.forked',
] as const;

const PREVIEW_CHARS = 160;

function preview(text: string): string {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  return trimmed.length <= PREVIEW_CHARS
    ? trimmed
    : `${trimmed.slice(0, PREVIEW_CHARS - 1)}…`;
}

function toolNamesFromParts(
  parts:
    | (ChatUIState['streamingMessage'] extends infer Message
        ? Message extends { contentParts?: infer Parts }
          ? Parts
          : never
        : never)
    | undefined,
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
  if (
    event?.method === 'turn.completed' &&
    !isTurnStreamLive(chat) &&
    !(chat.messages ?? []).some(
      (message) =>
        message.role === 'assistant' &&
        message.turnId === event.turnId &&
        (Boolean(message.content?.trim()) ||
          message.contentParts?.some(
            (part) => part.type === 'text' && Boolean(part.content?.trim()),
          )),
    )
  ) {
    issues.push({
      code: 'no-text-after-completed-turn',
      detail:
        'The turn completed without any recorded assistant text for this turn.',
    });
  }
  if (
    event &&
    !UI_FOLDED_ORCHESTRATION_METHODS.includes(
      event.method as (typeof UI_FOLDED_ORCHESTRATION_METHODS)[number],
    )
  ) {
    issues.push({
      code: 'unhandled-canonical-method',
      detail: `The dock does not fold ${event.method}; replay applied it as a no-op.`,
    });
  }
  if (event?.method === 'extension.notification') {
    const bound = extensionNotificationBinding(event.namespace, event.type);
    if (!bound) {
      issues.push({
        code: 'unbound-extension-notification',
        detail: `No extension binding for ${event.namespace}/${event.type}; the dock ignores it.`,
      });
    }
  }
  if (event?.method === 'session.exited') {
    const droppedText = chat.streamingMessage?.content?.trim() ?? '';
    if (droppedText.length > 0 && (chat.messages ?? []).length === 0) {
      issues.push({
        code: 'in-flight-content-dropped-on-session-exit',
        detail:
          'The session exited while streaming text was buffered and never committed as a settled row.',
      });
    }
  }
  return issues;
}

function collectReplayScroll(
  container: HTMLElement | null,
): ReplayScrollObservation | undefined {
  if (!container) return undefined;
  const gap =
    container.scrollHeight - container.scrollTop - container.clientHeight;
  const atBottom = gap <= 32;
  const containerBounds = container.getBoundingClientRect();
  const visibleMessageKeys = [
    ...container.querySelectorAll<HTMLElement>('[data-chat-message-key]'),
  ]
    .filter((node) => {
      const bounds = node.getBoundingClientRect();
      return (
        bounds.bottom > containerBounds.top &&
        bounds.top < containerBounds.bottom
      );
    })
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
    execution: {
      status: input.chat.status,
      orchestrationStatus: input.chat.orchestrationStatus,
      turnOpen: input.chat.orchestrationTurnOpen === true,
      openTurnId: input.chat.openTurnId,
      shellSuperseded: input.chat.openTurnShellSuperseded === true,
    },
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
  if (input.transcriptElement) {
    observation.renderedConnection =
      [
        ...input.transcriptElement.ownerDocument.querySelectorAll<HTMLElement>(
          '[data-chat-stream-status]',
        ),
      ].find((element) => element.dataset.chatStreamStatus === input.replayId)
        ?.textContent ?? undefined;
    observation.renderedRows = [
      ...input.transcriptElement.querySelectorAll<HTMLElement>(
        '[data-chat-message-key]',
      ),
    ].map((node) => ({
      key: node.dataset.chatMessageKey ?? '',
      turnId: node.dataset.chatTurnId,
      role: node.dataset.chatRole,
      textLength: Number(node.dataset.chatTextLength ?? 0),
      textPreview: preview(node.innerText ?? node.textContent ?? ''),
    }));
    const latest = [...(input.chat.messages ?? [])]
      .reverse()
      .find(
        (row) => row.role === 'assistant' && row.answerEligible && row.turnId,
      );
    if (latest && observation.scroll?.atBottom && !streaming) {
      const rendered = observation.renderedRows.filter(
        (row) => row.role === 'assistant' && row.turnId === latest.turnId,
      );
      if (
        rendered.length > 0 &&
        Math.max(...rendered.map((row) => row.textLength)) <
          (latest.content?.length ?? 0)
      ) {
        issues.push({
          code: 'completed-answer-not-rendered',
          detail:
            'The mounted transcript projects less text than the completed live answer.',
        });
      }
      if (rendered.length > 1)
        issues.push({
          code: 'rendered-duplicate-turn',
          detail:
            'The mounted transcript contains duplicate assistant rows for the completed turn.',
        });
    }
  }
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
      stateChanges: Object.entries(observation.execution)
        .filter(
          ([field, value]) =>
            input.previous?.execution?.[
              field as keyof ReplayObservation['execution']
            ] !== value,
        )
        .map(([field, value]) => ({
          field,
          before:
            input.previous?.execution?.[
              field as keyof ReplayObservation['execution']
            ],
          after: value,
        })),
    };
  }
  return observation;
}
