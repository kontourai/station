import {
  K,
  monitoringAgentName,
} from '../../../../../src-shared/monitoring-keys';
import type { MonitoringEvent } from '../../../contexts/MonitoringContext';
import { getAgentColor, getEventType } from '../../../views/monitoring-utils';
import { CheckGlyph, WarningGlyph } from '../../icons/Glyph';
import { buildEventTimestampTitle } from './utils';

interface EventEntryHeaderProps {
  event: MonitoringEvent;
  selectedTraceId: string | null;
  selectedConversation: string | null;
  selectedToolCallId: string | null;
  onTraceClick: (traceId: string) => void;
  onConversationClick: (conversationId: string, agentSlug: string) => void;
  onToolCallClick: (toolCallId: string) => void;
}

export function EventEntryHeader({
  event,
  selectedTraceId,
  selectedConversation,
  selectedToolCallId,
  onTraceClick,
  onConversationClick,
  onToolCallClick,
}: EventEntryHeaderProps) {
  const agentColor = event[K.AGENT_SLUG]
    ? getAgentColor(event[K.AGENT_SLUG] as string)
    : undefined;

  return (
    <div className="log-row">
      <div className="log-timestamp-col">
        <div className="log-timestamp" title={buildEventTimestampTitle(event)}>
          {event.timestamp
            ? new Date(event.timestamp).toLocaleTimeString()
            : '-'}
          {!!event[K.TIMESTAMP_MS] && (
            <span className="timestamp-ms">
              .{String(event[K.TIMESTAMP_MS] % 1000).padStart(3, '0')}
            </span>
          )}
        </div>
        {!!event[K.TRACE_ID] && (
          <button
            type="button"
            className={`trace-pill ${selectedTraceId === event[K.TRACE_ID] ? 'selected' : ''}`}
            onClick={() => onTraceClick(event[K.TRACE_ID] as string)}
            title={`Trace ID: ${event[K.TRACE_ID]}\nClick to filter`}
            style={
              selectedTraceId === event[K.TRACE_ID] && agentColor
                ? { borderColor: agentColor, color: agentColor }
                : undefined
            }
          >
            {(event[K.TRACE_ID] as string).slice(-8)}
          </button>
        )}
      </div>
      <div className="log-type">{getEventType(event).toUpperCase()}</div>
      <div className="log-agent">
        {monitoringAgentName(event as Record<string, unknown>)}
      </div>

      <div className="log-data">
        {!!event[K.CONVERSATION_ID] && (
          <span className="log-inline">
            <span className="meta-label">Conversation:</span>
            <button
              type="button"
              className={`pill-button pill-button-conversation ${selectedConversation === event[K.CONVERSATION_ID] ? 'selected' : ''}`}
              onClick={() =>
                onConversationClick(
                  event[K.CONVERSATION_ID] as string,
                  // The DERIVED name, same as the label above. Sending the raw
                  // slug set selectedAgents to [undefined], which matches no
                  // event at all — clicking the pill on an '(unnamed)' row
                  // blanked the entire log and emptied the sidebar with it.
                  monitoringAgentName(event as Record<string, unknown>),
                )
              }
              title="Filter by conversation"
            >
              ...{(event[K.CONVERSATION_ID] as string).slice(-6)}
            </button>
          </span>
        )}

        {!!event[K.TOOL_CALL_ID] && (
          <span className="log-inline">
            <span className="meta-label">Tool Call:</span>
            <button
              type="button"
              className={`pill-button pill-button-tool ${selectedToolCallId === event[K.TOOL_CALL_ID] ? 'selected' : ''}`}
              onClick={() => onToolCallClick(event[K.TOOL_CALL_ID] as string)}
              title="Filter by tool call ID"
            >
              ...{(event[K.TOOL_CALL_ID] as string).slice(-6)}
            </button>
          </span>
        )}

        {!!event[K.TOOL_NAME] && (
          <span className="log-inline">
            <span className="meta-label">Tool:</span>
            <span className="pill-badge tool-badge">
              {event[K.TOOL_NAME] as string}
            </span>
          </span>
        )}

        {event[K.HEALTHY] !== undefined && (
          <span className="log-inline">
            <span className="meta-label">Status:</span>
            <span
              className={`pill-badge ${event[K.HEALTHY] ? 'health-ok' : 'health-error'}`}
            >
              {event[K.HEALTHY] ? (
                <>
                  <CheckGlyph /> Healthy
                </>
              ) : (
                <>
                  <WarningGlyph /> Unhealthy
                </>
              )}
            </span>
          </span>
        )}

        <IntegrationBadges event={event} />

        {!!(event[K.FINISH_REASONS] as string[] | undefined)?.[0] && (
          <span className="log-inline">
            <span className="meta-label">Reason:</span>
            <span className="pill-badge">
              {(event[K.FINISH_REASONS] as string[])[0]}
            </span>
            {(event[K.FINISH_REASONS] as string[])[0] === 'tool-calls' &&
              !!event[K.AGENT_MAX_STEPS] && (
                <span className="max-steps-note">
                  (Hit max steps limit: {event[K.AGENT_STEPS]}/
                  {event[K.AGENT_MAX_STEPS]})
                </span>
              )}
          </span>
        )}
      </div>
    </div>
  );
}

function IntegrationBadges({ event }: { event: MonitoringEvent }) {
  const integrations = event[K.HEALTH_INTEGRATIONS] as
    | Array<{
        type: string;
        id: string;
        connected: boolean;
        metadata?: { transport: string; toolCount: number };
      }>
    | undefined;

  if (!integrations?.length) return null;

  return (
    <span className="log-inline">
      <span className="meta-label">Integrations:</span>
      {integrations.map((integration, idx) => (
        <span
          key={idx}
          className={`pill-badge ${integration.connected ? 'health-ok' : 'health-error'}`}
          title={`${integration.type.toUpperCase()} - ${integration.connected ? 'Connected' : 'Disconnected'}${integration.metadata ? `\nTransport: ${integration.metadata.transport}\nTools: ${integration.metadata.toolCount}` : ''}`}
        >
          {integration.id}
          {integration.metadata && ` (${integration.metadata.toolCount} tools)`}
        </span>
      ))}
    </span>
  );
}
