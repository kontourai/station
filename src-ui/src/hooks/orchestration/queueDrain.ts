import { agentId } from '@kontourai/station-contracts/agent-identity';
import { SESSION_ENDED_REJECTION_CODE } from '@kontourai/station-contracts/session-lifecycle';
import { contextRegistry } from '@kontourai/station-sdk';
import { ChatHttpError } from '@kontourai/station-sdk/client';
import { conversationCanMutate } from '../../components/chat-dock/conversationOpenPolicy';
import { activeChatsStore } from '../../contexts/active-chats-store';
import { ambientContextForSend } from '../../utils/chatAmbientContext';
import { buildOutgoingUserMessage } from '../useActiveChatSessions.helpers';
import { sendExecutionMessage } from '../useOrchestration';

/**
 * Pending-queue drain for orchestration-driven sessions (Claude/Codex
 * runtime, ACP) — archive#613.
 *
 * useActiveChatSessionMessaging.ts's queue drain (archive#704) only runs on the
 * server-managed (Bedrock) send path: its orchestration branch returns as
 * soon as the `sendTurn` command is acked, well before the turn actually
 * finishes, so it never reaches that drain check. For an orchestration
 * thread, turn completion instead arrives later as a `turn.completed` SSE
 * event — so this hooks the same pop-the-head/isEditingQueue-guard/~100ms
 * settle-delay contract into that event instead of a manual setTimeout
 * recursion: dispatching the drained message starts a new turn, and that
 * turn's own future `turn.completed` naturally re-invokes this and
 * continues the chain (see handleTurnCompletedEvent in turnHandlers.ts).
 */
/**
 * Refusal codes the server itself declares retryable but returns as 400:
 * the chat route's catch-all (orchestration.ts) collapses EVERY
 * non-indeterminate dispatch error into a 400 whose body carries the error's
 * `code` — including load shedding (`resource_posture_critical`, clears when
 * load drops, which is exactly when messages queue) and adoption
 * continuation (`adoption_continuation_in_progress`, "retry shortly"). So
 * this discriminator must consult the parsed body code, not just the class
 * and status.
 */
const RETRYABLE_REJECTION_CODES: ReadonlySet<string> = new Set([
  'resource_posture_critical',
  'adoption_continuation_in_progress',
  // A direct conversation can be lazily bound when its queued follow-up is
  // retried. Dropping the message here discarded the only user-owned copy
  // before that binding could happen.
  'continuation_workspace_direct_mismatch',
  // A conversation that was NEVER bound to a workspace: the
  // caller can continue it as it is or bind one, so the follow-up must be
  // retained for that retry, not discarded as a permanent rejection.
  'continuation_workspace_unbound',
]);

/**
 * A definitive client rejection (HTTP 4xx) fails identically on every retry
 * requeueing it at the head poisons the drain into an infinite refusal
 * loop (archive#3027). Discriminated on the SDK's typed
 * ChatHttpError seam (status + parsed body code), never on reason text.
 * Excluded from the drop, keeping the requeue path:
 * - indeterminate refusals: the turn MAY have started;
 * - 401 (re-pairing/auth recovery fixes it), 408/429 (timeout/backpressure);
 * - server-declared-retryable body codes (see RETRYABLE_REJECTION_CODES).
 */
function isDefinitiveClientRejection(error: unknown): boolean {
  if (!(error instanceof ChatHttpError)) return false;
  if (error.status < 400 || error.status >= 500) return false;
  if (error.status === 401 || error.status === 408 || error.status === 429) {
    return false;
  }
  if ((error as { outcome?: unknown }).outcome === 'indeterminate') {
    return false;
  }
  if (error.code !== undefined && RETRYABLE_REJECTION_CODES.has(error.code)) {
    return false;
  }
  return true;
}

/**
 * The Retry on a `continuation_workspace_unbound`
 * refusal resubmitted through the same drain with the chat's unchanged
 * `projectSlug`, which supplies the same project workspace — so it reproduced
 * the identical refusal, deterministically, every time. The server's own
 * message names the recovery ("Continue it as it is, or start a new chat in
 * this workspace"), and this is the first half of it: a retry after that
 * specific refusal sends the follow-up to the conversation WITHOUT a
 * workspace, which is the only shape an unbound conversation can accept.
 *
 * Deliberately keyed on the refusal the server recorded, not on a UI flag: no
 * other refusal changes what is sent, and a button that repeats a
 * deterministic failure is worse than no button.
 */
export function drainQueuedMessageOnTurnCompleted(
  apiBase: string,
  threadId: string,
) {
  const chat = activeChatsStore.getSnapshot()[threadId];
  if (
    !chat?.queuedMessages?.length ||
    chat.isEditingQueue ||
    !conversationCanMutate(chat)
  ) {
    return;
  }

  const [nextMessage, ...remainingQueue] = chat.queuedMessages;
  const continueUnbound =
    chat.queuedMessageFailure?.code === 'continuation_workspace_unbound';
  // A fresh attempt clears the previous refusal: the reason on screen must
  // describe THIS attempt, never a stale one.
  activeChatsStore.updateChat(threadId, {
    queuedMessages: remainingQueue,
    queuedMessageFailure: undefined,
  });

  setTimeout(() => {
    const current = activeChatsStore.getSnapshot()[threadId];
    if (!current) {
      return;
    }

    const { messages, clientId } = buildOutgoingUserMessage(
      current.messages,
      nextMessage,
    );
    activeChatsStore.updateChat(threadId, {
      status: 'sending',
      messages,
    });

    if (!current.agentSlug) {
      activeChatsStore.updateChat(threadId, {
        status: 'error',
        error:
          'This chat has no agent to send to. Your message is still queued.',
        queuedMessages: [nextMessage, ...(current.queuedMessages ?? [])],
      });
      return;
    }

    sendExecutionMessage({
      apiBase,
      target: {
        ...(!current.projectSlug || continueUnbound
          ? { environment: { kind: 'current' as const } }
          : {}),
        agent: agentId(current.agentSlug),
        ...(current.model || Object.keys(current.providerOptions ?? {}).length
          ? {
              model: {
                ...(current.model ? { override: current.model } : {}),
                ...(current.providerOptions
                  ? { options: current.providerOptions }
                  : {}),
              },
            }
          : {}),
        ...(current.projectSlug && !continueUnbound
          ? {
              workspace: {
                kind: 'project',
                projectSlug: current.projectSlug,
              },
            }
          : {}),
      },
      message: nextMessage,
      conversationId: current.conversationId ?? threadId,
      // Queued sends recompute ambient context at drain time so the model
      // still receives it (mirrors the server-managed drain — archive#685
      // the splice-based path embedded it, out-of-band must
      // re-attach it explicitly).
      ambientContext: ambientContextForSend(
        contextRegistry.getComposedContext(),
        nextMessage,
      ),
    })
      .then(() => {
        // Say what the retry actually did: the follow-up went to the
        // conversation as it is, NOT into the project workspace the chat is
        // grouped under. Silently dropping the workspace would be a second
        // label-vs-derivation defect in the fix for the first one.
        if (!continueUnbound) return;
        activeChatsStore.addEphemeralMessage(threadId, {
          role: 'system',
          content:
            'Sent to this conversation as it is. It was started without a workspace, so it does not run inside your project directory.',
        });
      })
      .catch((error: unknown) => {
        // A failed drain must never strand the session at 'sending' with the
        // popped message silently lost — surface it like the interactive send
        // path does and requeue the message at the head so nothing is dropped.
        const failed = activeChatsStore.getSnapshot()[threadId];
        // archive#1293: remove the optimistic entry
        // this drain appended above, by its clientId — mirrors
        // rejectedSendRollback in useActiveChatSessionMessaging.ts. Without
        // this, the failed optimistic message stayed in `messages` while only
        // its TEXT was re-queued; the next successful drain of that same text
        // then appended a SECOND optimistic entry, producing a duplicate
        // bubble on retry-after-failure — the archive#1293 symptom from this second
        // producer of optimistic messages.
        const messagesAfterRollback = failed?.messages?.filter(
          (message) => message.clientId !== clientId,
        );
        // archive#3027: a definitive 4xx refusal is dropped instead
        // of requeued — retrying a permanent rejection forever is queue
        // poison. Transient/network failures keep the requeue-at-head path.
        const dropPermanentlyRejected = isDefinitiveClientRejection(error);
        const reason = error instanceof Error ? error.message : String(error);
        const code =
          error instanceof ChatHttpError && typeof error.code === 'string'
            ? error.code
            : undefined;
        const sessionEnded =
          dropPermanentlyRejected && code === SESSION_ENDED_REJECTION_CODE;
        // A permanent Station-side refusal of a QUEUED follow-up is not an
        // error state of the chat: the conversation itself is settled, and
        // only this follow-up was undeliverable. Setting `status: 'error'`
        // made the inbox chip read "Failed" for it — a queue refusal
        // attributed to the agent's work (the label-without-a-derivation
        // defect). First fixed for session_ended only; the archive#3706
        // showed every other definitive 4xx still did it, with the refusal
        // now carried durably by the unsent record below, so ALL permanent
        // drops return the chat to idle. Transient failures keep 'error':
        // their send is still pending in the queue and needs attention.
        activeChatsStore.updateChat(threadId, {
          ...(dropPermanentlyRejected
            ? { status: 'idle' as const, error: undefined }
            : { status: 'error' as const, error: reason }),
          queuedMessages: dropPermanentlyRejected
            ? (failed?.queuedMessages ?? [])
            : [nextMessage, ...(failed?.queuedMessages ?? [])],
          // archive#3706: a permanent drop removes the queue row and rolls
          // back the bubble, so before this the user's text survived only in
          // the ephemeral notice's echo — which never survives a reload
          // (archive#1292). Record it durably. Not a queue: nothing drains
          // it, and it leaves only by the user's own dismiss.
          ...(dropPermanentlyRejected
            ? {
                unsentMessages: [
                  ...(failed?.unsentMessages ?? []),
                  {
                    // `at` orders and displays; `id` is the dismiss/React
                    // key — Date.now is not an identity (two drains can
                    // settle in one millisecond; archive#3706).
                    id: crypto.randomUUID(),
                    content: nextMessage,
                    reason: sessionEnded
                      ? 'This chat had already ended when Station tried to send it.'
                      : reason,
                    at: Date.now(),
                  },
                ],
              }
            : {}),
          // recorded on the CHAT, not only as an ephemeral notice,
          // so the retained message and the reason it is still retained survive
          // a reload together. A dropped message has no queue row left to carry
          // a reason, so it keeps only the notice (which echoes the text).
          ...(dropPermanentlyRejected
            ? { queuedMessageFailure: undefined }
            : {
                queuedMessageFailure: {
                  message: reason,
                  ...(code ? { code } : {}),
                  at: Date.now(),
                },
              }),
          ...(messagesAfterRollback ? { messages: messagesAfterRollback } : {}),
        });
        // archive#1292: routed through addEphemeralMessage (not a raw
        // `ephemeralMessages` assignment) so this notice gets a real
        // id/timestamp, same as every other failure-path notice.
        activeChatsStore.addEphemeralMessage(threadId, {
          role: 'system',
          // The dropped text is echoed into the notice because it survives
          // nowhere else on the drop path (bubble rolled back, queue entry
          // removed) — the user must be able to copy it back out. The requeue
          // path keeps the text in queuedMessages, so it needs no echo.
          content: sessionEnded
            ? // Attributed to what actually happened: the session had already
              // ended when the queue tried to deliver. No raw lifecycle prose,
              // but the text is still echoed — it survives nowhere else.
              `This chat had already ended, so your queued message was not sent.\nYour message: ${nextMessage}`
            : dropPermanentlyRejected
              ? `Your queued message was refused and removed from the queue: ${
                  error instanceof Error ? error.message : String(error)
                }\nYour message: ${nextMessage}`
              : `Queued message failed to send: ${
                  error instanceof Error ? error.message : String(error)
                }`,
        });
      });
  }, 100);
}
