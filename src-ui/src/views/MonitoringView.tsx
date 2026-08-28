import { useOrchestrationSessionsQuery } from '@kontourai/station-sdk';
import { K } from '@shared/monitoring-keys';
import { useEffect, useMemo, useRef, useState } from 'react';
import { FleetReceipts } from '../components/monitoring/FleetRoutingReceipts';
import { MetricsPanel } from '../components/monitoring/MetricsPanel';
import { useModels } from '../contexts/ModelsContext';
import {
  monitoringEventIdentity,
  useMonitoring,
} from '../contexts/MonitoringContext';
import { useCopyToClipboardToast } from '../hooks/useCopyToClipboardToast';
import { useSearchAutocomplete } from '../hooks/useSearchAutocomplete';
import { MonitoringViewBoundary } from './MonitoringErrorBoundary';
import { MonitoringLogControls } from './MonitoringLogControls';
import { MonitoringTimeControls } from './MonitoringTimeControls';
import { MonitoringActiveFilters } from './monitoring/MonitoringActiveFilters';
import { MonitoringHeader } from './monitoring/MonitoringHeader';
import { MonitoringLogStream } from './monitoring/MonitoringLogStream';
import { MonitoringSidebar } from './monitoring/MonitoringSidebar';
import { useMonitoringFilters } from './monitoring/useMonitoringFilters';
import {
  filterMonitoringEvents,
  monitoringSessionCounts,
} from './monitoring/view-utils';
import { useMonitoringTimeRange } from './monitoring-time-range';
import './page-layout.css';
import './MonitoringWidgets.css';

function MonitoringView() {
  const {
    stats,
    events,
    clearEvents,
    setTimeRange,
    connectionStatus,
    isLoading,
    readError,
    retryRead,
  } = useMonitoring();
  // Monitoring's two summary numbers now come from the SAME
  // orchestration session projection the chat dock and Developer -> Archive
  // read, rather than from the monitoring event store's own agent fold — that
  // fold reported `Active: 0 / Running: 0` while a real Claude Code turn was
  // visibly running in the dock. The event stream below is unchanged.
  const {
    data: orchestrationSessions,
    status: orchestrationSessionsStatus,
    refetch: refetchOrchestrationSessions,
  } = useOrchestrationSessionsQuery();
  // `data` is `undefined` while the read is
  // pending and while it has failed, and defaulting that to `[]` reported an
  // authoritative `0 / 0` — a transient (and, on a failed read, permanent)
  // false zero, which is the same discrepancy in a new costume. Counts are
  // rendered only from a read that SUCCEEDED.
  const sessionCounts = useMemo(
    () =>
      orchestrationSessionsStatus === 'success'
        ? monitoringSessionCounts(orchestrationSessions ?? [])
        : null,
    [orchestrationSessions, orchestrationSessionsStatus],
  );
  const copyToastResult = useCopyToClipboardToast();
  const models = useModels();
  const [autoFollow, setAutoFollow] = useState(true);
  const {
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
  } = useMonitoringFilters();

  const searchFilters = useMemo(
    () => [
      {
        key: 'agent',
        type: 'agent' as const,
        getOptions: () => (stats?.agents || []).map((a) => a.slug),
      },
      {
        key: 'conversation',
        type: 'conversation' as const,
        getOptions: () =>
          [
            ...new Set(events.map((e) => e[K.CONVERSATION_ID]).filter(Boolean)),
          ] as string[],
      },
      {
        key: 'tool',
        type: 'tool' as const,
        getOptions: () =>
          [
            ...new Set(events.map((e) => e[K.TOOL_CALL_ID]).filter(Boolean)),
          ] as string[],
      },
      {
        key: 'trace',
        type: 'trace' as const,
        getOptions: () =>
          [
            ...new Set(events.map((e) => e[K.TRACE_ID]).filter(Boolean)),
          ] as string[],
      },
    ],
    [stats, events],
  );

  const {
    showAutocomplete,
    autocompleteOptions,
    selectedIndex,
    handleSelect,
    handleKeyDown,
  } = useSearchAutocomplete(searchQuery, searchFilters);

  const {
    timeMode,
    relativeTime,
    absoluteStart,
    absoluteEnd,
    isLiveMode,
    clearTime,
    elapsedLabel,
    showTimeControls,
    setAbsoluteStart,
    setIsLiveMode,
    setShowTimeControls,
    handleClearAll,
    handleTimeModeChange,
    applyAbsoluteRange,
    selectRelativeTime,
    setAbsoluteEndValue,
    setAbsoluteEndToNow,
  } = useMonitoringTimeRange(clearEvents, setTimeRange);
  const [newEventIds, setNewEventIds] = useState<Set<string>>(new Set());
  /** Identities already on screen; `null` until the first list arrives. */
  const seenEventIdsRef = useRef<Set<string> | null>(null);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const logEndRef = useRef<HTMLDivElement>(null);
  const logStreamRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const filtersParam = params.get('filters');
      if (!filtersParam) return;
      const filters = JSON.parse(filtersParam);
      if (filters.trace) setSelectedTraceId(filters.trace[0] ?? null);
      if (filters.agent) setSelectedAgents(filters.agent);
      if (filters.conversation)
        setSelectedConversation(filters.conversation[0] ?? null);
      if (filters.tool) setSelectedToolCallId(filters.tool[0] ?? null);
    } catch {
      /* ignore malformed params */
    }
  }, [
    setSelectedAgents,
    setSelectedConversation,
    setSelectedToolCallId,
    setSelectedTraceId,
  ]);

  /*
   * this highlighted indices from the previous length
   * to the new one, which only identifies arrivals if events are appended and
   * the list never drops any. Neither holds since events are placed by
   * timestamp and capped: a late 10:02 inserted before an existing 10:03
   * highlighted the last row instead of the one that arrived, and once the
   * retention cap is reached every arrival replaces a row without changing
   * `length`, so nothing was highlighted at all.
   *
   * What arrived is a set difference on identity, not a count. The previous
   * set is bounded by the retention cap, and each identity is canonicalized
   * once per event object (see `monitoringEventIdentity`), so the diff costs
   * a lookup per row rather than a re-walk of every payload.
   */
  useEffect(() => {
    const currentIds = new Set(events.map(monitoringEventIdentity));
    const previousIds = seenEventIdsRef.current;
    seenEventIdsRef.current = currentIds;
    // The first list this view ever sees is history, not arrivals.
    if (previousIds === null) return;
    const arrived = [...currentIds].filter((id) => !previousIds.has(id));
    if (arrived.length === 0) return;
    setNewEventIds(new Set(arrived));
    const timer = setTimeout(() => setNewEventIds(new Set()), 5000);
    return () => clearTimeout(timer);
  }, [events]);

  useEffect(() => {
    const logStream = logStreamRef.current;
    if (!logStream) return;

    const handleScroll = () => {
      const isAtBottom =
        logStream.scrollHeight - logStream.scrollTop - logStream.clientHeight <
        50;
      setShowScrollButton(!autoFollow && !isAtBottom);
    };

    logStream.addEventListener('scroll', handleScroll);
    return () => logStream.removeEventListener('scroll', handleScroll);
  }, [autoFollow]);

  const scrollToBottom = () => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  const handleAutocompleteSelect = (
    option: (typeof autocompleteOptions)[0],
  ) => {
    const newQuery = handleSelect(option);
    setSearchQuery(newQuery);
    syncFiltersFromQuery(newQuery);
  };

  const handleSearchKeyDown = (e: React.KeyboardEvent) => {
    const result = handleKeyDown(e);
    if (result) {
      setSearchQuery(result);
      syncFiltersFromQuery(result);
    }
  };

  const filteredEvents = useMemo(
    () =>
      filterMonitoringEvents(events, {
        searchQuery,
        selectedAgents,
        selectedConversation,
        selectedToolCallId,
        selectedTraceId,
        eventTypeFilter,
      }),
    [
      eventTypeFilter,
      events,
      searchQuery,
      selectedAgents,
      selectedConversation,
      selectedToolCallId,
      selectedTraceId,
    ],
  );

  /*
   * this depended on `autoFollow` alone, so it fired
   * when the toggle changed and never again. That was survivable while
   * arrivals were PREPENDED (they landed in view at the top); now that events
   * are placed chronologically and the newest sits at the bottom, an arrival
   * appears below the viewport and Auto Follow has to actually follow it —
   * while the scroll button stays suppressed precisely because Auto Follow is
   * on. Depends on the RENDERED list, so a filtered-out arrival does not
   * scroll the view.
   */
  useEffect(() => {
    if (!autoFollow || filteredEvents.length === 0) return;
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [autoFollow, filteredEvents]);

  return (
    <div className="pane-host monitoring-page">
      <MonitoringHeader
        sessionCounts={sessionCounts}
        sessionReadStatus={orchestrationSessionsStatus}
        onRetrySessionRead={() => {
          void refetchOrchestrationSessions();
        }}
        connectionStatus={connectionStatus}
      >
        <MonitoringTimeControls
          clearTime={clearTime}
          timeMode={timeMode}
          relativeTime={relativeTime}
          absoluteStart={absoluteStart}
          absoluteEnd={absoluteEnd}
          isLiveMode={isLiveMode}
          elapsedLabel={elapsedLabel}
          showTimeControls={showTimeControls}
          onToggleControls={() => {
            setShowTimeControls(!showTimeControls);
            if (!showTimeControls && (clearTime || absoluteStart)) {
              handleTimeModeChange('absolute');
            }
          }}
          onTimeModeChange={handleTimeModeChange}
          onRelativeSelect={selectRelativeTime}
          onAbsoluteStartChange={setAbsoluteStart}
          onAbsoluteEndChange={setAbsoluteEndValue}
          onAbsoluteEndNow={setAbsoluteEndToNow}
          onApplyAbsolute={applyAbsoluteRange}
          onToggleLiveMode={() => setIsLiveMode(!isLiveMode)}
          onClearAll={handleClearAll}
        />
      </MonitoringHeader>

      <div className="monitoring-page__content">
        <MonitoringSidebar
          stats={stats}
          events={events}
          filteredEvents={filteredEvents}
          selectedAgents={selectedAgents}
          onAgentClick={handleAgentClick}
          onConversationClick={handleConversationClick}
          resolveModelName={(modelId) =>
            models.find((model) => model.id === modelId)?.name ||
            modelId ||
            'N/A'
          }
        />

        <div className="monitoring-page__main">
          <MonitoringLogControls
            eventTypeFilter={eventTypeFilter}
            onToggleEventType={toggleEventType}
            searchQuery={searchQuery}
            onSearchQueryChange={setSearchQuery}
            onSearchKeyDown={handleSearchKeyDown}
            onSearchBlur={() => syncFiltersFromQuery(searchQuery)}
            showAutocomplete={showAutocomplete}
            autocompleteOptions={autocompleteOptions}
            selectedIndex={selectedIndex}
            onAutocompleteSelect={handleAutocompleteSelect}
            actions={
              <button
                type="button"
                onClick={() => setAutoFollow(!autoFollow)}
                className={`btn-toggle ${autoFollow ? 'active' : ''}`}
                aria-pressed={autoFollow}
              >
                Auto Follow
              </button>
            }
          />

          <div className="monitoring-active-filter-bar">
            <MonitoringActiveFilters
              selectedAgents={selectedAgents}
              selectedConversation={selectedConversation}
              selectedToolCallId={selectedToolCallId}
              selectedTraceId={selectedTraceId}
              onRemoveAgent={(agent) =>
                setSelectedAgents((prev) => prev.filter((a) => a !== agent))
              }
              onClearConversation={() => setSelectedConversation(null)}
              onClearToolCall={() => setSelectedToolCallId(null)}
              onClearTrace={() => setSelectedTraceId(null)}
            />
          </div>

          <MonitoringLogStream
            events={events}
            filteredEvents={filteredEvents}
            isLoading={isLoading}
            readError={readError}
            onRetryRead={retryRead}
            newEventIds={newEventIds}
            selectedTraceId={selectedTraceId}
            selectedConversation={selectedConversation}
            selectedToolCallId={selectedToolCallId}
            showScrollButton={showScrollButton}
            logEndRef={logEndRef}
            logStreamRef={logStreamRef}
            onTraceClick={handleTraceClick}
            onConversationClick={handleConversationClick}
            onToolCallClick={handleToolCallClick}
            onCopyResult={(text) => {
              void copyToastResult(text);
            }}
            onScrollToBottom={scrollToBottom}
          />
          <MetricsPanel />
          {/* archive#1398: the routing receipt is the differentiator,
              so it lives on the surface an operator already opens to ask
              what this Station has been doing. */}
          <FleetReceipts />
        </div>
      </div>
    </div>
  );
}

export function MonitoringViewWithBoundary() {
  return (
    <MonitoringViewBoundary>
      <MonitoringView />
    </MonitoringViewBoundary>
  );
}
