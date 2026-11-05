import type { StationConnection } from '../connections/station-connection';
import { outboundStationIdentity } from '../connections/station-state';
import type { ChatMessage, ChatUIState } from '../contexts/active-chats-state';
import { outboundDispatch } from './outboundQueue';

export interface PeerChatBinding {
  environmentId: string;
  stationName: string;
  conversationId: string;
  sessionId?: string;
  agentId: string;
  executionAgentId?: string;
  expectedDefinitionFingerprint?: string;
  projectSlug?: string;
  projectName?: string;
  model?: string;
  providerOptions?: Record<string, unknown>;
  pending?: { id: string; text: string; dispatched: boolean };
}

/** Retained text is readable without granting its old destination any authority. */
export function readPeerChatMessages(value: unknown): ChatMessage[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): ChatMessage[] => {
    if (
      !entry ||
      typeof entry !== 'object' ||
      typeof entry.content !== 'string'
    )
      return [];
    return [
      {
        role:
          entry.role === 'user' || entry.role === 'assistant'
            ? entry.role
            : 'system',
        content: entry.content,
        ...(typeof entry.id === 'string' ? { id: entry.id } : {}),
        ...(typeof entry.clientId === 'string'
          ? { clientId: entry.clientId }
          : {}),
        ...(typeof entry.timestamp === 'number'
          ? { timestamp: entry.timestamp }
          : {}),
      },
    ];
  });
}

export function readRetainedPeerPendingText(
  value: unknown,
): string | undefined {
  if (!value || typeof value !== 'object' || !('pending' in value)) return;
  const pending = value.pending;
  if (
    pending &&
    typeof pending === 'object' &&
    'text' in pending &&
    typeof pending.text === 'string'
  )
    return pending.text;
}

export function readPeerChatBinding(
  value: unknown,
): PeerChatBinding | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const v = value as Record<string, unknown>;
  if (
    (v.version !== undefined && v.version !== 1) ||
    !['environmentId', 'stationName', 'conversationId', 'agentId'].every(
      (key) => typeof v[key] === 'string' && v[key],
    )
  )
    return;
  const optional = (key: string) =>
    typeof v[key] === 'string' ? (v[key] as string) : undefined;
  const pending =
    v.pending && typeof v.pending === 'object'
      ? (v.pending as Record<string, unknown>)
      : undefined;
  if (
    v.pending !== undefined &&
    (!pending ||
      typeof pending.id !== 'string' ||
      !pending.id ||
      typeof pending.text !== 'string')
  )
    return;
  return {
    environmentId: v.environmentId as string,
    stationName: v.stationName as string,
    conversationId: v.conversationId as string,
    agentId: v.agentId as string,
    sessionId: optional('sessionId'),
    projectSlug: optional('projectSlug'),
    projectName: optional('projectName'),
    executionAgentId: optional('executionAgentId'),
    expectedDefinitionFingerprint: optional('expectedDefinitionFingerprint'),
    model: optional('model'),
    providerOptions:
      v.providerOptions &&
      typeof v.providerOptions === 'object' &&
      !Array.isArray(v.providerOptions)
        ? (v.providerOptions as Record<string, unknown>)
        : undefined,
    ...(pending &&
    typeof pending.id === 'string' &&
    typeof pending.text === 'string'
      ? {
          pending: {
            id: pending.id,
            text: pending.text,
            dispatched: pending.dispatched !== false,
          },
        }
      : {}),
  };
}

/** A rollback build may inspect the backup, but must never auto-send it. */
export function passivePeerChatBackup(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  const pending = record.pending;
  return pending && typeof pending === 'object' && !Array.isArray(pending)
    ? { ...record, pending: { ...pending, dispatched: true } }
    : record;
}

/** Import first: a crash or a refused chat write can safely repeat this step. */
export async function migratePeerChatState(
  chatKey: string,
  chat: ChatUIState,
  connection: StationConnection,
): Promise<Partial<ChatUIState>> {
  const legacy = chat.peerChat;
  if (
    !legacy ||
    chat.peerChatInvalid ||
    chat.stationBindingInvalid ||
    !connection.isCurrent() ||
    connection.routeKind !== 'relay' ||
    connection.environmentId !== legacy.environmentId
  )
    throw new Error('The original paired Station connection is unavailable.');
  let disposition: 'held' | 'observing' | 'settled' | undefined;
  if (legacy.pending) {
    disposition = await outboundDispatch.importLegacy(
      {
        station: outboundStationIdentity(connection),
        clientTurnId: legacy.pending.id,
        sessionId: chatKey,
        conversationId: legacy.conversationId,
        agentSlug: legacy.agentId,
        executionAgentId: legacy.executionAgentId,
        executionOnCurrentStation: true,
        expectedDefinitionFingerprint: legacy.expectedDefinitionFingerprint,
        projectSlug: legacy.projectSlug,
        content: legacy.pending.text,
        model: legacy.model,
        providerOptions: legacy.providerOptions,
        requestedModel: chat.requestedModel,
        requestedProviderOptions: chat.requestedProviderOptions,
      },
      legacy.pending.dispatched,
    );
  }
  if (!connection.isCurrent())
    throw new Error('The paired Station connection changed.');
  return {
    stationBinding: connection.binding,
    conversationId: legacy.conversationId,
    currentSessionId: legacy.sessionId,
    agentSlug: legacy.agentId,
    executionAgentId: legacy.executionAgentId,
    executionOnCurrentStation: true,
    expectedDefinitionFingerprint: legacy.expectedDefinitionFingerprint,
    projectSlug: legacy.projectSlug,
    projectName: legacy.projectName,
    model: legacy.model,
    providerOptions: legacy.providerOptions,
    peerChat: undefined,
    peerChatLegacy: passivePeerChatBackup(chat.peerChatLegacy ?? legacy),
    peerChatTranscript: chat.peerChatTranscript ?? chat.messages,
    ...(legacy.pending &&
    disposition === 'held' &&
    !chat.queuedMessageMetadata?.some(
      (entry) => entry.id === legacy.pending?.id,
    )
      ? {
          queuedMessages: [legacy.pending.text, ...chat.queuedMessages],
          queuedMessageMetadata: [
            { id: legacy.pending.id, mode: 'queue' as const },
            ...(chat.queuedMessageMetadata ?? []),
          ],
        }
      : {}),
  };
}
