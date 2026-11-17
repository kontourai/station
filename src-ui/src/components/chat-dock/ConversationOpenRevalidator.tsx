import { useEffect, useRef, useState } from 'react';
import { useChatStationConnection } from '../../connections/use-chat-station-connection';
import type { ChatUIState } from '../../contexts/active-chats-state';
import { activeChatsStore } from '../../contexts/active-chats-store';
import { useWorkObservation } from '../../contexts/work-observation';
import { resumeHeldQueueDrain } from '../../hooks/orchestration/queueDrain';
import {
  type SelectableModel,
  sanitizeRuntimeOptionsForModel,
} from '../../utils/modelCapabilities';
import { useOptionalConversationConnection } from '../conversation/ConversationConnectionContext';

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

type OpenController = typeof import('./conversationOpenController');

interface LandedOpen {
  controller: OpenController;
  resolution: Awaited<
    ReturnType<OpenController['resolveConversationOpenAuthoritatively']>
  >;
  /** True once the effect that read it was cleaned up. */
  cancelled: () => boolean;
  /**
   * False once the answer no longer describes now: its read was superseded
   * (a stream epoch change, a newer read of this conversation).
   */
  current: () => boolean;
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
  const target = useOptionalConversationConnection();
  const chat = activeChatsStore.getSnapshot()[sessionId];
  const { connection, unavailable, resolving } = useChatStationConnection(
    chat,
    target?.station,
  );
  apiBase = connection?.targetApiBase ?? apiBase;
  const observation = useWorkObservation(conversationId, connection);
  // The landed `/open` answer. The read below is keyed on the conversation and
  // its connection only; the model catalog arriving or changing identity
  // re-applies this answer instead of cancelling and re-sending the read.
  const [landed, setLanded] = useState<LandedOpen>();
  // Bumped to re-read when the answer held for a loading catalog went stale.
  const [readGeneration, setReadGeneration] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: readGeneration is a re-read trigger, not a value the read uses.
  useEffect(() => {
    if (resolving) return;
    if (unavailable) {
      updateChat(sessionId, {
        stationConnectionUnavailable: true,
        conversationOpenPending: false,
        conversationOpenFailed: true,
      });
      return;
    }
    let cancelled = false;
    setLanded(undefined);
    const read = observation?.read(conversationId, 'open', () => !cancelled);
    void import('./conversationOpenController')
      .then(async (controller) => {
        if (cancelled || read?.current() === false) return;
        const resolution =
          await controller.resolveConversationOpenAuthoritatively(
            conversationId,
            apiBase,
            observation,
            () => !cancelled && read?.current() !== false,
            ...(connection ? [connection] : []),
          );
        if (cancelled || read?.current() === false) return;
        setLanded({
          controller,
          resolution,
          cancelled: () => cancelled,
          current: () => !cancelled && read?.current() !== false,
        });
      })
      .catch(() => {
        if (cancelled || read?.current() === false) return;
        if (observation?.unavailable(conversationId) === undefined)
          read?.failed();
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
    observation,
    connection,
    unavailable,
    resolving,
    apiBase,
    conversationId,
    sessionId,
    updateChat,
    readGeneration,
  ]);

  // The answer bound while its model catalog was still loading: the child it
  // named, so a later child change re-reads instead of binding a stale answer.
  const heldForCatalog = useRef<{ landed: LandedOpen; child?: string }>(
    undefined,
  );
  // The answer already bound in full: a later catalog or agent-list change
  // has nothing left to reconcile, and must not re-read it.
  const appliedOpen = useRef<LandedOpen>(undefined);
  // But a chat marked pending again after that answer bound (a newer child
  // adopted in the same batch keeps this mounted) needs a fresh read: the
  // bound answer no longer settles it.
  useEffect(() => {
    if (!landed) return;
    const check = () => {
      if (appliedOpen.current !== landed || landed.cancelled()) return;
      if (
        activeChatsStore.getSnapshot()[sessionId]?.conversationOpenPending !==
        true
      )
        return;
      appliedOpen.current = undefined;
      setReadGeneration((generation) => generation + 1);
    };
    check();
    const unsubscribe = activeChatsStore.subscribe(check);
    return () => {
      unsubscribe();
    };
  }, [landed, sessionId]);
  useEffect(() => {
    if (!landed || landed.cancelled() || appliedOpen.current === landed) return;
    if (!landed.current()) {
      // The answer outlived its read (a held answer applied seconds later
      // could span a stream epoch change): read again instead.
      heldForCatalog.current = undefined;
      setReadGeneration((generation) => generation + 1);
      return;
    }
    const { controller, resolution } = landed;
    const previous = activeChatsStore.getSnapshot()[sessionId];
    const held =
      heldForCatalog.current?.landed === landed
        ? heldForCatalog.current
        : undefined;
    if (held && previous?.currentSessionId !== held.child) {
      // The chat moved to another child while the catalog loaded.
      heldForCatalog.current = undefined;
      setReadGeneration((generation) => generation + 1);
      return;
    }
    const sameChild = !controller.conversationExecutionChanged(
      resolution,
      previous,
    );
    // Do not discard a deliberate choice merely because its catalog is still
    // loading: bind the child now and leave the choice (and the composer)
    // pending; the catalog's arrival re-runs this without another `/open`.
    const awaitingCatalog = Boolean(
      sameChild && previous?.requestedModel && modelsLoading,
    );
    if (awaitingCatalog && held) return;
    const models =
      !modelsStale && canModelSelect
        ? (availableModels ?? []).filter((model) => model.available !== false)
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
    const patch = controller.conversationOpenPatch(resolution, previous, {
      // Unknown, not empty, while the catalog loads: the patch keeps the
      // saved choice pending rather than reporting it unavailable.
      ...(awaitingCatalog
        ? {}
        : { validModelIds: selected ? [selected.id] : [] }),
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
      agentName: agents?.find((agent) => agent.slug === actualAgent)?.name,
    });
    updateChat(sessionId, {
      ...(previous?.stationConnectionUnavailable
        ? { stationConnectionUnavailable: undefined }
        : {}),
      ...patch,
    });
    if (patch.conversationOpenPending) {
      heldForCatalog.current = {
        landed,
        child: activeChatsStore.getSnapshot()[sessionId]?.currentSessionId,
      };
      return;
    }
    heldForCatalog.current = undefined;
    appliedOpen.current = landed;
    // #2309: a turn end that arrived while this binding was being
    // re-proved held its queued follow-up; now that the chat is writable
    // again, send it.
    resumeHeldQueueDrain(apiBase, sessionId, connection);
  }, [
    landed,
    connection,
    apiBase,
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
