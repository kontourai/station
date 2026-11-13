import type { StationStateScope } from '../../connections/station-state';
import type { ChatEngineMcpServer } from '../../contexts/active-chats-state';
import { activeChatsStore } from '../../contexts/active-chats-store';
import type { OrchestrationEvent } from './types';

/** Bound on the servers one chat keeps; the adapter bounds a report the same way. */
export const CHAT_ENGINE_MCP_SERVERS_MAX = 64;

const STATES = new Set<ChatEngineMcpServer['state']>([
  'starting',
  'ready',
  'failed',
  'needs-auth',
  'disabled',
]);

function readServer(value: unknown): ChatEngineMcpServer | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const server = value as Record<string, unknown>;
  if (
    typeof server.name !== 'string' ||
    !server.name ||
    !STATES.has(server.state as ChatEngineMcpServer['state']) ||
    (server.scope !== 'session' && server.scope !== 'engine-config')
  )
    return undefined;
  return {
    name: server.name,
    state: server.state as ChatEngineMcpServer['state'],
    scope: server.scope,
    ...(typeof server.toolCount === 'number' &&
    Number.isInteger(server.toolCount) &&
    server.toolCount >= 0
      ? { toolCount: server.toolCount }
      : {}),
    ...(typeof server.error === 'string' && server.error
      ? { error: server.error }
      : {}),
  };
}

/**
 * Folds an engine's MCP report into the list a chat shows. A complete report
 * replaces the list; a partial one updates only the servers it names, in
 * place, and appends new ones.
 */
export function foldEngineMcpServers(
  current: readonly ChatEngineMcpServer[] | undefined,
  servers: readonly unknown[],
  complete: boolean,
): ChatEngineMcpServer[] {
  const next = new Map<string, ChatEngineMcpServer>(
    complete ? [] : (current ?? []).map((server) => [server.name, server]),
  );
  for (const raw of servers) {
    const server = readServer(raw);
    if (!server) continue;
    if (!next.has(server.name) && next.size >= CHAT_ENGINE_MCP_SERVERS_MAX)
      continue;
    next.set(server.name, server);
  }
  return [...next.values()];
}

/** `engine-mcp.status` → the chat's engine MCP server list. */
export function handleEngineMcpStatusEvent(
  event: Extract<OrchestrationEvent, { method: 'engine-mcp.status' }>,
  station?: StationStateScope,
) {
  const chatStore = activeChatsStore.forStation(station);
  const chat = chatStore.getChatForExecutionSession(event.threadId);
  if (!chat || !Array.isArray(event.servers)) return;
  chatStore.updateChat(event.threadId, {
    engineMcpServers: foldEngineMcpServers(
      chat.engineMcpServers,
      event.servers,
      event.complete === true,
    ),
    engineMcpReconnect: event.reconnect === true ? true : undefined,
  });
}
