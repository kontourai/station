import {
  agentId,
  engineConnectionId,
} from '@kontourai/station-contracts/agent-identity';
import {
  CONVERSATION_HANDOFF_CARRIED_FIELDS,
  CONVERSATION_HANDOFF_DISCLOSURE_LABELS,
  CONVERSATION_HANDOFF_RESET_FIELDS,
} from '@kontourai/station-contracts/orchestration';
import {
  type ConversationHandoffReceipt,
  getConversationHandoffStatus,
  handoffExecutionMessage,
} from '@kontourai/station-sdk/client';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentData } from '../../contexts/AgentsContext';
import type { ProjectMetadata } from '../../contexts/ProjectsContext';
import { useNewChatSelectionModel } from '../../hooks/useNewChatSelectionModel';
import type { FileAttachment } from '../../types';
import { agentEngineDescriptor } from '../../utils/engine';
import { selectChatReadyAgents } from '../agent-selection-policy';
import { engineChipLabel } from '../badges/EngineChip';
import { normalizedDisplayLabel } from '../chat/message-bubble/MessageAttribution';
import { AgentIcon } from '../icons/AgentIcon';
import { GLOBAL_CONTEXT } from '../modals/new-chat-modal-utils';
import {
  ResponsiveDialogCloseButton,
  ResponsiveDialogSurface,
} from '../ResponsiveDialogSurface';
import { Empty } from '../state';
import '../chat/ConversationHandoff.css';

export interface AcceptedConversationHandoff {
  receipt: ConversationHandoffReceipt;
  target?: AgentData;
  targetId: string;
  connectionId?: string;
  message: string;
}

interface ConversationHandoffDialogProps {
  apiBase: string;
  conversationId: string;
  sessionId: string;
  currentAgentId: string;
  projectSlug?: string;
  agents: AgentData[];
  projects: ProjectMetadata[];
  initialMessage: string;
  attachments: FileAttachment[];
  blockedReason?: string;
  onAccepted: (result: AcceptedConversationHandoff) => void;
  onDispatchStarted: (input: { message: string; clientTurnId: string }) => void;
  onDefiniteFailure: (clientTurnId: string) => void;
  onClose: () => void;
}

interface PendingHandoffIntent {
  idempotencyKey: string;
  targetId: string;
  connectionId?: string;
  modelId?: string;
  message: string;
  resourceAdmissionOverrideToken?: string;
  resourceAdmissionOverrideExpiresAt?: number;
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
          ...(typeof parsed.modelId === 'string'
            ? { modelId: parsed.modelId }
            : {}),
          ...(typeof parsed.resourceAdmissionOverrideToken === 'string' &&
          typeof parsed.resourceAdmissionOverrideExpiresAt === 'number'
            ? {
                resourceAdmissionOverrideToken:
                  parsed.resourceAdmissionOverrideToken,
                resourceAdmissionOverrideExpiresAt:
                  parsed.resourceAdmissionOverrideExpiresAt,
              }
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

export function ConversationHandoffDialog({
  apiBase,
  conversationId,
  sessionId,
  currentAgentId,
  projectSlug,
  agents,
  projects,
  initialMessage,
  attachments,
  blockedReason,
  onAccepted,
  onDispatchStarted,
  onDefiniteFailure,
  onClose,
}: ConversationHandoffDialogProps) {
  const restoredIntent = useRef(
    readPendingIntent(apiBase, conversationId),
  ).current;
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
      }).filter((agent) => agent.slug !== currentAgentId),
    [
      agents,
      currentAgentId,
      projectSlug,
      selection.agentConnections,
      selection.selectedProjectConfig?.agents,
    ],
  );
  const [targetId, setTargetId] = useState<string | undefined>(
    restoredIntent?.targetId,
  );
  const target = agents.find((candidate) => candidate.slug === targetId);
  const targetName = target?.name ?? `deleted Agent “${targetId}”`;
  const targetModels = target ? selection.modelsForAgent(target) : [];
  const defaultModel = target
    ? selection.defaultEffectiveModelForAgent(target).id
    : undefined;
  const [modelId, setModelId] = useState<string | undefined>(
    restoredIntent?.modelId,
  );
  const [message, setMessage] = useState(
    restoredIntent?.message ?? initialMessage,
  );
  const [state, setState] = useState<
    'idle' | 'pending' | 'override-required' | 'indeterminate' | 'error'
  >(
    restoredIntent?.resourceAdmissionOverrideToken &&
      (restoredIntent.resourceAdmissionOverrideExpiresAt ?? 0) > Date.now()
      ? 'override-required'
      : restoredIntent
        ? 'indeterminate'
        : 'idle',
  );
  const [resourceOverride, setResourceOverride] = useState<
    { token: string; expiresAt: number } | undefined
  >(
    restoredIntent?.resourceAdmissionOverrideToken &&
      (restoredIntent.resourceAdmissionOverrideExpiresAt ?? 0) > Date.now()
      ? {
          token: restoredIntent.resourceAdmissionOverrideToken,
          expiresAt: restoredIntent.resourceAdmissionOverrideExpiresAt!,
        }
      : undefined,
  );
  const [feedback, setFeedback] = useState<string | undefined>(
    restoredIntent?.resourceAdmissionOverrideToken &&
      (restoredIntent.resourceAdmissionOverrideExpiresAt ?? 0) > Date.now()
      ? 'This Station remains very busy. Choose Start anyway to use this one handoff start.'
      : restoredIntent
        ? 'A prior handoff has no final response yet. Check its exact marker before retrying.'
        : undefined,
  );
  const idempotencyKey = useRef(
    restoredIntent?.idempotencyKey ?? crypto.randomUUID(),
  );
  const mutationLocked =
    state === 'pending' ||
    state === 'override-required' ||
    state === 'indeterminate';
  const closeLocked = state === 'pending';
  const retryEligible = Boolean(
    target &&
      (!restoredIntent?.connectionId ||
        target.execution?.agentConnectionId === restoredIntent.connectionId) &&
      (!modelId || targetModels.some((model) => model.id === modelId)),
  );

  useEffect(() => {
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
  }, [defaultModel, target, targetModels]);

  const runHandoff = async () => {
    if (!targetId || !message.trim() || state === 'pending') return;
    if (blockedReason) {
      setState('error');
      setFeedback(blockedReason);
      return;
    }
    if (attachments.length > 0) {
      setState('error');
      setFeedback('Send or remove attachments before changing Agent.');
      return;
    }
    const intent: PendingHandoffIntent = {
      idempotencyKey: idempotencyKey.current,
      targetId,
      message: message.trim(),
      ...(target?.execution?.agentConnectionId
        ? { connectionId: target.execution.agentConnectionId }
        : {}),
      ...(modelId ? { modelId } : {}),
      ...(resourceOverride && resourceOverride.expiresAt > Date.now()
        ? {
            resourceAdmissionOverrideToken: resourceOverride.token,
            resourceAdmissionOverrideExpiresAt: resourceOverride.expiresAt,
          }
        : {}),
    };
    try {
      sessionStorage.setItem(
        pendingStorageKey(apiBase, conversationId),
        JSON.stringify(intent),
      );
    } catch {
      setState('error');
      setFeedback(
        'This browser cannot retain a safe handoff retry. Enable session storage and try again.',
      );
      return;
    }
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
                agent: agentId(targetId),
                ...(projectSlug
                  ? { workspace: { kind: 'project', projectSlug } as const }
                  : {}),
                ...(modelId ? { model: { override: modelId } } : {}),
              },
              message: message.trim(),
              clientTurnId,
              ...(resourceOverride && resourceOverride.expiresAt > Date.now()
                ? {
                    resourceAdmissionOverrideToken: resourceOverride.token,
                  }
                : {}),
            },
          );
          clearPendingIntent(apiBase, conversationId);
          onAccepted({
            receipt: result.handoff,
            target,
            targetId,
            message: message.trim(),
          });
        },
      );
      if (fenced.status === 'blocked') {
        clearPendingIntent(apiBase, conversationId);
        setState('error');
        setFeedback(
          'Resolve this conversation’s queued or offline messages before changing Agent.',
        );
      }
    } catch (error) {
      const code =
        typeof error === 'object' && error !== null
          ? (error as { code?: unknown }).code
          : undefined;
      const override =
        typeof error === 'object' && error !== null
          ? (
              error as {
                override?: { token?: unknown; expiresAt?: unknown };
              }
            ).override
          : undefined;
      if (
        code === 'resource_posture_override_required' &&
        typeof override?.token === 'string' &&
        typeof override.expiresAt === 'number'
      ) {
        const nextOverride = {
          token: override.token,
          expiresAt: override.expiresAt,
        };
        setResourceOverride(nextOverride);
        setState('override-required');
        setFeedback(
          'This Station remains very busy. Choose Start anyway to use this one handoff start.',
        );
        try {
          sessionStorage.setItem(
            pendingStorageKey(apiBase, conversationId),
            JSON.stringify({
              ...intent,
              resourceAdmissionOverrideToken: nextOverride.token,
              resourceAdmissionOverrideExpiresAt: nextOverride.expiresAt,
            }),
          );
        } catch {
          // The retained idempotency intent already exists. An unavailable
          // token persistence path remains safely observable via Check status.
        }
        return;
      }
      const status =
        typeof error === 'object' && error !== null
          ? (error as { status?: unknown }).status
          : undefined;
      const outcome =
        typeof error === 'object' && error !== null
          ? (error as { outcome?: unknown }).outcome
          : undefined;
      if (typeof status !== 'number' || outcome === 'indeterminate') {
        setState('indeterminate');
        setFeedback(
          'Station did not receive a final response. Check status or retry safely with the retained request.',
        );
      } else {
        clearPendingIntent(apiBase, conversationId);
        onDefiniteFailure(clientTurnId);
        setState('error');
        setFeedback(error instanceof Error ? error.message : String(error));
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
          message: message.trim(),
          receipt: {
            predecessorSessionId: result.marker.predecessorSessionId,
            sessionId: result.marker.sessionId,
            currentSessionId: result.currentSessionId,
            outcome: 'existing',
            target: {
              agentId: agentId(result.marker.targetAgentId),
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
      setFeedback(
        result.status === 'reserved'
          ? 'Station reserved the handoff but has not accepted a provider turn. Restore the target setup, then retry safely.'
          : `Handoff status is ${result.status}. The retained request was not cleared.`,
      );
    } catch (error) {
      setState('indeterminate');
      setFeedback(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <ResponsiveDialogSurface
      ariaLabel="Continue with another Agent"
      panelClassName="conversation-handoff-dialog"
      overlayClassName="conversation-handoff-dialog__overlay"
      onClose={closeLocked ? () => {} : onClose}
    >
      <div className="conversation-handoff-dialog__header">
        <div>
          <h3>Continue with…</h3>
          <p>
            Keep this conversation and workspace; replace its execution Session.
          </p>
        </div>
        <ResponsiveDialogCloseButton
          label="Cancel Agent handoff"
          onClick={onClose}
          disabled={closeLocked}
        />
      </div>

      {candidates.length === 0 ? (
        <Empty
          variant="compact"
          label="Nothing available"
          description="Connect or ready another Agent in this conversation's Environment and workspace to continue."
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
                  onChange={() => setTargetId(candidate.slug)}
                />
                <AgentIcon agent={candidate} size="small" />
                <span>{candidate.name}</span>
                {!repeatsAgent && <small>{engineName}</small>}
              </label>
            );
          })}
        </div>
      )}

      {targetId && (
        <div className="conversation-handoff-dialog__confirmation">
          {targetModels.length > 0 && (
            <label>
              Model
              <select
                value={modelId ?? ''}
                disabled={mutationLocked}
                onChange={(event) => setModelId(event.target.value)}
              >
                {targetModels.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>
            First message to {targetName}
            <textarea
              value={message}
              disabled={mutationLocked}
              onChange={(event) => setMessage(event.target.value)}
              rows={4}
              required
            />
          </label>
          <div className="conversation-handoff-dialog__disclosure">
            <div>
              <strong>Carried</strong>
              <ul>
                {CONVERSATION_HANDOFF_CARRIED_FIELDS.map((field) => (
                  <li key={field}>
                    {CONVERSATION_HANDOFF_DISCLOSURE_LABELS[field]}
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <strong>Reset</strong>
              <ul>
                {CONVERSATION_HANDOFF_RESET_FIELDS.map((field) => (
                  <li key={field}>
                    {CONVERSATION_HANDOFF_DISCLOSURE_LABELS[field]}
                  </li>
                ))}
              </ul>
            </div>
          </div>
          {feedback && (
            <div role="alert" className="conversation-handoff-dialog__feedback">
              {feedback}
            </div>
          )}
          <div className="conversation-handoff-dialog__actions">
            <button
              type="button"
              className="button"
              onClick={onClose}
              disabled={closeLocked}
            >
              Cancel
            </button>
            {state === 'indeterminate' && (
              <button
                type="button"
                className="button"
                onClick={() => void observe()}
              >
                Check status
              </button>
            )}
            <button
              type="button"
              className="button button--primary"
              disabled={
                !message.trim() || state === 'pending' || !retryEligible
              }
              onClick={() => void runHandoff()}
            >
              {state === 'pending'
                ? 'Continuing…'
                : state === 'override-required'
                  ? 'Start anyway'
                  : state === 'indeterminate'
                    ? 'Retry safely'
                    : `Continue with ${targetName}`}
            </button>
          </div>
        </div>
      )}
    </ResponsiveDialogSurface>
  );
}
