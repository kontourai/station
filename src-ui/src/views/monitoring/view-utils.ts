import type { SessionLifecycleState } from '@kontourai/station-contracts/session-lifecycle';
import { isSessionLifecycleStateStopped } from '@kontourai/station-contracts/session-lifecycle';
import { K, monitoringAgentName } from '@shared/monitoring-keys';
import type {
  AgentStats,
  MonitoringEvent,
  MonitoringStats,
} from '../../contexts/MonitoringContext';
import { parseSearchQuery } from '../../hooks/useSearchAutocomplete';
import { getConversationColor, getEventType } from '../monitoring-utils';

const MONITORING_QUERY_FILTER_KEYS = [
  'agent',
  'conversation',
  'tool',
  'trace',
] as const;

export interface MonitoringSelectionState {
  searchQuery: string;
  selectedAgents: string[];
  selectedConversation: string | null;
  selectedToolCallId: string | null;
  selectedTraceId: string | null;
  eventTypeFilter: string[];
}

export function parseMonitoringSearchQuery(query: string) {
  return parseSearchQuery(query, [...MONITORING_QUERY_FILTER_KEYS]);
}

export function filterMonitoringEvents(
  events: MonitoringEvent[],
  selection: MonitoringSelectionState,
) {
  const parsed = parseMonitoringSearchQuery(selection.searchQuery);

  return events
    .filter((event) => {
      const agentsToFilter = parsed.filters.agent || selection.selectedAgents;
      if (agentsToFilter.length > 0) {
        // A slug-less event used to be unreachable behind ANY agent filter:
        // `|| ''` made it match a bucket nobody can select. It now answers to
        // the same '(unnamed)' name /api/insights reports — via the SHARED
        // rule, so a fourth surface cannot re-derive it differently
        // (archive#3086).
        if (
          !agentsToFilter.includes(
            monitoringAgentName(event as Record<string, unknown>),
          )
        ) {
          return false;
        }
      }

      const conversationToFilter =
        parsed.filters.conversation?.[0] || selection.selectedConversation;
      if (
        conversationToFilter &&
        event[K.CONVERSATION_ID] !== conversationToFilter
      ) {
        return false;
      }

      const toolCallIdToFilter =
        parsed.filters.tool?.[0] || selection.selectedToolCallId;
      if (toolCallIdToFilter && event[K.TOOL_CALL_ID] !== toolCallIdToFilter) {
        return false;
      }

      const traceIdToFilter =
        parsed.filters.trace?.[0] || selection.selectedTraceId;
      if (traceIdToFilter && event[K.TRACE_ID] !== traceIdToFilter) {
        return false;
      }

      if (
        selection.eventTypeFilter.length > 0 &&
        !selection.eventTypeFilter.includes(getEventType(event))
      ) {
        return false;
      }

      const isIncompleteFilter = /^(agent|conversation|tool|trace):$/.test(
        parsed.text.trim(),
      );
      if (
        parsed.text &&
        !isIncompleteFilter &&
        !JSON.stringify(event).toLowerCase().includes(parsed.text.toLowerCase())
      ) {
        return false;
      }

      return true;
    })
    .sort(
      (a, b) =>
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );
}

export function getHistoricalAgentSlugs(
  filteredEvents: MonitoringEvent[],
  activeAgents: AgentStats[],
) {
  return [
    // Offer '(unnamed)' as a selectable name rather than dropping those
    // events from the picker entirely — an option nobody can choose is how
    // they became invisible in the first place.
    ...new Set(
      filteredEvents.map((e) =>
        monitoringAgentName(e as Record<string, unknown>),
      ),
    ),
  ].filter(
    (slug): slug is string =>
      !activeAgents.some((agent) => agent.slug === slug),
  );
}

export function getMonitoringAgentCountLabel(
  stats: MonitoringStats | null,
  filteredEvents: MonitoringEvent[],
) {
  const activeCount = stats?.agents.length || 0;
  const historicalCount = getHistoricalAgentSlugs(
    filteredEvents,
    stats?.agents || [],
  ).length;
  return `${activeCount} Active${historicalCount > 0 ? ` • ${historicalCount} Historical` : ''}`;
}

export function getRunningConversations(
  events: MonitoringEvent[],
  agentSlug: string,
) {
  return events
    .filter(
      (event) =>
        event[K.AGENT_SLUG] === agentSlug &&
        getEventType(event) === 'agent-start' &&
        event[K.CONVERSATION_ID],
    )
    .reduce(
      (acc, event) => {
        const conversationId = event[K.CONVERSATION_ID];
        if (
          typeof conversationId === 'string' &&
          !acc.some((conversation) => conversation.id === conversationId)
        ) {
          acc.push({
            id: conversationId,
            color: getConversationColor(conversationId),
          });
        }
        return acc;
      },
      [] as Array<{ id: string; color: string }>,
    );
}

/**
 * Monitoring's Active/Running counts, derived from the SAME orchestration
 * session read-model the chat dock and Developer → Archive read
 * (audit 6-OPS-26).
 *
 * They used to come from `/monitoring/stats`'s own agent projection, which is
 * folded from the monitoring event store — a different substrate that stayed
 * empty for a real Claude Code turn, so Monitoring reported `Active: 0 /
 * Running: 0` while the dock showed that very session running. Two surfaces
 * describing one Station disagreed because they were counting different
 * things, and only one of them was counting the work.
 *
 * `activeSessions` is every session whose work has not stopped;
 * `runningTurns` is the subset with a turn actually open (`hasActiveTurn`,
 * the server's own turn fold). The event stream, the agent cards and the
 * per-agent conversation lists are untouched — this changes what the two
 * summary numbers are derived from, not what Monitoring shows.
 */
export function monitoringSessionCounts(
  sessions: readonly {
    lifecycleState?: SessionLifecycleState;
    hasActiveTurn?: boolean;
  }[],
): { activeSessions: number; runningTurns: number } {
  let activeSessions = 0;
  let runningTurns = 0;
  for (const session of sessions) {
    // An undecorated session (a peer older than the lifecycle decoration)
    // reports no state; counting it as active would be a claim nothing
    // computed, so it is only counted when it has an open turn.
    if (
      session.lifecycleState &&
      !isSessionLifecycleStateStopped(session.lifecycleState)
    ) {
      activeSessions += 1;
    }
    if (session.hasActiveTurn === true) runningTurns += 1;
  }
  return { activeSessions, runningTurns };
}
