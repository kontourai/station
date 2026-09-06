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
  agents?: readonly { slug: string; name?: string }[];
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
  agents,
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
        const sameChild =
          resolution.status === 'resolved' &&
          previous?.currentSessionId === resolution.currentSessionId &&
          (!resolution.execution ||
            (previous.agentSlug === resolution.execution.agentId &&
              previous.provider === resolution.execution.provider));
        // Do not discard a deliberate choice merely because its catalog is still loading.
        if (sameChild && previous?.requestedModel && modelsLoading) return;
        const models =
          !modelsStale && canModelSelect
            ? (availableModels ?? []).filter(
                (model) => model.available !== false,
              )
            : [];
        const selected = models.find(
          (model) => model.id === previous?.requestedModel,
        );
        const actualAgent =
          resolution.status === 'resolved'
            ? resolution.execution?.agentId
            : undefined;
        updateChat(
          sessionId,
          controller.conversationOpenPatch(resolution, previous, {
            validModelIds: models.map((model) => model.id),
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
    agents,
  ]);

  return null;
}
