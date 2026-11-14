import { foldEngineMcpStatus } from '@kontourai/station-contracts/runtime';
import type { StationStateScope } from '../../connections/station-state';
import { activeChatsStore } from '../../contexts/active-chats-store';
import type { OrchestrationEvent } from './types';

/**
 * `engine-mcp.status` → the chat's engine MCP server list, through the same
 * fold the server's conversation stats use, so a reopened conversation shows
 * what this live one showed.
 */
export function handleEngineMcpStatusEvent(
  event: Extract<OrchestrationEvent, { method: 'engine-mcp.status' }>,
  station?: StationStateScope,
) {
  const chatStore = activeChatsStore.forStation(station);
  const chat = chatStore.getChatForExecutionSession(event.threadId);
  if (!chat || !Array.isArray(event.servers)) return;
  const folded = foldEngineMcpStatus(
    chat.engineMcpServers ? { servers: chat.engineMcpServers } : undefined,
    event,
  );
  chatStore.updateChat(event.threadId, {
    engineMcpServers: folded.servers,
    engineMcpReconnect: folded.reconnect,
    engineMcpComplete:
      event.complete === true || chat.engineMcpComplete ? true : undefined,
  });
}
