import type { EngineCommandOutcome } from '@kontourai/station-contracts/engine-commands';
import { foldEngineMcpStatus } from '@kontourai/station-contracts/runtime';
import {
  StationHttpError,
  useConversationUsageTreeQuery,
  useReconnectEngineMcpServerMutation,
} from '@kontourai/station-sdk';
import { useCallback, useEffect, useState } from 'react';
import type { ChatEngineMcpServer } from '../../contexts/active-chats-state';
import { useStats } from '../../contexts/StatsContext';
import { userFacingErrorMessage } from '../../utils/errorText';
import { useOptionalConversationConnection } from '../conversation/ConversationConnectionContext';
import { LazyBoundary } from '../LazyBoundary';
import type { EngineMcpReconnect } from './EngineMcpStatusPanel';

// The stats panel is opened from a toolbar toggle and closed most of the time,
// so its body loads on first open rather than riding the first-paint bundle.
/**
 * The server writes conversation stats from a turn-end hook, several awaits
 * after the transcript row the client counts, so the two are unordered: a
 * refresh driven by message count alone can land before the write and leave
 * the previous turn's tokens on screen until the next message. The query owns
 * this poll, which is why it is not a second `setInterval` beside it — it is
 * inert while the panel is closed (`enabled: isVisible`) and paused while the
 * tab is hidden (React Query's `refetchIntervalInBackground` default).
 */
const STATS_REFRESH_MS = 2_000;
/**
 * The usage tree walks every session the conversation launched (a scan of
 * session-start records per depth level), so it is refreshed far less often
 * than the stats read, and not at all after a 404 or 422.
 */
const USAGE_TREE_REFRESH_MS = 15_000;

/** What a reconnect came to, said as the panel's status line. */
export function engineMcpReconnectNotice(
  serverName: string,
  startOAuth: boolean,
  outcome: EngineCommandOutcome,
): string {
  switch (outcome.kind) {
    case 'answered':
      if (outcome.success === false)
        return outcome.text?.trim() || `${serverName} did not reconnect.`;
      return startOAuth
        ? `Asked the engine to sign in to ${serverName}. Its sign-in link appears in the chat.`
        : `Asked the engine to reconnect ${serverName}.`;
    case 'failed':
      return outcome.message;
    case 'not-declared':
      return "This engine can't reconnect its MCP servers.";
    case 'unsupported':
      return "This Station can't reconnect an engine's MCP servers. Updating Station may add it.";
  }
}

const loadConversationStatsModal = () =>
  import('./ConversationStatsModal').then((m) => ({
    default: m.ConversationStatsModal,
  }));

interface ConversationStatsProps {
  agentSlug: string;
  conversationId: string;
  apiBase: string;
  isVisible: boolean;
  onToggle: () => void;
  messageCount?: number;
  /** The engine's MCP servers for this session, shown in the panel. */
  engineMcpServers?: readonly ChatEngineMcpServer[];
  /**
   * The live execution Session those servers belong to; a reconnect is a
   * command on it. Absent hides the panel's Reconnect and Sign in actions.
   */
  executionThreadId?: string;
  /**
   * The session's engine can reconnect its MCP servers (its last
   * `engine-mcp.status` said `reconnect: true`). Without it the panel offers
   * no Reconnect or Sign in action: Codex, for one, has no reconnect.
   */
  engineMcpReconnect?: boolean;
  /**
   * `engineMcpServers` came from a complete report and is the whole list;
   * otherwise it holds partial reports that update the stored list.
   */
  engineMcpComplete?: boolean;
  /** The session's engine connection name, for the panel's wording. */
  engineName?: string;
}

export function ConversationStats({
  agentSlug,
  conversationId,
  apiBase,
  isVisible,
  onToggle,
  messageCount,
  engineMcpServers,
  executionThreadId,
  engineMcpReconnect,
  engineMcpComplete,
  engineName,
}: ConversationStatsProps) {
  // Same defect shape as SHELL-09's SkillsView: `useStats` already derives a
  // loading flag and this discarded it for a hardcoded `false`, so the modal's
  // own `isLoading ? <Loading> : <stats>` branch could never take its loading
  // arm and rendered zeroed stats as settled fact.
  const {
    stats,
    error,
    refetch,
    loading: isLoading,
  } = useStats(agentSlug, conversationId, apiBase, isVisible, STATS_REFRESH_MS);

  // The usage tree is a separate read: a conversation with no orchestration
  // record (404) simply has no breakdown, which is not a stats failure.
  const target = useOptionalConversationConnection();
  const usageTree = useConversationUsageTreeQuery(conversationId, apiBase, {
    enabled: isVisible,
    readTarget: target?.station,
    refetchInterval: isVisible ? USAGE_TREE_REFRESH_MS : false,
  });
  const usageTreeMissing =
    usageTree.error instanceof StationHttpError &&
    usageTree.error.status === 404;

  // The message count is the trigger that reflects the conversation; the poll
  // above is what covers the window in which the server has not written the
  // turn's stats yet. Both are refreshes of one query, not two caches.
  useEffect(() => {
    if (messageCount !== undefined && messageCount > 0) {
      refetch();
    }
  }, [messageCount, refetch]);

  // The stats carry every report folded on the server; a reopened
  // conversation's live state is empty, or holds only the partial reports
  // that arrived since, which update the stored list. Once a complete live
  // report has arrived the live list is the whole list and replaces it.
  // The reconnect bit is the live one when there is one.
  const liveMcp = engineMcpServers !== undefined;
  const mcpServers = liveMcp
    ? stats?.engineMcp && !engineMcpComplete
      ? foldEngineMcpStatus(stats.engineMcp, { servers: engineMcpServers })
          .servers
      : engineMcpServers
    : stats?.engineMcp?.servers;
  const mcpReconnectable = liveMcp
    ? engineMcpReconnect === true
    : stats?.engineMcp?.reconnect === true;

  const reconnect = useReconnectEngineMcpServerMutation(apiBase);
  const [mcpReconnect, setMcpReconnect] = useState<{
    pendingServer?: string;
    notice?: string;
  }>({});
  const { mutateAsync: reconnectMcpServer } = reconnect;
  const onReconnectMcpServer = useCallback<EngineMcpReconnect>(
    (serverName, { startOAuth }) => {
      if (!executionThreadId) return;
      setMcpReconnect({ pendingServer: serverName });
      void reconnectMcpServer({
        threadId: executionThreadId,
        serverName,
        startOAuth,
      }).then(
        (outcome) =>
          setMcpReconnect({
            notice: engineMcpReconnectNotice(serverName, startOAuth, outcome),
          }),
        (error: unknown) =>
          setMcpReconnect({ notice: userFacingErrorMessage(error) }),
      );
    },
    [executionThreadId, reconnectMcpServer],
  );

  useEffect(() => {
    if (!isVisible) return;

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onToggle();
      }
    };

    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [isVisible, onToggle]);

  if (!isVisible) return null;

  return (
    <LazyBoundary
      load={loadConversationStatsModal}
      componentProps={{
        context: { apiBase, conversationId },
        isVisible,
        isLoading,
        stats,
        error,
        onRetry: () => void refetch(),
        onToggle,
        usageTree: usageTree.data,
        usageTreeLoading:
          usageTree.isPending && usageTree.fetchStatus !== 'idle',
        usageTreeError: usageTreeMissing ? undefined : usageTree.error,
        engineMcpServers: mcpServers,
        ...(engineName ? { engineName } : {}),
        ...(executionThreadId && mcpReconnectable
          ? { onReconnectMcpServer }
          : {}),
        mcpReconnectPendingServer: mcpReconnect.pendingServer,
        mcpReconnectNotice: mcpReconnect.notice,
      }}
      pending={null}
    />
  );
}

export { ContextPercentage } from './ContextPercentage';
