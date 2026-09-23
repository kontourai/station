import { isApprovalMode } from '@kontourai/station-contracts/provider';
import {
  type ActiveChatsStore,
  activeChatsStore,
} from '../../contexts/active-chats-store';
import { toastStore } from '../../contexts/ToastContext';
import { settleApprovalPick } from '../../utils/approvalMode';
import {
  acknowledgesModelRequest,
  modelControlOptionsMatch,
  replaceModelControlOptions,
} from '../../utils/modelCapabilities';
import { finalizeAssistantTurn } from './assistantTurn';
import { eventStreamPosition } from './streamPosition';
import type { OrchestrationEvent } from './types';

export function handleSessionLifecycleEvent(
  event: Extract<
    OrchestrationEvent,
    { method: 'session.started' | 'session.configured' }
  >,
) {
  // Only session.configured carries a resolved approvalMode (archive#727) —
  // session.started fires first and has none, so this
  // must not overwrite an existing lastAppliedApprovalMode with undefined.
  const approvalMode =
    event.method === 'session.configured' &&
    isApprovalMode(event.metadata?.approvalMode)
      ? event.metadata.approvalMode
      : undefined;
  const effectiveModel =
    event.method === 'session.configured' &&
    typeof event.metadata?.effectiveModel === 'string'
      ? event.metadata.effectiveModel
      : undefined;
  const effectiveModelOptions =
    event.method === 'session.configured' &&
    event.metadata?.effectiveModelOptions &&
    typeof event.metadata.effectiveModelOptions === 'object' &&
    !Array.isArray(event.metadata.effectiveModelOptions)
      ? (event.metadata.effectiveModelOptions as Record<string, unknown>)
      : undefined;
  const currentChat = activeChatsStore.getChatForExecutionSession(
    event.threadId,
  );
  activeChatsStore.updateChat(event.threadId, {
    provider: event.provider,
    orchestrationProvider: event.provider,
    orchestrationSessionStarted: true,
    ...(approvalMode ? { lastAppliedApprovalMode: approvalMode } : {}),
    // A report settles the pending approval pick only when it matches (#2334).
    ...settleApprovalPick(
      currentChat,
      approvalMode,
      eventStreamPosition(event),
    ),
    ...(event.method === 'session.configured' &&
    typeof event.metadata?.acpSessionMode === 'string'
      ? { currentModeId: event.metadata.acpSessionMode }
      : {}),
    ...(effectiveModel
      ? { model: effectiveModel, orchestrationModel: effectiveModel }
      : {}),
    ...(acknowledgesModelRequest(
      currentChat?.requestedModel,
      currentChat?.defaultModel,
      effectiveModel,
    )
      ? {
          requestedModel: undefined,
          requestedModelSource: undefined,
          ...(modelControlOptionsMatch(
            currentChat?.requestedProviderOptions,
            effectiveModelOptions,
          )
            ? { requestedProviderOptions: undefined }
            : {}),
          ...(currentChat?.requestedModel !== null
            ? { modelSource: currentChat?.requestedModelSource }
            : {}),
        }
      : {}),
    ...(effectiveModel
      ? {
          providerOptions: replaceModelControlOptions(
            currentChat?.providerOptions ?? {},
            effectiveModelOptions,
          ),
        }
      : {}),
  });
}

// A session that reaches one of these states is dead or permanently
// settled — it can never itself clear a live "still working" affordance
// (a background task registry entry, a thinking/compacting hint), so the
// client must clear them here or the banner/"Thinking…" indicator is
// stuck forever. Mirrors the activityHint: undefined idiom already used by
// turnHandlers' turn.aborted/runtime.error handling for the equivalent
// per-turn case.
const TERMINAL_SESSION_STATES = new Set([
  'completed',
  'aborted',
  'errored',
  'exited',
]);
type SessionActivityStore = Pick<
  ActiveChatsStore,
  'getSnapshot' | 'updateChat'
>;

export function handleSessionStateChangedEvent(
  event: Extract<OrchestrationEvent, { method: 'session.state-changed' }>,
  store: SessionActivityStore = activeChatsStore,
) {
  // archive#1076: `to` is the provider's coarse PROCESS status — 'running' means
  // the runtime attached, not that a turn is open. Mirror the archive#1034 snapshot
  // guard using the client's turn fold (orchestrationTurnOpen — set by
  // turn.started, cleared by terminal turn events, reseeded from the
  // snapshot's hasActiveTurn). `status === 'sending'` alone is NOT a valid
  // fold: an in-turn approval drops status to 'idle', and the post-approval
  // 'running' state-change must re-engage the shell. The
  // optimistic local send still counts — it covers the window before the
  // server's first turn event, which the fold cannot yet know about. For
  // state-first adapters a non-initiating client may see a brief idle blip
  // between state-changed('running') and turn.started; that self-corrects
  // on the very next event and is strictly better than trusting process
  // status (the bug this closes).
  const chat = store.getSnapshot()[event.threadId];
  const turnActive =
    chat?.orchestrationTurnOpen === true || chat?.status === 'sending';
  // station#2235: the boot-time interrupted-turn recovery stamps
  // needs_input on a turn whose owner died. That turn will never produce a
  // terminal event of its own (unless the recovery's own turn.aborted,
  // published just before this banner, arrives first), so a live client
  // must converge its shell here: the streaming row, the pending grants,
  // and their toasts all name a turn that can never settle them. Gated on
  // the provenance field, never on the state vocabulary — any future
  // producer of a bare needs_input must not inherit this.
  const interruptedTurn =
    event.interruptedTurnBoundary?.boundaryId !== undefined;
  if (interruptedTurn) {
    // The approval registry died with the owning process: no
    // `request.resolved` will ever arrive for these, so leaving them would
    // strand the grants UI alongside the dead shell.
    for (const toastId of (chat?.approvalToasts ?? new Map()).values()) {
      toastStore.dismiss(toastId);
    }
  }
  store.updateChat(event.threadId, {
    status: event.to === 'running' && turnActive ? 'sending' : 'idle',
    provider: event.provider,
    orchestrationProvider: event.provider,
    orchestrationStatus:
      event.to === 'running' && !turnActive ? 'idle' : event.to,
    orchestrationSessionStarted: true,
    ...(interruptedTurn
      ? {
          orchestrationTurnOpen: false,
          openTurnId: undefined,
          streamingMessage: undefined,
          isProcessingStep: false,
          activityHint: undefined,
          pendingApprovals: [],
          approvalToasts: new Map(),
        }
      : {}),
    ...(TERMINAL_SESSION_STATES.has(event.to)
      ? { activityHint: undefined, backgroundTasks: undefined }
      : {}),
  });
}

export function handleSessionExitedEvent(
  event: Extract<OrchestrationEvent, { method: 'session.exited' }>,
  store: SessionActivityStore = activeChatsStore,
) {
  const chat = store.getSnapshot()[event.threadId];
  if (chat?.streamingMessage || chat?.orchestrationTurnOpen) {
    // Engine death used to tear down the streaming shell without committing
    // the buffered answer (replay: in-flight-content-dropped-on-session-exit).
    finalizeAssistantTurn(event.threadId, undefined, {
      turnId: chat.openTurnId,
      createdAt: event.createdAt,
      answerEligible: false,
    });
  }
  store.updateChat(event.threadId, {
    status: 'idle',
    orchestrationStatus: 'exited',
    orchestrationTurnOpen: false,
    orchestrationSessionStarted: false,
    activityHint: undefined,
    backgroundTasks: undefined,
  });
}

export function handleSessionStopSettledEvent(
  event: Extract<OrchestrationEvent, { method: 'session.stop-settled' }>,
) {
  const chat = activeChatsStore.getChatForExecutionSession(event.threadId);
  if (chat?.streamingMessage || chat?.orchestrationTurnOpen) {
    finalizeAssistantTurn(event.threadId, undefined, {
      turnId: event.turnId ?? chat.openTurnId,
      createdAt: event.createdAt,
      answerEligible: false,
    });
  }
}
