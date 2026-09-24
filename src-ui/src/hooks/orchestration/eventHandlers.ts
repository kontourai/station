import type { OrchestrationConversationStreamBinding } from '@kontourai/station-contracts/orchestration';
import { isDeferredRetriableTurnError } from '@kontourai/station-contracts/runtime-events';
import { activeChatsStore } from '../../contexts/active-chats-store';
import { backgroundTasksStore } from '../../contexts/background-tasks-store';
import { childWorkGlobalStore } from '../../contexts/child-work-global-store';
import { deviceSettingsStore } from '../../lib/device-settings-store';
import {
  handleRequestOpenedEvent,
  handleRequestResolvedEvent,
} from './approvalHandlers';
import {
  handleChildWorkUpdatedEvent,
  observeChildWorkLifecycle,
} from './childWorkHandlers';
import { handleExtensionNotificationEvent } from './extensionHandlers';
import {
  handleFlowGateVerdictEvent,
  handleFlowRunAttachedEvent,
} from './flowHandlers';
import {
  handleConversationForkedEvent,
  handlePlatformMutationEvent,
  handlePolicyHooksAttachedEvent,
  handlePolicyStopVerdictEvent,
  handleWorkflowStateChangedEvent,
} from './governanceHandlers';
import { handlePlanUpdatedEvent } from './planHandlers';
import { drainQueuedMessageOnTurnCompleted } from './queueDrain';
import { recordReplayRuntime } from './replay/capture-tap';
import { isReplayThread } from './replay/replay-registry';
import {
  handleSessionExitedEvent,
  handleSessionLifecycleEvent,
  handleSessionStateChangedEvent,
  handleSessionStopSettledEvent,
} from './sessionHandlers';
import {
  handleReasoningDeltaEvent,
  handleTextDeltaEvent,
  handleToolCompletedEvent,
  handleToolProgressEvent,
  handleToolStartedEvent,
} from './streamHandlers';
import { recordEventPosition } from './streamPosition';
import {
  handleRuntimeErrorEvent,
  handleRuntimeWarningEvent,
  handleTurnAbortedEvent,
  handleTurnCompletedEvent,
  handleTurnStartedEvent,
} from './turnHandlers';
import type { OrchestrationEvent } from './types';
import { handleTokenUsageUpdatedEvent } from './usageHandlers';

let semanticDelivery:
  | import('./semanticDeliveryBuffer').SemanticDeliveryBuffer
  | undefined;
let semanticDeliveryLoading = false;
function bufferedDeliveryEnabled() {
  return deviceSettingsStore.get('featureSettings').bufferedDelivery;
}

function loadSemanticDelivery(): void {
  if (!bufferedDeliveryEnabled() || semanticDelivery || semanticDeliveryLoading)
    return;
  semanticDeliveryLoading = true;
  void import('./semanticDeliveryBuffer').then(
    ({ createDeviceSemanticDeliveryBuffer }) => {
      semanticDeliveryLoading = false;
      if (!bufferedDeliveryEnabled() || semanticDelivery) return;
      semanticDelivery = createDeviceSemanticDeliveryBuffer(
        dispatchProjectedOrchestrationEvent,
      );
    },
    () => (semanticDeliveryLoading = false),
  );
}

/** Flush device-local presentation state before a stream replacement/stop. */
export function settleSemanticDeliveryBuffer(
  apiBase: string,
  terminal?: boolean,
): void {
  if (terminal === undefined) semanticDelivery?.flushApiBase(apiBase);
  else semanticDelivery?.interruptApiBase(apiBase, terminal);
}

export function handleOrchestrationEvent(
  apiBase: string,
  event: OrchestrationEvent,
  /**
   * archive#1410: the turn provenance envelope the server attached beside a
   * `turn.completed` frame, exactly as it arrived. Deliberately `unknown` —
   * only the card narrows it, so an envelope from another Station version
   * degrades honestly instead of being partly believed here.
   */
  provenance?: unknown,
  conversation?: OrchestrationConversationStreamBinding,
  /**
   * #2334: the server's stream sequence for this frame (the SSE id). Lets an
   * approval report be ordered against the user's pick.
   */
  position?: number,
) {
  recordEventPosition(apiBase, event, position);
  if (
    conversation?.currentSessionId === event.threadId &&
    (event.method === 'session.started' ||
      event.method === 'session.configured') &&
    !isReplayThread(event.threadId)
  ) {
    const key = activeChatsStore.getChatKeyForExecutionSession(
      conversation.conversationId,
    );
    if (
      key &&
      !isReplayThread(key) &&
      activeChatsStore.getSnapshot()[key]?.currentSessionId !== event.threadId
    )
      activeChatsStore.updateChat(key, {
        currentSessionId: event.threadId,
        conversationId: conversation.conversationId,
        conversationOpenPending: true,
        conversationOpenFailed: false,
      });
  }
  // #2309: the binding's activity is the conversation's record AS OF
  // DELIVERY, so it is applied on arrival, before the event itself is
  // dispatched (possibly later, through the semantic delivery buffer). Replay
  // frames never feed it: a recorded record would land on the live chat of
  // the same conversation.
  if (conversation?.activity && !isReplayThread(event.threadId)) {
    activeChatsStore.applyConversationActivity(conversation.activity);
  }
  recordReplayRuntime(apiBase, event, provenance);
  // archive#1301: ingest BEFORE the `if (!chat) return` guard below —
  // a delegate session's events arrive on the delegate's own threadId, which
  // is never opened as a chat, so the guard would otherwise drop every event
  // the background-tasks registry needs from it (the plan's "precise missing
  // projection", archive#1301 §1.3). `ingest` is a cheap method-switch that exits
  // immediately for the high-frequency content.*-delta cases and returns the
  // identical state reference (no store notify) for every other no-op, so
  // this costs nothing for chats that never touch background tasks.
  const replayThread = isReplayThread(event.threadId);
  if (!replayThread) {
    backgroundTasksStore.ingest(event);
    // #2456 D2: a session's end must reach the child-work registry even when
    // its chat was since rebound to a newer session (the guard below would
    // drop it), or the chat keeps the dead session's children.
    observeChildWorkLifecycle(event);
    // #2459: the Agents pane's "All" scope — every session's engine
    // subagents, including sessions no chat has open (a CLI delegate).
    childWorkGlobalStore.ingest(apiBase, event);
  }

  if (replayThread) {
    dispatchProjectedOrchestrationEvent(apiBase, event, provenance);
    return;
  }
  drainUnroutedConversationTurnEnd(apiBase, event, conversation);
  if (bufferedDeliveryEnabled()) {
    if (semanticDelivery)
      return semanticDelivery.offer(event, apiBase, provenance);
    loadSemanticDelivery();
  }
  dispatchProjectedOrchestrationEvent(apiBase, event, provenance);
}

/**
 * #2309: a queued follow-up waits for its conversation's turn to END, and
 * the terminal event is the only trigger (so a Stop, `turn.aborted`, never
 * auto-sends: archive#3451). After a reload the chat can still name the root
 * session while the conversation's CURRENT lineage child runs the turn; that
 * child's terminal then routes to no chat and the queue was stranded. The
 * frame's binding names the conversation it belongs to, resolved at delivery,
 * so the terminal of the current child drains that conversation's chat,
 * through the Station this frame came from. A chat the event already routes
 * to is drained by its own handler, exactly as before.
 */
function drainUnroutedConversationTurnEnd(
  apiBase: string,
  event: OrchestrationEvent,
  conversation: OrchestrationConversationStreamBinding | undefined,
): void {
  if (!conversation || conversation.currentSessionId !== event.threadId) return;
  const endsTurn =
    event.method === 'turn.completed' ||
    (event.method === 'runtime.error' && !isDeferredRetriableTurnError(event));
  if (!endsTurn) return;
  if (activeChatsStore.getChatKeyForExecutionSession(event.threadId)) return;
  const chatKey = activeChatsStore.getChatKeyForExecutionSession(
    conversation.conversationId,
  );
  if (!chatKey || isReplayThread(chatKey)) return;
  drainQueuedMessageOnTurnCompleted(apiBase, chatKey);
}

function dispatchProjectedOrchestrationEvent(
  apiBase: string,
  event: OrchestrationEvent,
  provenance?: unknown,
) {
  const chat = activeChatsStore.getChatForExecutionSession(event.threadId);
  if (!chat) return;

  switch (event.method) {
    case 'session.started':
    case 'session.configured':
      handleSessionLifecycleEvent(event);
      return;
    case 'session.state-changed':
      handleSessionStateChangedEvent(event);
      return;
    case 'session.exited':
      handleSessionExitedEvent(event);
      return;
    case 'turn.started':
      handleTurnStartedEvent(event);
      return;
    case 'content.text-delta':
      handleTextDeltaEvent(event);
      return;
    case 'content.reasoning-delta':
      handleReasoningDeltaEvent(event);
      return;
    case 'tool.started':
      handleToolStartedEvent(event);
      return;
    case 'tool.progress':
      handleToolProgressEvent(event);
      return;
    case 'tool.completed':
      handleToolCompletedEvent(event);
      return;
    case 'request.opened':
      handleRequestOpenedEvent(apiBase, event);
      return;
    case 'request.resolved':
      handleRequestResolvedEvent(event);
      return;
    case 'turn.completed':
      handleTurnCompletedEvent(apiBase, event, provenance);
      return;
    case 'turn.aborted':
      handleTurnAbortedEvent(event);
      return;
    case 'runtime.error':
      handleRuntimeErrorEvent(event);
      // archive#3451: a message queued while the turn that failed
      // was running had no trigger to ever send — this listener was only
      // wired to `turn.completed`, so B sat in the queue forever once A
      // failed instead of completing. `turn.aborted` (an explicit user Stop)
      // is deliberately NOT given the same treatment here: auto-firing a
      // queued follow-up immediately after the user asked the turn to STOP
      // is a UX call this fix does not make unilaterally — disclosed as a
      // separate, undecided gap.
      //
      // archive#3451 (moved to packages/contracts in
      // this is the LITERAL same function every server-side consumer
      // uses, not a mirrored copy): a codex deferred-retriable runtime.error
      // may resolve this turn without a new `turn.started`, so draining now
      // would fire a queued message while the "failed" turn is actually
      // still silently retrying.
      if (
        !isDeferredRetriableTurnError(event) &&
        !isReplayThread(event.threadId)
      ) {
        drainQueuedMessageOnTurnCompleted(
          apiBase,
          activeChatsStore.getChatKeyForExecutionSession(event.threadId) ??
            event.threadId,
        );
      }
      return;
    case 'runtime.warning':
      handleRuntimeWarningEvent(event);
      return;
    case 'flow.run-attached':
      handleFlowRunAttachedEvent(event);
      return;
    case 'flow.gate-verdict':
      handleFlowGateVerdictEvent(event);
      return;
    case 'plan.updated':
      handlePlanUpdatedEvent(event);
      return;
    case 'extension.notification':
      handleExtensionNotificationEvent(event);
      return;
    case 'child-work.updated':
      handleChildWorkUpdatedEvent(event);
      return;
    case 'token-usage.updated':
      handleTokenUsageUpdatedEvent(event);
      return;
    case 'session.stop-settled':
      handleSessionStopSettledEvent(event);
      return;
    case 'policy.hooks-attached':
      handlePolicyHooksAttachedEvent(event);
      return;
    case 'policy.stop-verdict':
      handlePolicyStopVerdictEvent(event);
      return;
    case 'platform.mutation':
      handlePlatformMutationEvent(event);
      return;
    case 'workflow.state-changed':
      handleWorkflowStateChangedEvent(event);
      return;
    case 'conversation.forked':
      handleConversationForkedEvent(event);
      return;
    default: {
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}
