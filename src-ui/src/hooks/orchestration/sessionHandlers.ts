import { isApprovalMode } from '@kontourai/station-contracts/provider';
import {
  type ActiveChatsStore,
  activeChatsStore,
} from '../../contexts/active-chats-store';
import {
  acknowledgesModelRequest,
  modelControlOptionsMatch,
  replaceModelControlOptions,
} from '../../utils/modelCapabilities';
import type { OrchestrationEvent } from './types';

export function handleSessionLifecycleEvent(
  event: Extract<
    OrchestrationEvent,
    { method: 'session.started' | 'session.configured' }
  >,
) {
  // Only session.configured carries a resolved approvalMode (#727 review
  // round 3, item 1) — session.started fires first and has none, so this
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
  // #1076: `to` is the provider's coarse PROCESS status — 'running' means
  // the runtime attached, not that a turn is open. Mirror the #1034 snapshot
  // guard using the client's turn fold (orchestrationTurnOpen — set by
  // turn.started, cleared by terminal turn events, reseeded from the
  // snapshot's hasActiveTurn). `status === 'sending'` alone is NOT a valid
  // fold: an in-turn approval drops status to 'idle', and the post-approval
  // 'running' state-change must re-engage the shell (review HIGH). The
  // optimistic local send still counts — it covers the window before the
  // server's first turn event, which the fold cannot yet know about. For
  // state-first adapters a non-initiating client may see a brief idle blip
  // between state-changed('running') and turn.started; that self-corrects
  // on the very next event and is strictly better than trusting process
  // status (the bug this closes).
  const chat = store.getSnapshot()[event.threadId];
  const turnActive =
    chat?.orchestrationTurnOpen === true || chat?.status === 'sending';
  store.updateChat(event.threadId, {
    status: event.to === 'running' && turnActive ? 'sending' : 'idle',
    provider: event.provider,
    orchestrationProvider: event.provider,
    orchestrationStatus:
      event.to === 'running' && !turnActive ? 'idle' : event.to,
    orchestrationSessionStarted: true,
    ...(TERMINAL_SESSION_STATES.has(event.to)
      ? { activityHint: undefined, backgroundTasks: undefined }
      : {}),
  });
}

export function handleSessionExitedEvent(
  event: Extract<OrchestrationEvent, { method: 'session.exited' }>,
  store: SessionActivityStore = activeChatsStore,
) {
  store.updateChat(event.threadId, {
    status: 'idle',
    orchestrationStatus: 'exited',
    orchestrationTurnOpen: false,
    orchestrationSessionStarted: false,
    activityHint: undefined,
    backgroundTasks: undefined,
  });
}
