import { isDeferredRetriableTurnError } from '@kontourai/station-contracts/runtime-events';
import { activeChatsStore } from '../../contexts/active-chats-store';
import { backgroundTasksStore } from '../../contexts/background-tasks-store';
import {
  handleRequestOpenedEvent,
  handleRequestResolvedEvent,
} from './approvalHandlers';
import { handleExtensionNotificationEvent } from './extensionHandlers';
import {
  handleFlowGateVerdictEvent,
  handleFlowRunAttachedEvent,
} from './flowHandlers';
import { handlePlanUpdatedEvent } from './planHandlers';
import { drainQueuedMessageOnTurnCompleted } from './queueDrain';
import {
  handleSessionExitedEvent,
  handleSessionLifecycleEvent,
  handleSessionStateChangedEvent,
} from './sessionHandlers';
import {
  handleReasoningDeltaEvent,
  handleTextDeltaEvent,
  handleToolCompletedEvent,
  handleToolProgressEvent,
  handleToolStartedEvent,
} from './streamHandlers';
import {
  handleRuntimeErrorEvent,
  handleRuntimeWarningEvent,
  handleTurnAbortedEvent,
  handleTurnCompletedEvent,
  handleTurnStartedEvent,
} from './turnHandlers';
import type { OrchestrationEvent } from './types';
import { handleTokenUsageUpdatedEvent } from './usageHandlers';

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
) {
// archive#1301: ingest BEFORE the `if (!chat) return` guard below —
// a delegate session's events arrive on the delegate's own threadId, which
// is never opened as a chat, so the guard would otherwise drop every event
// the background-tasks registry needs from it (the plan's "precise missing
 // projection", archive#1301 §1.3). `ingest` is a cheap method-switch that exits
// immediately for the high-frequency content.*-delta cases and returns the
// identical state reference (no store notify) for every other no-op, so
// this costs nothing for chats that never touch background tasks.
  backgroundTasksStore.ingest(event);

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
      if (!isDeferredRetriableTurnError(event)) {
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
    case 'token-usage.updated':
      handleTokenUsageUpdatedEvent(event);
      return;
  }
}
