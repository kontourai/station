import { useEffect } from 'react';
import type { ChatUIState } from '../../contexts/active-chats-state';
import { activeChatsStore } from '../../contexts/active-chats-store';
import {
  type SelectableModel,
  sanitizeRuntimeOptionsForModel,
} from '../../utils/modelCapabilities';

export interface ConversationOpenRevalidatorProps {
  sessionId: string;
  conversationId: string;
  apiBase: string;
  updateChat: (sessionId: string, patch: Partial<ChatUIState>) => void;
  availableModels?: SelectableModel[];
  modelsLoading?: boolean;
  modelsStale?: boolean;
  canModelSelect?: boolean;
  catalogProvider?: string;
  catalogConnectionId?: string;
  agents?: readonly { slug: string; name?: string }[];
  modelConnections?: readonly {
    id: string;
    type: string;
    enabled?: boolean;
    status?: string;
  }[];
}

/** Re-proves a persisted child binding before the surrounding pane mutates. */
export function ConversationOpenRevalidator({
  sessionId,
  conversationId,
  apiBase,
  updateChat,
  availableModels,
  modelsLoading,
  modelsStale,
  canModelSelect,
  catalogProvider,
  catalogConnectionId,
  agents,
  modelConnections,
}: ConversationOpenRevalidatorProps) {
  useEffect(() => {
    let cancelled = false;
    void import('./conversationOpenController')
      .then(async (controller) => {
        const resolution =
          await controller.resolveConversationOpenAuthoritatively(
            conversationId,
            apiBase,
          );
        if (cancelled) return;
        const previous = activeChatsStore.getSnapshot()[sessionId];
        const sameChild = !controller.conversationExecutionChanged(
          resolution,
          previous,
        );
        // Do not discard a deliberate choice merely because its catalog is still loading.
        if (sameChild && previous?.requestedModel && modelsLoading) return;
        const models =
          !modelsStale && canModelSelect
            ? (availableModels ?? []).filter(
                (model) => model.available !== false,
              )
            : [];
        const native =
          resolution.status === 'resolved' &&
          resolution.execution?.provider === 'station-agent';
        const allowedModelConnections = (modelConnections ?? []).filter(
          (connection) =>
            connection.enabled !== false && connection.status === 'ready',
        );
        const matches = models.filter(
          (model) =>
            model.id === previous?.requestedModel &&
            (!native ||
              (model.providerId &&
                allowedModelConnections.some(
                  (connection) => connection.id === model.providerId,
                ) &&
                (!previous?.providerId ||
                  previous.providerId === model.providerId))),
        );
        const selected = matches.length === 1 ? matches[0] : undefined;
        const modelProvider =
          native && selected?.providerId
            ? allowedModelConnections.find(
                (connection) => connection.id === selected.providerId,
              )
            : undefined;
        const actualAgent =
          resolution.status === 'resolved'
            ? resolution.execution?.agentId
            : undefined;
        updateChat(
          sessionId,
          controller.conversationOpenPatch(resolution, previous, {
            validModelIds: selected ? [selected.id] : [],
            ...(modelProvider
              ? {
                  modelProvider: {
                    id: modelProvider.id,
                    type: modelProvider.type,
                  },
                }
              : {}),
            validModelProviderIds: allowedModelConnections.map(
              (connection) => connection.id,
            ),
            provider: catalogProvider,
            engineConnectionId: catalogConnectionId,
            providerOptions: selected
              ? sanitizeRuntimeOptionsForModel(
                  selected,
                  previous?.requestedProviderOptions ?? {},
                )
              : {},
            agentName: agents?.find((agent) => agent.slug === actualAgent)
              ?.name,
          }),
        );
      })
      .catch(() => {
        if (cancelled) return;
        updateChat(sessionId, {
          conversationOpenPending: false,
          conversationOpenFailed: true,
          currentSessionId: undefined,
          orchestrationSessionStarted: false,
        });
      });
    return () => {
      cancelled = true;
    };
  }, [
    apiBase,
    conversationId,
    sessionId,
    updateChat,
    availableModels,
    modelsLoading,
    modelsStale,
    canModelSelect,
    catalogProvider,
    catalogConnectionId,
    agents,
    modelConnections,
  ]);

  return null;
}
