import type { RefObject } from 'react';
import { Button } from '../../components/Button';
import { EventEntry } from '../../components/monitoring/EventEntry';
import {
  describeReadFailure,
  Empty,
  ErrorState,
  Skeleton,
} from '../../components/state';
import { monitoringEventIdentity } from '../../contexts/MonitoringContext';

interface MonitoringLogStreamProps {
  events: any[];
  filteredEvents: any[];
  isLoading: boolean;
  /**
   * station#3658: the historical read's failure, when it had one. `null` and
   * "the read came back with nothing" are different facts and get different
   * states — the empty state below is a claim about this Station's activity
   * and must not be drawn over a request that never succeeded.
   */
  readError: unknown;
  onRetryRead: () => void;
  newEventIds: Set<string>;
  selectedTraceId: string | null;
  selectedConversation: string | null;
  selectedToolCallId: string | null;
  showScrollButton: boolean;
  logEndRef: RefObject<HTMLDivElement | null>;
  logStreamRef: RefObject<HTMLDivElement | null>;
  onTraceClick: (traceId: string) => void;
  onConversationClick: (conversationId: string, agentSlug: string) => void;
  onToolCallClick: (toolCallId: string) => void;
  onCopyResult: (text: string) => void;
  onScrollToBottom: () => void;
}

export function MonitoringLogStream({
  events,
  filteredEvents,
  isLoading,
  readError,
  onRetryRead,
  newEventIds,
  selectedTraceId,
  selectedConversation,
  selectedToolCallId,
  showScrollButton,
  logEndRef,
  logStreamRef,
  onTraceClick,
  onConversationClick,
  onToolCallClick,
  onCopyResult,
  onScrollToBottom,
}: MonitoringLogStreamProps) {
  const eventRows = filteredEvents.map((event, idx) => (
    <EventEntry
      key={idx}
      event={event}
      isNew={newEventIds.has(monitoringEventIdentity(event))}
      selectedTraceId={selectedTraceId}
      selectedConversation={selectedConversation}
      selectedToolCallId={selectedToolCallId}
      onTraceClick={onTraceClick}
      onConversationClick={onConversationClick}
      onToolCallClick={onToolCallClick}
      onCopyResult={onCopyResult}
    />
  ));

  return (
    <div className="log-stream" ref={logStreamRef}>
      {isLoading && events.length === 0 ? (
        <div
          className="monitoring-log-state"
          role="status"
          aria-label="Loading events"
        >
          <Skeleton variant="block" />
          <Skeleton variant="block" />
          <Skeleton variant="block" />
        </div>
      ) : readError ? (
        // The failed read comes FIRST and the empty state is withheld
        // entirely: "No events yet · Waiting for agent activity…" is a
        // statement about this Station, and it was being made on the strength
        // of a request that failed. Any events the live stream has already
        // delivered still render below it — an unreadable history does not
        // make the events in hand disappear.
        //
        // Review LOW-5: "Unable to load events" overstated it for exactly
        // that reason — the live stream can be healthy and rendering events
        // directly beneath the message. What failed is the HISTORY read, and
        // that is the fact the server computed.
        <>
          <ErrorState
            variant="compact"
            className="monitoring-log-state"
            title="Unable to load event history"
            description={describeReadFailure(readError)}
            action={
              <Button size="sm" onClick={onRetryRead}>
                Retry
              </Button>
            }
          />
          {eventRows}
        </>
      ) : filteredEvents.length === 0 ? (
        <Empty
          variant="compact"
          className="monitoring-log-state"
          label="No events yet"
          description="Waiting for agent activity..."
        />
      ) : (
        eventRows
      )}
      <div ref={logEndRef} />
      {showScrollButton && (
        <button
          type="button"
          className="scroll-to-bottom"
          onClick={onScrollToBottom}
          title="Scroll to bottom"
        >
          ↓
        </button>
      )}
    </div>
  );
}
