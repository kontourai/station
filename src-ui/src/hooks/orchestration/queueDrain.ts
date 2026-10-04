import {
  MUSE_TURN_SLOT_RELEASING_CODE,
  PROVIDER_TURN_IN_PROGRESS_CODE,
} from '@kontourai/station-contracts/provider';
import { SESSION_ENDED_REJECTION_CODE } from '@kontourai/station-contracts/session-lifecycle';
import { contextRegistry } from '@kontourai/station-sdk';
import { ChatHttpError } from '@kontourai/station-sdk/client';
import { randomCorrelationId } from '@kontourai/station-shared/random-id';
import { isTurnInFlight } from '../../contexts/active-chats-state';
import { activeChatsStore } from '../../contexts/active-chats-store';
import { conversationCanMutate } from '../../contexts/conversation-open-policy';
import {
  approvalPickReceived,
  supersededPickNote,
} from '../../utils/approvalMode';
import { ambientContextForSend } from '../../utils/chatAmbientContext';
import {
  liveTurnTarget,
  serverTurnLive,
} from '../../utils/conversation-activity';
import { userFacingErrorMessage } from '../../utils/errorText';
import { buildOutgoingUserMessage } from '../useActiveChatSessions.helpers';
import { isReplayThread } from './replay/replay-registry';

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
 * `code` — including adoption continuation
 * (`adoption_continuation_in_progress`, "retry shortly"). So
 * this discriminator must consult the parsed body code, not just the class
 * and status.
 */
const RETRYABLE_REJECTION_CODES: ReadonlySet<string> = new Set([
  'resource_engine_start_capacity',
  'adoption_continuation_in_progress',
  // A direct conversation can be lazily bound when its queued follow-up is
  // retried. Dropping the message here discarded the only user-owned copy
  // before that binding could happen.
  'continuation_workspace_direct_mismatch',
  // A conversation that was NEVER bound to a workspace: the
  // caller can continue it as it is or bind one, so the follow-up must be
  // retained for that retry, not discarded as a permanent rejection.
  'continuation_workspace_unbound',
  // #2300: a Muse send that arrived while the previous turn's process was
  // still exiting (past the adapter's short wait). The same send succeeds
  // once that process is gone.
  MUSE_TURN_SLOT_RELEASING_CODE,
  // #2324: a send that arrived while the engine was running a turn it opened
  // on its own. The same send succeeds once that turn ends.
  PROVIDER_TURN_IN_PROGRESS_CODE,
]);

/**
 * A definitive client rejection (HTTP 4xx) fails identically on every retry
 * requeueing it at the head poisons the drain into an infinite refusal
 * loop (archive#3027). Discriminated on the SDK's typed
 * ChatHttpError seam (status + parsed body code), never on reason text.
 * Excluded from the drop, keeping the requeue path:
 * - a response that is not Station's answer (a proxy's HTML 403 or 404,
 *   #2708): it keeps its status but says nothing Station decided;
 * - indeterminate refusals: the turn MAY have started;
 * - 401 (re-pairing/auth recovery fixes it), 408/429 (timeout/backpressure);
 * - server-declared-retryable body codes (see RETRYABLE_REJECTION_CODES).
 */
function isDefinitiveClientRejection(error: unknown): boolean {
  if (!(error instanceof ChatHttpError)) return false;
  if (!error.stationEnvelope) return false;
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
/**
 * Why an explicit user request to send the queue head cannot go now, or
 * undefined when it can. An explicit action is never a silent no-op: the
 * reason is said in the chat (#2309 review).
 */
function userSendBlockedReason(
  chat: ReturnType<typeof activeChatsStore.getSnapshot>[string] | undefined,
  selectedMessage = false,
): string | undefined {
  if (!chat?.queuedMessages?.length) return undefined;
  if (!selectedMessage && chat.queuedMessageMetadata?.[0]?.delivery)
    return 'Steering delivery is not confirmed. Use Retry steering before sending it as a new turn.';
  if (chat.queueDrainSettling) return 'A queued message is already being sent.';
  // Any send of this chat's that the server has not started yet: a queued
  // follow-up the drain dispatched, or a message sent from the composer.
  if (chat.sendAwaitingTurnStart)
    return 'A message is already on its way; the queue waits until it has started.';
  if (chat.isEditingQueue)
    return 'Finish editing the queued message first, then send it.';
  if (!conversationCanMutate(chat))
    return 'This conversation cannot take a new message right now.';
  return undefined;
}

/**
 * #2309: send the queue head a turn end left held while the chat's binding
 * was being re-proved (see the hold in `drainQueuedMessageOnTurnCompleted`).
 * Called by the revalidation once it has settled; a no-op when nothing is
 * held or the chat is still not writable.
 */
export function resumeHeldQueueDrain(apiBase: string, chatKey: string): void {
  const chat = activeChatsStore.getSnapshot()[chatKey];
  if (!chat?.queueDrainHeldForOpen || !conversationCanMutate(chat)) return;
  activeChatsStore.updateChat(chatKey, { queueDrainHeldForOpen: undefined });
  drainQueuedMessageOnTurnCompleted(apiBase, chatKey);
}

/** #2324 review L2: bounded re-drains for a send refused by a provider turn. */
const PROVIDER_TURN_REDRAIN_DELAY_MS = 1_000;
const PROVIDER_TURN_REDRAIN_MAX_ATTEMPTS = 10;
const providerTurnRedrainAttempts = new Map<string, number>();
const providerTurnRedrainTimers = new Map<
  string,
  ReturnType<typeof setTimeout>
>();

/**
 * The retry fires later, with the `apiBase` it was scheduled under. It is
 * dropped (#2324 delta review) when the chat is gone or no longer names the
 * same conversation and execution by then — a removed chat or a switched
 * Station is not where this message was headed — and a newer schedule for
 * the same chat replaces an older one.
 */
function scheduleProviderTurnRedrain(apiBase: string, threadId: string): void {
  const attempts = providerTurnRedrainAttempts.get(threadId) ?? 0;
  if (attempts >= PROVIDER_TURN_REDRAIN_MAX_ATTEMPTS) {
    providerTurnRedrainAttempts.delete(threadId);
    return;
  }
  providerTurnRedrainAttempts.set(threadId, attempts + 1);
  const scheduled = activeChatsStore.getSnapshot()[threadId];
  const binding = [scheduled?.conversationId, scheduled?.currentSessionId];
  const previous = providerTurnRedrainTimers.get(threadId);
  if (previous) clearTimeout(previous);
  providerTurnRedrainTimers.set(
    threadId,
    setTimeout(() => {
      providerTurnRedrainTimers.delete(threadId);
      const chat = activeChatsStore.getSnapshot()[threadId];
      if (
        !chat ||
        chat.conversationId !== binding[0] ||
        chat.currentSessionId !== binding[1]
      ) {
        providerTurnRedrainAttempts.delete(threadId);
        return;
      }
      // An open turn drains the queue when it ends; only a queue nothing
      // would drain is retried here.
      if (!chat.queuedMessages?.length || serverTurnLive(chat) === true) {
        providerTurnRedrainAttempts.delete(threadId);
        return;
      }
      drainQueuedMessageOnTurnCompleted(apiBase, threadId);
    }, PROVIDER_TURN_REDRAIN_DELAY_MS),
  );
}

export function resumePendingSendNowOnTurnTerminal(
  apiBase: string,
  executionSessionId: string,
  turnId: string,
): void {
  const chatKey =
    activeChatsStore.getChatKeyForExecutionSession(executionSessionId) ??
    executionSessionId;
  const chat = activeChatsStore.getSnapshot()[chatKey];
  const intent = chat?.pendingSendNow;
  if (
    !chat ||
    !intent ||
    intent.threadId !== executionSessionId ||
    intent.turnId !== turnId
  )
    return;
  const index =
    chat.queuedMessageMetadata?.findIndex(
      (message) => message.id === intent.messageId,
    ) ?? -1;
  if (index < 0) {
    activeChatsStore.updateChat(chatKey, { pendingSendNow: undefined });
    return;
  }
  if (chat.queueSendNowPending || chat.queueDrainSettling) {
    activeChatsStore.updateChat(chatKey, {
      pendingSendNow: { ...intent, terminalConfirmed: true },
    });
    return;
  }
  const messages = [...chat.queuedMessages];
  const metadata = [...(chat.queuedMessageMetadata ?? [])];
  messages.unshift(...messages.splice(index, 1));
  metadata.unshift(...metadata.splice(index, 1));
  activeChatsStore.updateChat(chatKey, {
    queuedMessages: messages,
    queuedMessageMetadata: metadata,
    pendingSendNow: undefined,
  });
  drainQueuedMessageOnTurnCompleted(apiBase, chatKey, true, true);
}

/** Explicit override: interrupt immediately, then dispatch only after a settled receipt. */
export async function sendPendingMessageNow(
  apiBase: string,
  threadId: string,
  messageId: string,
): Promise<void> {
  const chat = activeChatsStore.getSnapshot()[threadId];
  if (!chat || chat.queueSendNowPending) return;
  const blocked = userSendBlockedReason(chat, true);
  if (blocked) {
    activeChatsStore.addEphemeralMessage(threadId, {
      role: 'system',
      content: blocked,
    });
    return;
  }
  const index =
    chat.queuedMessageMetadata?.findIndex(
      (message) => message.id === messageId,
    ) ?? -1;
  if (index < 0) return;
  if (chat.queuedMessageMetadata?.[index]?.delivery) {
    activeChatsStore.addEphemeralMessage(threadId, {
      role: 'system',
      content:
        'Steering delivery is not confirmed. Retry steering with this same message before sending it as a new turn.',
    });
    return;
  }
  activeChatsStore.updateChat(threadId, { queueSendNowPending: true });
  const binding = [chat.conversationId, chat.currentSessionId];
  try {
    if (serverTurnLive(chat) === true || chat.status === 'sending') {
      const { interruptOrchestrationTurn } = await import(
        '@kontourai/station-sdk'
      );
      const target = {
        ...liveTurnTarget(chat, threadId),
        turnId: chat.conversationActivity?.openTurn?.turnId ?? chat.openTurnId,
      };
      if (!target.turnId) {
        activeChatsStore.addEphemeralMessage(threadId, {
          role: 'system',
          content:
            'Wait for the turn to start before using Send now. Your message is still pending.',
        });
        return;
      }
      activeChatsStore.updateChat(threadId, {
        pendingSendNow: {
          messageId,
          threadId: target.threadId,
          turnId: target.turnId,
        },
      });
      const result = await interruptOrchestrationTurn({
        ...target,
        apiBase,
        ...(chat.pendingClientTurnId
          ? { clientTurnId: chat.pendingClientTurnId }
          : {}),
      });
      const latest = activeChatsStore.getSnapshot()[threadId];
      const latestTarget = latest
        ? {
            ...liveTurnTarget(latest, threadId),
            turnId:
              latest.conversationActivity?.openTurn?.turnId ??
              latest.openTurnId,
          }
        : undefined;
      if (
        !latest ||
        latest.conversationId !== binding[0] ||
        latest.currentSessionId !== binding[1] ||
        (serverTurnLive(latest) === true &&
          latestTarget?.turnId !== target.turnId)
      )
        return;
      if (result.outcome === 'pending-turn-start') {
        activeChatsStore.addEphemeralMessage(threadId, {
          role: 'system',
          content:
            'Stop requested. Your message waits until the current turn has stopped.',
        });
        return;
      }
      activeChatsStore.updateChat(threadId, {
        orchestrationTurnOpen: false,
        status: 'idle',
        ...(target.turnId ? { stopSettledTurnId: target.turnId } : {}),
      });
    }
    const current = activeChatsStore.getSnapshot()[threadId];
    if (
      !current ||
      current.conversationId !== binding[0] ||
      current.currentSessionId !== binding[1]
    )
      return;
    const currentIndex =
      current.queuedMessageMetadata?.findIndex(
        (message) => message.id === messageId,
      ) ?? -1;
    if (currentIndex < 0) return;
    const messages = [...current.queuedMessages];
    const metadata = [...(current.queuedMessageMetadata ?? [])];
    messages.unshift(...messages.splice(currentIndex, 1));
    metadata.unshift(...metadata.splice(currentIndex, 1));
    activeChatsStore.updateChat(threadId, {
      queuedMessages: messages,
      queuedMessageMetadata: metadata,
      queueSendNowPending: false,
      pendingSendNow: undefined,
    });
    drainQueuedMessageOnTurnCompleted(apiBase, threadId, true, true);
  } catch (error) {
    activeChatsStore.addEphemeralMessage(threadId, {
      role: 'system',
      content: `Stop was not confirmed. Your message is still pending: ${userFacingErrorMessage(error)}`,
    });
  } finally {
    activeChatsStore.updateChat(threadId, { queueSendNowPending: false });
    const intent = activeChatsStore.getSnapshot()[threadId]?.pendingSendNow;
    if (intent?.terminalConfirmed)
      resumePendingSendNowOnTurnTerminal(
        apiBase,
        intent.threadId,
        intent.turnId,
      );
  }
}

export function drainQueuedMessageOnTurnCompleted(
  apiBase: string,
  threadId: string,
  reviewed = false,
  /**
   * #2309: the user asked for this send (Retry, Send now). It is not held
   * back by the server showing a turn open: the user is looking at that
   * record (a stuck turn, a Stop elsewhere) and chose to send anyway. Any
   * other reason it cannot send is said in the chat, never swallowed.
   */
  userInitiated = false,
) {
  if (isReplayThread(threadId)) return;
  const chat = activeChatsStore.getSnapshot()[threadId];
  // #3157: after a usage-limit stop, only the user (Send now) or the resumed
  // turn's own end sends the queue. Live and snapshot paths set the flag.
  if (!userInitiated && chat?.usageLimitStopped) return;
  if (userInitiated) {
    const blocked = userSendBlockedReason(chat);
    if (blocked) {
      activeChatsStore.addEphemeralMessage(threadId, {
        role: 'system',
        sendFailure: true,
        content: blocked,
      });
      return;
    }
  }
  // #2309: a turn end that arrives while the chat's binding is being
  // re-proved (a snapshot adopted the running child and set
  // `conversationOpenPending`) cannot send yet, and nothing else would fire
  // for that turn end. Hold it, so the revalidation that makes the chat
  // writable again sends it (`resumeHeldQueueDrain`), exactly once.
  if (
    !userInitiated &&
    chat?.queuedMessages?.length &&
    !chat.queueDrainSettling &&
    serverTurnLive(chat) !== true &&
    !conversationCanMutate(chat)
  ) {
    if (!chat.queueDrainHeldForOpen)
      activeChatsStore.updateChat(threadId, { queueDrainHeldForOpen: true });
    return;
  }
  if (
    // A popped head that has not been dispatched yet: a second request in
    // that window must not pop the next message too. This is a per-tab guard;
    // two tabs holding copies of the same local queue can still dispatch
    // twice. A shared durable send claim is needed before calling that case
    // exactly once across devices (#2530).
    chat?.queuedMessageMetadata?.[0]?.delivery ||
    chat?.queueDrainSettling ||
    chat?.queueSendNowPending ||
    (!userInitiated && chat?.sendAwaitingTurnStart) ||
    (!userInitiated && chat?.pendingSendNow) ||
    // #2309: an AUTOMATIC drain does not send while the server shows a turn
    // live (a turn started elsewhere, or this chat's own send awaiting its
    // turn); a later turn end drains it.
    (!userInitiated && isTurnInFlight(chat)) ||
    !chat?.queuedMessages?.length ||
    chat.isEditingQueue ||
    (chat.queuedMessageFailure?.reviewReason === 'execution-binding-changed' &&
      !reviewed) ||
    !conversationCanMutate(chat)
  ) {
    return;
  }

  // The popped head is still owned by this execution during the settle
  // delay, even though it is no longer visible in queuedMessages.
  const bindingKeys = [
    'conversationId',
    'currentSessionId',
    'agentSlug',
    'executionMode',
    'orchestrationProvider',
    'agentConnectionId',
  ] as const;
  const scheduledBinding = bindingKeys.map((key) => chat[key]);
  const [nextMessage, ...remainingQueue] = chat.queuedMessages;
  const nextMetadata = chat.queuedMessageMetadata?.[0] ?? {
    id: randomCorrelationId(),
    mode: 'queue' as const,
  };
  const remainingMetadata = chat.queuedMessageMetadata?.slice(1);
  const continueUnbound =
    chat.queuedMessageFailure?.code === 'continuation_workspace_unbound';
  // A fresh attempt clears the previous refusal: the reason on screen must
  // describe THIS attempt, never a stale one.
  activeChatsStore.updateChat(threadId, {
    queuedMessages: remainingQueue,
    queuedMessageMetadata: remainingMetadata,
    pendingQueueDispatch: {
      content: nextMessage,
      metadata: nextMetadata ?? { id: randomCorrelationId(), mode: 'queue' },
    },
    queuedMessageFailure: undefined,
    queueDrainSettling: true,
    queueDrainHeldForOpen: undefined,
  });

  let dispatchAccepted = false;
  setTimeout(async () => {
    try {
      await dispatchDrainedHead();
    } finally {
      if (activeChatsStore.getSnapshot()[threadId]?.queueDrainSettling) {
        activeChatsStore.updateChat(threadId, {
          queueDrainSettling: undefined,
          pendingQueueDispatch: undefined,
        });
      }
      const settled = activeChatsStore.getSnapshot()[threadId];
      if (
        dispatchAccepted &&
        settled?.queuedMessages.length &&
        settled.orchestrationStatus !== 'aborted' &&
        !isTurnInFlight(settled)
      ) {
        drainQueuedMessageOnTurnCompleted(apiBase, threadId);
      }
    }
  }, 100);

  async function dispatchDrainedHead() {
    let dispatchForeground: typeof import('../../lib/foregroundMessageDispatch').dispatchForeground;
    try {
      ({ dispatchForeground } = await import(
        '../../lib/foregroundMessageDispatch'
      ));
    } catch (error) {
      const failed = activeChatsStore.getSnapshot()[threadId];
      if (failed) {
        activeChatsStore.updateChat(threadId, {
          queuedMessages: [nextMessage, ...(failed.queuedMessages ?? [])],
          queuedMessageMetadata: nextMetadata
            ? [nextMetadata, ...(failed.queuedMessageMetadata ?? [])]
            : undefined,
          queuedMessageFailure: {
            message: error instanceof Error ? error.message : String(error),
            at: Date.now(),
          },
        });
      }
      return;
    }
    // Loading the send chunk can yield; re-read authority before mutating.
    const current = activeChatsStore.getSnapshot()[threadId];
    if (!current) {
      return;
    }
    const changedBinding = bindingKeys.some(
      (key, index) => current[key] !== scheduledBinding[index],
    );
    // The terminal event and the resolver can race across the settle delay.
    // Requeue the exact head before any optimistic row or provider effect if
    // the current authoritative state ceased to admit continuation.
    if (
      changedBinding ||
      !conversationCanMutate(current) ||
      current.queuedMessageFailure?.reviewReason === 'execution-binding-changed'
    ) {
      activeChatsStore.updateChat(threadId, {
        queuedMessages: [nextMessage, ...(current.queuedMessages ?? [])],
        queuedMessageMetadata: nextMetadata
          ? [nextMetadata, ...(current.queuedMessageMetadata ?? [])]
          : undefined,
        ...(changedBinding
          ? {
              queuedMessageFailure: {
                reviewReason: 'execution-binding-changed' as const,
                message:
                  'This conversation changed Agent or Session. Review queued messages before retrying.',
                at: Date.now(),
              },
            }
          : {}),
      });
      return;
    }

    const outgoing = buildOutgoingUserMessage(current.messages, nextMessage);
    const clientId = nextMetadata?.id ?? outgoing.clientId;
    const messages = outgoing.messages.map((message) =>
      message.clientId === outgoing.clientId
        ? { ...message, clientId }
        : message,
    );
    activeChatsStore.updateChat(threadId, {
      status: 'sending',
      // #2309: this drain's dispatch is the optimistic window until the
      // server reports its turn open.
      sendAwaitingTurnStart: true,
      messages,
      // The dispatch in flight, as the composer path marks it: its
      // `turn.started` clears it and reconciles this optimistic row, and a
      // Stop before then binds its cancel to this dispatch.
      pendingClientTurnId: clientId,
    });

    if (!current.agentSlug) {
      activeChatsStore.updateChat(threadId, {
        status: 'error',
        error:
          'This chat has no agent to send to. Your message is still queued.',
        queuedMessages: [nextMessage, ...(current.queuedMessages ?? [])],
        queuedMessageMetadata: nextMetadata
          ? [nextMetadata, ...(current.queuedMessageMetadata ?? [])]
          : undefined,
      });
      return;
    }

    await dispatchForeground({
      apiBase,
      sessionId: threadId,
      clientTurnId: clientId,
      agentSlug: current.agentSlug,
      projectSlug: continueUnbound ? undefined : current.projectSlug,
      model: current.model,
      providerOptions: current.providerOptions,
      // #2436: the server applies the recorded posture to this turn. A pick
      // it has not received yet rides along, compare-and-set against the
      // decision this chat had folded.
      setApprovalMode: current.queuedApprovalMode,
      setApprovalModeBasedOn: current.approvalPostureSequence ?? null,
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
      .then((receipt) => {
        dispatchAccepted = true;
        providerTurnRedrainAttempts.delete(threadId);
        // Settled only by what the server reports became of the pick (see
        // the composer send path).
        const carried = current.queuedApprovalMode;
        if (carried && receipt.approvalMode) {
          activeChatsStore.updateChat(
            threadId,
            approvalPickReceived(
              activeChatsStore.getSnapshot()[threadId],
              carried,
              receipt.approvalMode,
            ),
          );
          if (!receipt.approvalMode.recorded) {
            activeChatsStore.addEphemeralMessage(threadId, {
              role: 'system',
              content: supersededPickNote(receipt.approvalMode.approvalMode),
            });
          }
        }
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
        // A validation refusal reads as its reasons, not schema keys (#2708).
        const reason =
          error instanceof Error
            ? userFacingErrorMessage(error)
            : String(error);
        const code =
          error instanceof ChatHttpError && typeof error.code === 'string'
            ? error.code
            : undefined;
        const sessionEnded =
          dropPermanentlyRejected && code === SESSION_ENDED_REJECTION_CODE;
        // #2324 (D4, review L2): the engine is replying on its own. Not a
        // failure of this message: it goes back to the head of the queue,
        // waiting, and the turn it waits for drains it when it ends. If no
        // turn is visibly open (it ended while this send was in flight, or
        // has not published its start yet) nothing else would drain it, so
        // the drain is retried after a short delay, a bounded number of
        // times.
        if (code === PROVIDER_TURN_IN_PROGRESS_CODE) {
          activeChatsStore.updateChat(threadId, {
            status: 'idle',
            error: undefined,
            sendAwaitingTurnStart: undefined,
            queuedMessages: [nextMessage, ...(failed?.queuedMessages ?? [])],
            queuedMessageMetadata: nextMetadata
              ? [nextMetadata, ...(failed?.queuedMessageMetadata ?? [])]
              : undefined,
            queuedMessageFailure: undefined,
            ...(messagesAfterRollback
              ? { messages: messagesAfterRollback }
              : {}),
          });
          scheduleProviderTurnRedrain(apiBase, threadId);
          return;
        }
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
          ...(failed?.pendingClientTurnId === clientId
            ? { pendingClientTurnId: undefined }
            : {}),
          ...(dropPermanentlyRejected
            ? { status: 'idle' as const, error: undefined }
            : { status: 'error' as const, error: reason }),
          sendAwaitingTurnStart: undefined,
          queuedMessages: dropPermanentlyRejected
            ? (failed?.queuedMessages ?? [])
            : [nextMessage, ...(failed?.queuedMessages ?? [])],
          queuedMessageMetadata: dropPermanentlyRejected
            ? failed?.queuedMessageMetadata
            : nextMetadata
              ? [nextMetadata, ...(failed?.queuedMessageMetadata ?? [])]
              : undefined,
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
                    id: randomCorrelationId(),
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
          sendFailure: true,
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
  }
}
