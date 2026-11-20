import {
  agentId,
  engineConnectionId,
} from '@kontourai/station-contracts/agent-identity';
import {
  CONVERSATION_HANDOFF_PREDECESSOR_BUSY_CODE,
  type ConversationHandoffEffectStatus,
} from '@kontourai/station-contracts/orchestration';
import {
  type ConversationHandoffReceipt,
  getConversationHandoffStatus,
  handoffExecutionMessage,
} from '@kontourai/station-sdk/client';
import { randomCorrelationId } from '@kontourai/station-shared/random-id';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { AgentData } from '../../contexts/AgentsContext';
import type { ProjectMetadata } from '../../contexts/ProjectsContext';
import { useNewChatSelectionModel } from '../../hooks/useNewChatSelectionModel';
import type { FileAttachment } from '../../types';
import { agentEngineDescriptor } from '../../utils/engine';
import {
  sanitizeRuntimeOptionsForModel,
  updateModelRuntimeOption,
} from '../../utils/modelCapabilities';
import { selectChatReadyAgents } from '../agent-selection-policy';
import { Button } from '../Button';
import { engineChipLabel } from '../badges/EngineChip';
import { normalizedDisplayLabel } from '../chat/message-bubble/MessageAttribution';
import { StartModelPicker } from '../chat-start/StartMenus';
import { DisclosureToggle } from '../DisclosureToggle';
import { AgentIcon } from '../icons/AgentIcon';
import { ArrowDownGlyph } from '../icons/Glyph';
import { GLOBAL_CONTEXT } from '../modals/new-chat-modal-utils';
import {
  ResponsiveDialogCloseButton,
  ResponsiveDialogSurface,
  ResponsiveSurfaceActions,
} from '../ResponsiveDialogSurface';
import { Empty } from '../state';
import '../chat/ConversationHandoff.css';
import type { PreparedOutgoingText } from '../../hooks/useChatInput';
import {
  type DraftQuote,
  draftQuoteKeys,
  parseDraftQuote,
} from '../../utils/answer-quotes';
import { userFacingErrorMessage } from '../../utils/errorText';
import {
  type ContinuedOnStation,
  ConversationStationChoice,
  ConversationStationHandoff,
  readPendingStationHandoff,
} from './ConversationStationHandoff';

export interface AcceptedConversationHandoff {
  receipt: ConversationHandoffReceipt;
  target?: AgentData;
  targetId: string;
  connectionId?: string;
  message: string;
  /**
   * Whether the accepted request was the composer's current draft. A retried
   * earlier request leaves a newer draft in place.
   */
  clearsComposer: boolean;
  /** The quotes the sent message carried, to consume from the draft. */
  sentQuotes: readonly DraftQuote[];
}

/**
 * The handoff's first turn when the person continues without typing. The
 * route starts the target Session with a real provider turn (its receipt is
 * that turn's identity), so "Continue now" sends this visible, fixed request
 * through the same idempotent path a typed message takes. It asks the new
 * Agent to orient itself rather than to resume work nobody asked it to do.
 */
export const HANDOFF_CATCH_UP_MESSAGE =
  'You are taking over this conversation. Briefly summarize where things stand and what you would do next, then wait for my reply.';
/** The same request for an engine switch, where the Agent stays the same. */
export const ENGINE_SWITCH_CATCH_UP_MESSAGE =
  'This conversation now runs on a different engine. Briefly summarize where things stand and what you would do next, then wait for my reply.';

interface ConversationHandoffDialogProps {
  apiBase: string;
  conversationId: string;
  sessionId: string;
  currentAgentId: string;
  executionPreset?: { executionAgentId?: string; modelId?: string };
  projectSlug?: string;
  agents: AgentData[];
  projects: ProjectMetadata[];
  initialMessage: string;
  attachments: FileAttachment[];
  blockedReason?: string;
  /**
   * The composer's send preparation (mentions, quotes, size and Station
   * checks). The dialog's own Continue runs it so a typed draft leaves the
   * same way an ordinary send would.
   */
  prepareDraft?: () => Promise<
    PreparedOutgoingText | { refused: string } | null
  >;
  /**
   * The client turn id this chat is busy with, if any. A busy chat refuses a
   * new handoff; only this request's own dispatch (`handoff:<key>`) does not.
   */
  busyTurnId?: string;
  /** The composer's quotes, which are part of its draft. */
  draftQuotes?: readonly DraftQuote[];
  onAccepted: (result: AcceptedConversationHandoff) => void;
  /**
   * Offer paired Stations as well: the chat's history moves to a new chat
   * there, which the dock opens and sends the first turn to.
   */
  onContinuedOnStation?: (result: ContinuedOnStation) => void;
  onDispatchStarted: (input: { message: string; clientTurnId: string }) => void;
  onDefiniteFailure: (clientTurnId: string) => void;
  onStage?: (
    agent: AgentData,
    executionAgent?: AgentData,
    modelId?: string,
    resetEngine?: boolean,
  ) => void;
  onClose: () => void;
}

interface PendingHandoffIntent {
  idempotencyKey: string;
  targetId: string;
  connectionId?: string;
  executionAgentId?: string;
  expectedDefinitionFingerprint?: string;
  modelId?: string;
  modelOptions?: Record<string, unknown>;
  message: string;
  /**
   * The raw composer draft and quotes `message` was prepared from (mentions
   * expanded, quotes composed in), so a later draft is compared like for like.
   */
  draft?: string;
  quotes?: readonly DraftQuote[];
}

function pendingStorageKey(apiBase: string, conversationId: string): string {
  return `station.conversation-handoff.pending.v1:${encodeURIComponent(apiBase)}:${conversationId}`;
}

function readPendingIntent(
  apiBase: string,
  conversationId: string,
): PendingHandoffIntent | null {
  try {
    const parsed = JSON.parse(
      sessionStorage.getItem(pendingStorageKey(apiBase, conversationId)) ??
        'null',
    ) as Partial<PendingHandoffIntent> | null;
    return parsed &&
      typeof parsed.idempotencyKey === 'string' &&
      typeof parsed.targetId === 'string' &&
      typeof parsed.message === 'string'
      ? {
          idempotencyKey: parsed.idempotencyKey,
          targetId: parsed.targetId,
          message: parsed.message,
          ...(typeof parsed.connectionId === 'string'
            ? { connectionId: parsed.connectionId }
            : {}),
          ...(typeof parsed.executionAgentId === 'string'
            ? { executionAgentId: parsed.executionAgentId }
            : {}),
          ...(typeof parsed.expectedDefinitionFingerprint === 'string'
            ? {
                expectedDefinitionFingerprint:
                  parsed.expectedDefinitionFingerprint,
              }
            : {}),
          ...(typeof parsed.modelId === 'string'
            ? { modelId: parsed.modelId }
            : {}),
          ...(parsed.modelOptions &&
          typeof parsed.modelOptions === 'object' &&
          !Array.isArray(parsed.modelOptions)
            ? { modelOptions: parsed.modelOptions }
            : {}),
          ...(typeof parsed.draft === 'string' ? { draft: parsed.draft } : {}),
          // Each quote is checked: an element that does not parse drops the
          // whole list, so a damaged record never consumes the wrong quote.
          ...(Array.isArray(parsed.quotes) &&
          parsed.quotes.every((quote) => parseDraftQuote(quote))
            ? { quotes: parsed.quotes as DraftQuote[] }
            : {}),
        }
      : null;
  } catch {
    return null;
  }
}

function clearPendingIntent(apiBase: string, conversationId: string): void {
  try {
    sessionStorage.removeItem(pendingStorageKey(apiBase, conversationId));
  } catch {
    // A cleanup refusal cannot overturn an accepted server receipt.
  }
}

/**
 * Did Station definitively refuse the handoff? Only a response Station itself
 * answered, and not an indeterminate one, clears the retained request. A
 * failure with no status never reached an answer, and a proxy's page (an
 * HTML 403 or 502) keeps its status but is not Station's answer (#2708).
 */
function isDefiniteHandoffFailure(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { status, outcome, stationEnvelope } = error as {
    status?: unknown;
    outcome?: unknown;
    stationEnvelope?: unknown;
  };
  return (
    typeof status === 'number' &&
    outcome !== 'indeterminate' &&
    stationEnvelope !== false
  );
}

/** What an observed, not-yet-applied switch status means for the user. */
export function handoffStatusFeedback(
  status: ConversationHandoffEffectStatus,
): string {
  switch (status) {
    case 'reserved':
      return "The switch started but the new agent hasn't replied. Restore its setup, then retry.";
    case 'accepted':
    case 'completed':
      return 'The switch went through. Check status to open it.';
    case 'failed':
      return 'The switch failed. Your message is kept, so you can retry.';
    case 'indeterminate':
      return "Station couldn't confirm whether the switch ran. Check status before retrying.";
    default: {
      const unhandled: never = status;
      return unhandled;
    }
  }
}

const NO_QUOTES: readonly DraftQuote[] = [];

/**
 * Station's reason for a refused handoff, in words the person can act on
 * where Station says which refusal it is.
 */
function handoffRefusalFeedback(error: unknown): string {
  if (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code ===
      CONVERSATION_HANDOFF_PREDECESSOR_BUSY_CODE
  )
    return 'The current agent is still working. Wait for it to finish, then try again.';
  return error instanceof Error ? userFacingErrorMessage(error) : String(error);
}

/**
 * What a handoff keeps and resets, in plain words. Each sentence covers its
 * contract field list (`CONVERSATION_HANDOFF_CARRIED_FIELDS` and
 * `..._RESET_FIELDS`); a test pins those lists so a change there revisits
 * these.
 */
export const HANDOFF_KEEPS_SUMMARY =
  'Recent messages, the workspace, and the agent and model you chose.';
export const HANDOFF_STARTS_FRESH_SUMMARY =
  "The previous engine's own session and tools, approvals given in this chat, its task links, and anything queued or running.";

export function ConversationHandoffDialog({
  apiBase,
  conversationId,
  sessionId,
  currentAgentId,
  executionPreset,
  projectSlug,
  agents,
  projects,
  initialMessage,
  attachments,
  blockedReason,
  prepareDraft,
  draftQuotes = NO_QUOTES,
  busyTurnId,
  onAccepted,
  onContinuedOnStation,
  onDispatchStarted,
  onDefiniteFailure,
  onStage,
  onClose,
}: ConversationHandoffDialogProps) {
  const restoredIntent = useRef(
    readPendingIntent(apiBase, conversationId),
  ).current;
  const restoredStation = useRef(
    onContinuedOnStation
      ? readPendingStationHandoff(apiBase, conversationId)
      : null,
  ).current;
  const [where, setWhere] = useState(
    restoredStation?.environmentId ?? 'current',
  );
  const stationOffered = Boolean(
    onContinuedOnStation && !executionPreset && !restoredIntent,
  );
  const currentAgent = agents.find((agent) => agent.slug === currentAgentId);
  // With another Station chosen the chat moves there, it does not switch Agent.
  const dialogTitle =
    stationOffered && where !== 'current'
      ? 'Continue elsewhere'
      : executionPreset
        ? 'Switch engine'
        : 'Switch agent';
  const selectedContext = projectSlug ?? GLOBAL_CONTEXT;
  const selection = useNewChatSelectionModel({
    agents,
    projects,
    selectedContext,
  });
  const candidates = useMemo(
    () =>
      selectChatReadyAgents({
        agents,
        agentConnections: selection.agentConnections,
        selectedProjectSlug: projectSlug,
        selectedProjectAgentFilter: selection.selectedProjectConfig?.agents,
      }).filter((agent) =>
        executionPreset
          ? agent.slug === currentAgentId
          : Boolean(onStage) || agent.slug !== currentAgentId,
      ),
    [
      agents,
      currentAgentId,
      executionPreset,
      onStage,
      projectSlug,
      selection.agentConnections,
      selection.selectedProjectConfig?.agents,
    ],
  );
  const [targetId, setTargetId] = useState<string | undefined>(
    restoredIntent?.targetId ?? (executionPreset ? currentAgentId : undefined),
  );
  const target = agents.find((candidate) => candidate.slug === targetId);
  const executionAgentId = restoredIntent
    ? restoredIntent.executionAgentId
    : executionPreset?.executionAgentId;
  const executionTarget = executionAgentId
    ? agents.find((agent) => agent.slug === executionAgentId)
    : target;
  const retainedIntent = useRef<PendingHandoffIntent | null>(restoredIntent);
  const targetName = target?.name ?? `deleted Agent “${targetId}”`;
  // Only models this client can start are offered; a catalog entry marked
  // unavailable is not a choice here. A restored request is the exception:
  // its retry resends the retained request unchanged under the same
  // idempotency key (Station answers an accepted one with its receipt), so
  // its own model stays listed even if the catalog now marks it unavailable.
  const targetModels = executionTarget
    ? selection
        .modelsForAgent(executionTarget)
        .filter(
          (model) =>
            model.available !== false || model.id === restoredIntent?.modelId,
        )
    : [];
  const defaultModel = executionTarget
    ? selection.defaultEffectiveModelForAgent(executionTarget).id
    : undefined;
  const [modelId, setModelId] = useState<string | undefined>(
    restoredIntent?.modelId ?? executionPreset?.modelId,
  );
  const [modelOptions, setModelOptions] = useState<Record<string, unknown>>(
    restoredIntent?.modelOptions ?? {},
  );
  const [disclosureOpen, setDisclosureOpen] = useState(false);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const modelTriggerRef = useRef<HTMLButtonElement>(null);
  // No field edits this: the composer's draft is the first turn, and an empty draft means the catch-up request.
  // A retained uncertain request is retried exactly as it was sent; a newer
  // draft is not part of it and stays in the composer.
  const composerDraft = initialMessage.trim();
  const composerHasDraft = Boolean(composerDraft) || draftQuotes.length > 0;
  const catchUpMessage = executionPreset
    ? ENGINE_SWITCH_CATCH_UP_MESSAGE
    : HANDOFF_CATCH_UP_MESSAGE;
  // The request this dialog holds (restored after a reload, or made in this
  // open and left uncertain). Read each render: every change to it comes
  // with a state change.
  const retained = retainedIntent.current;
  // Like for like: the composer's raw draft and quotes against the raw draft
  // and quotes the retained request was prepared from (an older request
  // without them is compared by its sent text).
  const displacesDraft = Boolean(
    retained &&
      composerHasDraft &&
      (initialMessage.trim() !== (retained.draft ?? retained.message).trim() ||
        draftQuoteKeys(draftQuotes) !== draftQuoteKeys(retained.quotes ?? [])),
  );
  const message = retained?.message ?? (composerDraft || catchUpMessage);
  const sentQuotes = useRef<readonly DraftQuote[]>(
    restoredIntent?.quotes ?? NO_QUOTES,
  );
  const starting = useRef(false);
  const [state, setState] = useState<
    'idle' | 'pending' | 'indeterminate' | 'error'
  >(restoredIntent ? 'indeterminate' : 'idle');
  const [feedback, setFeedback] = useState<string | undefined>(
    restoredIntent
      ? "The last switch hasn't finished. Check its status before retrying."
      : undefined,
  );
  const idempotencyKey = useRef(
    restoredIntent?.idempotencyKey ?? randomCorrelationId(),
  );
  const mutationLocked = state === 'pending' || state === 'indeterminate';
  const closeLocked = state === 'pending';
  const retryEligible = Boolean(
    target &&
      executionTarget &&
      (!restoredIntent?.connectionId ||
        executionTarget.execution?.agentConnectionId ===
          restoredIntent.connectionId) &&
      (!modelId || targetModels.some((model) => model.id === modelId)),
  );

  const changeLabel = executionPreset
    ? 'switching engines'
    : 'continuing with another agent';
  // A precondition the caller must resolve outside this dialog. The submit is
  // disabled while one holds and the reason is shown beside it, so the form
  // never offers an action it would refuse. An uncertain request whose
  // retained target no longer resolves here cannot be retried as-is either;
  // say so rather than leave "Retry safely" greyed out without a reason.
  // An uncertain request is not a new turn: its own dispatch is what makes
  // the chat read busy, and a same-key retry only ever answers with that
  // request's receipt. A send the queue fence refused was never made, and a
  // chat busy with any other turn is guarded like any.
  // A retry resends the stored request as it was made: the chat being busy
  // with that very request, or holding attachments it never carried, does
  // not block it.
  const ownTurnBusy = Boolean(
    retained && busyTurnId === `handoff:${idempotencyKey.current}`,
  );
  const effectiveBlockedReason = ownTurnBusy ? undefined : blockedReason;
  const preconditionReason =
    (onStage && !retained ? undefined : effectiveBlockedReason) ??
    (!onStage && attachments.length > 0 && !retained
      ? `Send or remove attachments before ${changeLabel}.`
      : state === 'indeterminate' && !retryEligible
        ? 'This request’s agent, engine or model isn’t available here. Restore that setup to retry.'
        : undefined);
  const engineLabel =
    executionTarget?.engineDisplayName ??
    (executionAgentId ? executionTarget?.name : undefined);
  const fieldId = useId();
  const modelFieldId = `${fieldId}-model`;
  const modelValueId = `${fieldId}-model-value`;
  const preconditionId = `${fieldId}-precondition`;
  const disclosureId = `${fieldId}-carries`;

  const inheritsAgentDefaults = Boolean(
    executionPreset &&
      !executionPreset.executionAgentId &&
      !executionPreset.modelId,
  );
  useEffect(() => {
    if (mutationLocked || inheritsAgentDefaults) return;
    if (!target) {
      setModelId(undefined);
      return;
    }
    const allowed = targetModels.some((model) => model.id === defaultModel);
    setModelId((current) =>
      current && targetModels.some((model) => model.id === current)
        ? current
        : allowed
          ? (defaultModel ?? undefined)
          : targetModels[0]?.id,
    );
  }, [
    defaultModel,
    inheritsAgentDefaults,
    mutationLocked,
    target,
    targetModels,
  ]);

  const runHandoff = async () => {
    if (!targetId || state === 'pending' || starting.current) return;
    if (onStage && !retainedIntent.current) {
      if (target && executionTarget && retryEligible) {
        onStage(
          target,
          executionAgentId ? executionTarget : undefined,
          modelId,
          Boolean(executionPreset && !executionAgentId),
        );
        onClose();
      }
      return;
    }
    if (effectiveBlockedReason) {
      setState('error');
      setFeedback(effectiveBlockedReason);
      return;
    }
    if (attachments.length > 0 && !retainedIntent.current) {
      setState('error');
      setFeedback(`Send or remove attachments before ${changeLabel}.`);
      return;
    }
    let firstMessage = message;
    let firstDraft = initialMessage;
    if (!retainedIntent.current) {
      // A new request names a target this client can still start: the
      // catalog can change while the picker is open.
      if (
        !target ||
        !executionTarget ||
        (!executionPreset &&
          !candidates.some((candidate) => candidate.slug === targetId)) ||
        (modelId && !targetModels.some((model) => model.id === modelId))
      ) {
        setState('error');
        setFeedback(
          `${executionPreset ? (engineLabel ?? 'That engine') : targetName} isn’t available anymore. Choose again.`,
        );
        return;
      }
      if (prepareDraft) {
        // Mentions can take a moment to read: show the request as going.
        starting.current = true;
        setState('pending');
        setFeedback(undefined);
        let prepared: Awaited<ReturnType<typeof prepareDraft>>;
        try {
          prepared = await prepareDraft();
        } catch {
          // Nothing was sent and the draft stays in the composer; the
          // dialog must not stay locked in "Continuing…".
          setState('error');
          setFeedback(
            "Your draft couldn't be prepared, so nothing was sent. Try again.",
          );
          return;
        } finally {
          starting.current = false;
        }
        if (!prepared || 'refused' in prepared) {
          setState('error');
          setFeedback(
            prepared
              ? prepared.refused
              : 'Your draft changed while it was being prepared. Try again.',
          );
          return;
        }
        firstMessage = prepared.text.trim() || catchUpMessage;
        firstDraft = prepared.draft;
        sentQuotes.current = prepared.quotes;
      }
    }
    const intent: PendingHandoffIntent = retainedIntent.current ?? {
      idempotencyKey: idempotencyKey.current,
      targetId,
      message: firstMessage,
      draft: firstDraft,
      ...(sentQuotes.current.length > 0 ? { quotes: sentQuotes.current } : {}),
      ...(executionAgentId
        ? {
            executionAgentId,
            expectedDefinitionFingerprint: target?.definitionFingerprint,
          }
        : {}),
      ...(executionTarget?.execution?.agentConnectionId
        ? { connectionId: executionTarget.execution.agentConnectionId }
        : {}),
      ...(modelId ? { modelId } : {}),
      ...(Object.keys(modelOptions).length > 0 ? { modelOptions } : {}),
    };
    try {
      sessionStorage.setItem(
        pendingStorageKey(apiBase, conversationId),
        JSON.stringify(intent),
      );
    } catch {
      setState('error');
      setFeedback(
        "This browser blocks session storage, so a retry isn't safe. Enable it and try again.",
      );
      return;
    }
    retainedIntent.current = intent;
    const clientTurnId = `handoff:${idempotencyKey.current}`;
    setState('pending');
    setFeedback(undefined);
    try {
      const { outboundDispatch } = await import('../../lib/outboundQueue');
      const fenced = await outboundDispatch.fenceConversationHandoff(
        { conversationId, sessionId },
        async () => {
          onDispatchStarted({ message: intent.message, clientTurnId });
          const result = await handoffExecutionMessage(
            apiBase,
            conversationId,
            {
              idempotencyKey: idempotencyKey.current,
              target: {
                environment: { kind: 'current' },
                agent: intent.executionAgentId
                  ? {
                      kind: 'agent-execution-override',
                      agent: agentId(intent.targetId),
                      executionAgent: agentId(intent.executionAgentId),
                      ...(intent.expectedDefinitionFingerprint
                        ? {
                            expectedDefinitionFingerprint:
                              intent.expectedDefinitionFingerprint,
                          }
                        : {}),
                    }
                  : agentId(intent.targetId),
                ...(projectSlug
                  ? { workspace: { kind: 'project', projectSlug } as const }
                  : {}),
                ...(intent.modelId || intent.modelOptions
                  ? {
                      model: {
                        ...(intent.modelId ? { override: intent.modelId } : {}),
                        ...(intent.modelOptions
                          ? { options: intent.modelOptions }
                          : {}),
                      },
                    }
                  : {}),
              },
              message: intent.message,
              clientTurnId,
            },
          );
          clearPendingIntent(apiBase, conversationId);
          onAccepted({
            receipt: result.handoff,
            target,
            targetId,
            message: intent.message,
            clearsComposer: !displacesDraft,
            sentQuotes: sentQuotes.current,
          });
        },
      );
      if (fenced.status === 'blocked') {
        // Nothing was sent: no request is retained to retry or check.
        clearPendingIntent(apiBase, conversationId);
        retainedIntent.current = null;
        setState('error');
        setFeedback(
          `Send or discard this chat’s queued messages before ${changeLabel}.`,
        );
      }
    } catch (error) {
      if (!isDefiniteHandoffFailure(error)) {
        setState('indeterminate');
        setFeedback(
          "Station didn't confirm the switch. Retrying won't run it twice.",
        );
      } else {
        clearPendingIntent(apiBase, conversationId);
        retainedIntent.current = null;
        onDefiniteFailure(clientTurnId);
        setState('error');
        setFeedback(handoffRefusalFeedback(error));
      }
    }
  };

  const observe = async () => {
    setState('pending');
    setFeedback(undefined);
    try {
      const result = await getConversationHandoffStatus(
        apiBase,
        conversationId,
        idempotencyKey.current,
      );
      if (
        result.status === 'accepted' ||
        result.status === 'completed' ||
        (result.status === 'failed' && result.providerTurnId)
      ) {
        clearPendingIntent(apiBase, conversationId);
        onAccepted({
          target,
          targetId: result.marker.targetAgentId,
          message,
          clearsComposer: !displacesDraft,
          sentQuotes: sentQuotes.current,
          receipt: {
            predecessorSessionId: result.marker.predecessorSessionId,
            sessionId: result.marker.sessionId,
            currentSessionId: result.currentSessionId,
            outcome: 'existing',
            target: {
              agentId: agentId(result.marker.targetAgentId),
              ...(result.marker.targetExecutionAgentId
                ? {
                    executionAgentId: agentId(
                      result.marker.targetExecutionAgentId,
                    ),
                  }
                : {}),
              ...(result.marker.targetProvider
                ? { provider: result.marker.targetProvider }
                : {}),
              ...(result.marker.expectedDefinitionFingerprint
                ? {
                    expectedDefinitionFingerprint:
                      result.marker.expectedDefinitionFingerprint,
                  }
                : {}),
              engine: result.marker.targetConnectionId
                ? {
                    kind: 'connection',
                    connectionId: engineConnectionId(
                      result.marker.targetConnectionId,
                    ),
                  }
                : { kind: 'station' },
              ...(result.marker.targetModelId
                ? { modelId: result.marker.targetModelId }
                : {}),
            },
            carried: result.marker.carried,
            reset: result.marker.reset,
          },
        });
        return;
      }
      setState('indeterminate');
      setFeedback(handoffStatusFeedback(result.status));
    } catch (error) {
      setState('indeterminate');
      setFeedback(
        error instanceof Error ? userFacingErrorMessage(error) : String(error),
      );
    }
  };

  const targetModel = targetModels.find((model) => model.id === modelId);
  const primaryDisabled =
    state === 'pending' || !retryEligible || Boolean(preconditionReason);

  return (
    <ResponsiveDialogSurface
      layer="dialog"
      ariaLabel={dialogTitle}
      panelClassName="conversation-handoff-dialog"
      overlayClassName="conversation-handoff-dialog__overlay"
      onClose={closeLocked ? () => {} : onClose}
    >
      <div className="conversation-handoff-dialog__header">
        <h3>{dialogTitle}</h3>
        <ResponsiveDialogCloseButton
          label={
            executionPreset ? 'Cancel engine change' : 'Cancel agent handoff'
          }
          onClick={onClose}
          disabled={closeLocked}
        />
      </div>

      {stationOffered && (
        <ConversationStationChoice
          apiBase={apiBase}
          value={where}
          disabled={mutationLocked}
          onChange={setWhere}
        />
      )}

      {stationOffered && where !== 'current' && onContinuedOnStation ? (
        currentAgent ? (
          <ConversationStationHandoff
            key={where}
            apiBase={apiBase}
            conversationId={conversationId}
            agent={currentAgent}
            environmentId={where}
            sourceProject={projects.find(
              (project) => project.slug === projectSlug,
            )}
            message={message}
            draft={composerHasDraft}
            composerText={initialMessage}
            composerQuotes={draftQuotes}
            prepareDraft={retained ? undefined : prepareDraft}
            catchUpMessage={catchUpMessage}
            blockedReason={
              blockedReason ??
              (attachments.length > 0
                ? 'Send or remove attachments before continuing on another Station.'
                : undefined)
            }
            restored={restoredStation}
            onContinued={onContinuedOnStation}
          />
        ) : (
          <Empty
            variant="compact"
            label="Agent unavailable"
            description="This chat's Agent isn't on this Station anymore."
          />
        )
      ) : executionPreset ? (
        <p className="conversation-handoff-dialog__summary">
          Keep the {targetName} agent and run this chat on{' '}
          {engineLabel ?? 'its default engine'}.
        </p>
      ) : candidates.length === 0 ? (
        <Empty
          variant="compact"
          label="Nothing available"
          description="Connect another agent in this chat's environment to continue."
        />
      ) : (
        <div
          className="conversation-handoff-dialog__agents"
          role="radiogroup"
          aria-label="Agent"
        >
          {candidates.map((candidate) => {
            const engineName =
              engineChipLabel(agentEngineDescriptor(candidate)) ||
              'Engine unavailable';
            const repeatsAgent =
              normalizedDisplayLabel(candidate.name) ===
              normalizedDisplayLabel(engineName);
            return (
              <label
                key={candidate.slug}
                className="conversation-handoff-dialog__agent"
              >
                <input
                  type="radio"
                  name="conversation-handoff-agent"
                  value={candidate.slug}
                  checked={candidate.slug === targetId}
                  disabled={mutationLocked}
                  onChange={() => {
                    setTargetId(candidate.slug);
                    setModelOptions({});
                  }}
                />
                <AgentIcon agent={candidate} size="small" />
                <span>{candidate.name}</span>
                {!repeatsAgent && <small>{engineName}</small>}
              </label>
            );
          })}
        </div>
      )}

      {where === 'current' && targetId && (
        <div className="conversation-handoff-dialog__confirmation">
          {(!onStage || retained) && targetModels.length > 0 && (
            <div className="conversation-handoff-dialog__model">
              <span className="editor-label" id={modelFieldId}>
                Model
              </span>
              <Button
                ref={modelTriggerRef}
                className="choice-trigger"
                aria-labelledby={`${modelFieldId} ${modelValueId}`}
                aria-haspopup="dialog"
                aria-expanded={modelPickerOpen}
                disabled={mutationLocked}
                onClick={() => setModelPickerOpen(true)}
              >
                <span id={modelValueId}>
                  {targetModel?.name ?? 'Agent default'}
                </span>
                <ArrowDownGlyph className="choice-caret" />
              </Button>
              {modelPickerOpen && (
                <StartModelPicker
                  anchor={modelTriggerRef.current}
                  layer="dialog"
                  models={targetModels}
                  loading={selection.modelsLoading}
                  modelConnections={selection.modelConnections ?? []}
                  choice={{ modelId, providerOptions: modelOptions }}
                  defaultModel={{ id: defaultModel, source: 'agent default' }}
                  onSelect={(model) => {
                    setModelId(model.id);
                    setModelOptions((current) =>
                      sanitizeRuntimeOptionsForModel(model, current),
                    );
                    setModelPickerOpen(false);
                  }}
                  onReset={() => {
                    setModelId(undefined);
                    setModelOptions({});
                    setModelPickerOpen(false);
                  }}
                  onRuntimeOptionChange={(key, value) =>
                    setModelOptions((current) =>
                      updateModelRuntimeOption(current, key, value),
                    )
                  }
                  onClose={() => setModelPickerOpen(false)}
                />
              )}
            </div>
          )}
          <div className="conversation-handoff-dialog__note">
            <span>
              {onStage && !retained
                ? 'Send starts a fresh Session with recent conversation text.'
                : displacesDraft
                  ? 'Retries the earlier request. Your new draft stays in the composer.'
                  : retained
                    ? 'Retries the earlier request.'
                    : composerHasDraft
                      ? 'Your draft is sent as the first message.'
                      : 'Starts with a short catch-up turn.'}
            </span>
            <DisclosureToggle
              expanded={disclosureOpen}
              onToggle={() => setDisclosureOpen((open) => !open)}
              controls={disclosureId}
            >
              Details
            </DisclosureToggle>
          </div>
          {disclosureOpen && (
            <dl
              id={disclosureId}
              className="conversation-handoff-dialog__disclosure"
            >
              {(!onStage || retained) && (
                <>
                  <dt>First message</dt>
                  <dd>
                    {retained || !composerHasDraft
                      ? message
                      : 'Your draft from the composer'}
                  </dd>
                </>
              )}
              <dt>Keeps</dt>
              <dd>
                {onStage && !retained
                  ? 'Recent authorized text, the workspace, and the selected Agent and model.'
                  : HANDOFF_KEEPS_SUMMARY}
              </dd>
              <dt>Starts fresh</dt>
              <dd>{HANDOFF_STARTS_FRESH_SUMMARY}</dd>
            </dl>
          )}
          {preconditionReason && (
            <p
              id={preconditionId}
              role="status"
              className="conversation-handoff-dialog__precondition"
            >
              {preconditionReason}
            </p>
          )}
          {feedback && (
            <div role="alert" className="conversation-handoff-dialog__feedback">
              {feedback}
            </div>
          )}
          {/* The shared action row owns phone wrapping, tap targets and the
              safe area; this class keeps only the desktop alignment. */}
          <ResponsiveSurfaceActions className="conversation-handoff-dialog__actions">
            {state === 'indeterminate' && (
              <Button onClick={() => void observe()}>Check status</Button>
            )}
            <Button
              variant="primary"
              disabled={primaryDisabled}
              aria-describedby={preconditionReason ? preconditionId : undefined}
              onClick={() => void runHandoff()}
            >
              {onStage && !retained
                ? targetId === currentAgentId && !executionPreset
                  ? 'Keep current Agent'
                  : `Use ${targetName} on Send`
                : state === 'pending'
                  ? executionPreset
                    ? 'Switching…'
                    : 'Continuing…'
                  : state === 'indeterminate'
                    ? 'Retry safely'
                    : executionPreset
                      ? `Switch to ${engineLabel ?? 'default engine'}`
                      : `Continue with ${targetName}`}
            </Button>
          </ResponsiveSurfaceActions>
        </div>
      )}
    </ResponsiveDialogSurface>
  );
}
