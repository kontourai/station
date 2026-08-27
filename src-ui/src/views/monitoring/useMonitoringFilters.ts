import { useState } from 'react';
import type { ActivateEvent } from '../../utils/activatable';
import { EVENT_TYPE_GROUPS } from '../monitoring-utils';
import { parseMonitoringSearchQuery } from './view-utils';

export function useMonitoringFilters() {
  const [searchQuery, setSearchQuery] = useState('');
  const [eventTypeFilter, setEventTypeFilter] = useState<string[]>(
    Object.values(EVENT_TYPE_GROUPS).flat(),
  );
  const [selectedAgents, setSelectedAgents] = useState<string[]>([]);
  const [selectedConversation, setSelectedConversation] = useState<
    string | null
  >(null);
  const [selectedToolCallId, setSelectedToolCallId] = useState<string | null>(
    null,
  );
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(null);

  const toggleEventType = (group: string) => {
    const groupTypes = EVENT_TYPE_GROUPS[
      group as keyof typeof EVENT_TYPE_GROUPS
    ] as readonly string[];
    const allSelected = groupTypes.every((type) =>
      eventTypeFilter.includes(type),
    );

    if (allSelected) {
      setEventTypeFilter((prev) => prev.filter((t) => !groupTypes.includes(t)));
      return;
    }

    setEventTypeFilter((prev) => [...new Set([...prev, ...groupTypes])]);
  };

  const handleConversationClick = (
    conversationId: string,
    agentSlug: string,
  ) => {
    if (selectedConversation === conversationId) {
      setSelectedConversation(null);
      return;
    }
    setSelectedConversation(conversationId);
    setSelectedAgents([agentSlug]);
  };

  const handleToolCallClick = (toolCallId: string) => {
    setSelectedToolCallId((prev) => (prev === toolCallId ? null : toolCallId));
  };

  const handleTraceClick = (traceId: string) => {
    setSelectedTraceId((prev) => (prev === traceId ? null : traceId));
  };

  const handleAgentClick = (agentSlug: string, event: ActivateEvent) => {
    if (event.shiftKey) {
      setSelectedAgents((prev) =>
        prev.includes(agentSlug)
          ? prev.filter((agent) => agent !== agentSlug)
          : [...prev, agentSlug],
      );
      return;
    }
    setSelectedAgents((prev) =>
      prev.length === 1 && prev[0] === agentSlug ? [] : [agentSlug],
    );
  };

  const syncFiltersFromQuery = (query: string) => {
    const parsed = parseMonitoringSearchQuery(query);
    if (parsed.filters.agent) {
      setSelectedAgents(parsed.filters.agent);
    }
    if (parsed.filters.conversation?.[0]) {
      setSelectedConversation(parsed.filters.conversation[0]);
    }
    if (parsed.filters.tool?.[0]) {
      setSelectedToolCallId(parsed.filters.tool[0]);
    }
    if (parsed.filters.trace?.[0]) {
      setSelectedTraceId(parsed.filters.trace[0]);
    }
    setSearchQuery(parsed.text);
  };

  return {
    eventTypeFilter,
    handleAgentClick,
    handleConversationClick,
    handleToolCallClick,
    handleTraceClick,
    searchQuery,
    selectedAgents,
    selectedConversation,
    selectedToolCallId,
    selectedTraceId,
    setSearchQuery,
    setSelectedAgents,
    setSelectedConversation,
    setSelectedToolCallId,
    setSelectedTraceId,
    syncFiltersFromQuery,
    toggleEventType,
  };
}
