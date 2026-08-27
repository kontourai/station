import { getAgentColor } from '../monitoring-utils';

export function MonitoringActiveFilters({
  selectedAgents,
  selectedConversation,
  selectedToolCallId,
  selectedTraceId,
  onRemoveAgent,
  onClearConversation,
  onClearToolCall,
  onClearTrace,
}: {
  selectedAgents: string[];
  selectedConversation: string | null;
  selectedToolCallId: string | null;
  selectedTraceId: string | null;
  onRemoveAgent: (agentSlug: string) => void;
  onClearConversation: () => void;
  onClearToolCall: () => void;
  onClearTrace: () => void;
}) {
  if (
    selectedAgents.length === 0 &&
    !selectedConversation &&
    !selectedToolCallId &&
    !selectedTraceId
  ) {
    return null;
  }

  return (
    <div className="active-filters-inline">
      {selectedAgents.map((agent) => (
        <span
          key={agent}
          className="filter-badge-inline"
          style={{
            borderLeft: `3px solid ${getAgentColor(agent)}`,
            background: `color-mix(in srgb, ${getAgentColor(agent)} 15%, var(--bg-tertiary))`,
          }}
        >
          agent:{agent}
          <button type="button" onClick={() => onRemoveAgent(agent)}>
            ×
          </button>
        </span>
      ))}
      {selectedConversation && (
        <span
          className="filter-badge-inline"
          style={{
            borderLeft: '3px solid var(--event-agent-start)',
            background:
              'color-mix(in srgb, var(--event-agent-start) 15%, var(--bg-tertiary))',
          }}
        >
          conversation:{selectedConversation.split(':').pop()?.substring(0, 8)}
          <button type="button" onClick={onClearConversation}>
            ×
          </button>
        </span>
      )}
      {selectedToolCallId && (
        <span
          className="filter-badge-inline"
          style={{
            borderLeft: '3px solid var(--event-tool-call)',
            background:
              'color-mix(in srgb, var(--event-tool-call) 15%, var(--bg-tertiary))',
          }}
        >
          tool:{selectedToolCallId}
          <button type="button" onClick={onClearToolCall}>
            ×
          </button>
        </span>
      )}
      {selectedTraceId && (
        <span
          className="filter-badge-inline"
          style={{
            borderLeft: '3px solid var(--color-primary)',
            background:
              'color-mix(in srgb, var(--color-primary) 15%, var(--bg-tertiary))',
          }}
        >
          trace:...{selectedTraceId.slice(-8)}
          <button type="button" onClick={onClearTrace}>
            ×
          </button>
        </span>
      )}
    </div>
  );
}
