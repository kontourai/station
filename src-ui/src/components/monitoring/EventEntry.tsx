import { K } from '../../../../src-shared/monitoring-keys';
import type { MonitoringEvent } from '../../contexts/MonitoringContext';
import { getAgentColor, getEventType } from '../../views/monitoring-utils';
import { EventEntryHeader } from './event-entry/EventEntryHeader';
import { EventEntrySections } from './event-entry/EventEntrySections';

interface EventEntryProps {
  event: MonitoringEvent;
  isNew: boolean;
  selectedTraceId: string | null;
  selectedConversation: string | null;
  selectedToolCallId: string | null;
  onTraceClick: (traceId: string) => void;
  onConversationClick: (conversationId: string, agentSlug: string) => void;
  onToolCallClick: (toolCallId: string) => void;
  onCopyResult: (text: string) => void;
}

export function EventEntry({
  event,
  isNew,
  selectedTraceId,
  selectedConversation,
  selectedToolCallId,
  onTraceClick,
  onConversationClick,
  onToolCallClick,
  onCopyResult,
}: EventEntryProps) {
  const agentColor = event[K.AGENT_SLUG]
    ? getAgentColor(event[K.AGENT_SLUG] as string)
    : undefined;

  return (
    <div
      className={`log-entry event-${getEventType(event)} agent-${event[K.AGENT_SLUG]} ${isNew ? 'new-event' : ''}`}
      style={
        agentColor
          ? {
              background: `color-mix(in srgb, ${agentColor} 8%, var(--bg-secondary))`,
            }
          : undefined
      }
    >
      <EventEntryHeader
        event={event}
        selectedTraceId={selectedTraceId}
        selectedConversation={selectedConversation}
        selectedToolCallId={selectedToolCallId}
        onTraceClick={onTraceClick}
        onConversationClick={onConversationClick}
        onToolCallClick={onToolCallClick}
      />
      <EventEntrySections event={event} onCopyResult={onCopyResult} />
    </div>
  );
}
