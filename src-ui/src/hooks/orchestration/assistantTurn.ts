import { activeChatsStore } from '../../contexts/active-chats-store';
import { deriveLatestPlanArtifactFromMessages } from '../../utils/planArtifacts';
import { pruneStaleFailureMarkers } from '../../utils/sessionFailure';
import { buildAssistantTurnContent } from './messageParts';

/**
 * archive#1410: the turn identity and provenance envelope the terminal
 * `turn.completed` frame carried. The live chat path commits its assistant
 * bubble here and never refetches, so anything not attached at this moment
 * is invisible until a remount — which is why the envelope rides the SSE
 * frame rather than waiting for the next REST projection.
 */
interface FinalizedTurnProvenance {
  turnId?: string;
  provenance?: unknown;
  answerEligible?: boolean;
}

export function finalizeAssistantTurn(
  threadId: string,
  fallbackText?: string,
  turnProvenance?: FinalizedTurnProvenance,
) {
  const chat = activeChatsStore.getChatForExecutionSession(threadId);
  if (!chat) return;

  const streamingMessage = chat.streamingMessage;
  const content = buildAssistantTurnContent(streamingMessage, fallbackText);

  // archive#1294: `handleRuntimeErrorEvent` (turnHandlers.ts) appends the raw
  // failure text into the streaming shell's own contentParts purely so a
  // failed turn doesn't render blank while `status: 'error'` suppresses the
  // streaming shell itself — never meant to become a persisted assistant
  // bubble. If a `turn.completed` for this thread still arrives afterward
  // (some adapters emit one even after an error) and this turn's content is
  // EXACTLY that injected error text (nothing else was streamed as text),
  // the `[SYSTEM_EVENT] [CHAT_ERROR]` marker / ephemeral "Retry" notice
  // already owns this failure's presentation — committing the same text
  // again here would render it a second time, as a normally-invisible
  // assistant message that a later render could still surface.
  const isDuplicateErrorText =
    chat.status === 'error' &&
    !!chat.error &&
    content.replace(/ \(repeated \d+×\)$/, '') === chat.error;

  // archive#1294: `content` only ever joins text/reasoning
  // parts (`buildAssistantTurnContent`) — a turn that made tool calls but
  // narrated no text before erroring reduces `content` to exactly
  // `chat.error` too, even though the streamed message also carries a real
  // tool-invocation record. The guard above must only ever suppress the
  // duplicated error TEXT, never the whole message — dropping the message
  // entirely would silently discard that tool-call record (pre-archive#1294 it
  // always committed).
  const nonTextParts = (streamingMessage?.contentParts || []).filter(
    (part) => part.type !== 'text' && part.type !== 'reasoning',
  );
  const hasNonTextParts = nonTextParts.length > 0;

  if (
    (!content && !(streamingMessage?.contentParts || []).length) ||
    (isDuplicateErrorText && !hasNonTextParts)
  ) {
    activeChatsStore.updateChat(threadId, {
      status: 'idle',
      orchestrationTurnOpen: false,
      // archive#1410: the turn is closed; a later terminal event must not
      // find a stale open identity to match against.
      openTurnId: undefined,
      // turn.completed is the turn's terminal event; without this, a session
      // whose provider emits no post-turn session.state-changed keeps
      // orchestrationStatus 'running' and isSessionExecutionActive renders an
      // empty "Working…" streaming shell forever (archive#1005 — reproduced live
      // with Claude Code and OpenCode engines).
      orchestrationStatus: 'idle',
      streamingMessage: undefined,
      isProcessingStep: false,
      activityHint: undefined,
    });
    return;
  }

  // Duplicate error text alongside a real tool-call record: commit the
  // message so the tool-invocation parts survive, but strip the duplicated
  // error text (every text/reasoning part — `isDuplicateErrorText` being
  // true means they joined to EXACTLY `chat.error`, so there is no other
  // narrated text being discarded) so the failure text itself still isn't
  // rendered a second time.
  const committedContent = isDuplicateErrorText ? '' : content;
  const committedContentParts = isDuplicateErrorText
    ? nonTextParts
    : streamingMessage?.contentParts;

  // archive#1295: no normal write path stamped this before, so a healthy
  // chat's `latestChatTimestamp` reduced to 0 for every finalized assistant
  // turn too — the live conversation sorted dead last and a finished chat
  // skipped "Just finished" straight into "Earlier".
  const finalizedMessage = {
    role: 'assistant' as const,
    content: committedContent,
    contentParts: committedContentParts,
    timestamp: Date.now(),
    // The live terminal path must carry the same row-scoped execution
    // Session identity as the durable projection. Otherwise a conversation
    // that later replaces its active Session would attach this historical
    // answer to the wrong execution record before the next reload.
    sessionId: threadId,
    ...(turnProvenance?.answerEligible ? { answerEligible: true } : {}),
    // Only stamped when the terminal frame actually carried them: a turn
    // whose envelope the server could not assemble commits without one and
    // claims nothing, rather than inheriting a neighbouring turn's.
    ...(turnProvenance?.turnId ? { turnId: turnProvenance.turnId } : {}),
    ...(turnProvenance?.provenance !== undefined
      ? { provenance: turnProvenance.provenance }
      : {}),
  };

  // this turn ended successfully, so every failure
  // card about an EARLIER turn is stale — it used to survive here and sit
  // beside the new answer, still claiming the conversation had failed. A card
  // for THIS turn (a failure that a later terminal followed) is kept by the
  // same rule.
  const priorMessages = pruneStaleFailureMarkers(
    chat.messages || [],
    turnProvenance?.turnId ?? chat.openTurnId,
  );
  activeChatsStore.updateChat(threadId, {
    messages: [...priorMessages, finalizedMessage],
    planArtifact: deriveLatestPlanArtifactFromMessages([
      ...priorMessages,
      finalizedMessage,
    ] as any),
    streamingMessage: undefined,
    status: 'idle',
    orchestrationStatus: 'idle',
    orchestrationTurnOpen: false,
    openTurnId: undefined,
    isProcessingStep: false,
    activityHint: undefined,
  });
}
