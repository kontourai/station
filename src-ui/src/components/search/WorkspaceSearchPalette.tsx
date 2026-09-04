import {
  UNIFIED_SEARCH_V1,
  type UnifiedSearchOpenLocator,
  type UnifiedSearchResult,
} from '@kontourai/station-contracts/unified-search';
import { useUnifiedSearchQuery } from '@kontourai/station-sdk';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { navigationStore } from '../../contexts/navigation-store';
import { isComposingKeyEvent } from '../../lib/isComposingKeyEvent';
import { Button } from '../Button';
import { Dialog } from '../Dialog';
import { Empty, ErrorState, SkeletonBlock } from '../state';
import { ExactMessageInspector } from './ExactMessageInspector';

const sourceLabel = (id: string) =>
  id === 'station.tasks'
    ? 'Tasks'
    : id === 'station.messages'
      ? 'Messages'
      : 'Unsupported source';
export default function WorkspaceSearchPalette({
  query,
  onQueryChange,
  onClose,
  onCommands,
}: {
  query: string;
  onQueryChange: (query: string) => void;
  onClose: () => void;
  onCommands: () => void;
}) {
  const scope = useHostRequestAuthorityScope();
  const [debounced, setDebounced] = useState('');
  const [active, setActive] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [selected, setSelected] = useState<{
    locator: Extract<UnifiedSearchOpenLocator, { kind: 'session-message' }>;
    scope: NonNullable<typeof scope>;
  } | null>(null);
  const flight = useRef<AbortController | null>(null);
  const invalidate = () => {
    flight.current?.abort();
    flight.current = null;
    setOpening(false);
  };
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(query.trim()), 200);
    return () => window.clearTimeout(timer);
  }, [query]);
  useEffect(() => {
    if (!scope?.isCurrent()) flight.current?.abort();
    return () => {
      flight.current?.abort();
    };
  }, [scope]);
  useEffect(() => {
    if (selected && (selected.scope !== scope || !selected.scope.isCurrent()))
      setSelected(null);
  }, [scope, selected]);
  const request = useMemo(
    () => ({
      version: UNIFIED_SEARCH_V1,
      query: debounced,
      filters: { kinds: ['task', 'message'] as ('task' | 'message')[] },
    }),
    [debounced],
  );
  const search = useUnifiedSearchQuery(request, {
    requestScope: scope,
    enabled: !selected && query.trim() === debounced && debounced.length >= 2,
  });
  const ready =
    scope?.isCurrent() && query.trim() === debounced && debounced.length >= 2;
  const rows = ready ? (search.data?.results ?? []) : [];
  const current = (
    captured: NonNullable<typeof scope>,
    controller: AbortController,
  ) =>
    !controller.signal.aborted &&
    flight.current === controller &&
    captured.isCurrent();
  async function activate(row: UnifiedSearchResult) {
    if (!scope?.isCurrent() || flight.current) return;
    const intent = row.openIntent;
    const locator: UnifiedSearchOpenLocator | undefined =
      intent.kind === 'task'
        ? intent
        : intent.kind === 'session-message' && intent.matchedEventId
          ? {
              kind: 'session-message',
              sessionId: intent.sessionId,
              matchedEventId: intent.matchedEventId,
            }
          : undefined;
    if (!locator) {
      setNotice('This result has no supported exact open target.');
      return;
    }
    const captured = scope;
    const controller = new AbortController();
    flight.current = controller;
    setOpening(true);
    setNotice(null);
    const resolve = async () => {
      if (!current(captured, controller)) return false;
      const { resolveSearchOpen } = await import(
        '@kontourai/station-sdk/client'
      );
      if (!current(captured, controller)) return false;
      const result = await resolveSearchOpen(captured.apiBase, locator, {
        requestScope: captured,
        signal: controller.signal,
      });
      if (!current(captured, controller) || result.state !== 'resolved')
        return false;
      const target = result.target;
      return locator.kind === 'task'
        ? target.kind === 'task' &&
            target.taskId === locator.taskId &&
            target.projectId === locator.projectId
        : target.kind === 'session-message' &&
            target.sessionId === locator.sessionId &&
            target.matchedEventId === locator.matchedEventId;
    };
    try {
      if (locator.kind === 'task') {
        const committed = await navigationStore.navigateWithPrecommit(
          `/tasks/${encodeURIComponent(locator.taskId)}`,
          {
            current: () => current(captured, controller),
            prepare: resolve,
            signal: controller.signal,
          },
        );
        if (committed) onClose();
        else if (current(captured, controller))
          setNotice('Task opening was cancelled or is no longer available.');
      } else if (await resolve()) {
        setSelected({ locator, scope: captured });
      } else if (current(captured, controller))
        setNotice(
          'This exact message is unavailable. No other Session was opened.',
        );
    } catch {
      if (current(captured, controller))
        setNotice('This result could not be opened.');
    } finally {
      if (flight.current === controller) {
        flight.current = null;
        setOpening(false);
      }
    }
  }
  const changeQuery = (value: string) => {
    invalidate();
    setNotice(null);
    setActive(0);
    onQueryChange(value);
  };
  if (selected?.scope.isCurrent())
    return (
      <ExactMessageInspector
        locator={selected.locator}
        scope={selected.scope}
        onClose={onClose}
        onBack={() => setSelected(null)}
      />
    );
  return (
    <Dialog
      title="Workspace search (this Station)"
      closeLabel="Close workspace search"
      onClose={onClose}
      size="lg"
      subtitle="Interim local search: Tasks and indexed messages. Other sources remain in command and legacy search."
      footer={
        <Button
          variant="secondary"
          onClick={() => {
            invalidate();
            onCommands();
          }}
        >
          Commands and legacy message search
        </Button>
      }
    >
      <input
        type="text"
        aria-label="Search this Station's work"
        placeholder="Search Tasks and messages…"
        value={query}
        role="combobox"
        aria-expanded="true"
        aria-controls="workspace-search-results"
        aria-activedescendant={
          rows.length
            ? `workspace-result-${Math.min(active, rows.length - 1)}`
            : undefined
        }
        onChange={(event) => changeQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            setActive((value) =>
              rows.length
                ? (value + (event.key === 'ArrowDown' ? 1 : rows.length - 1)) %
                  rows.length
                : 0,
            );
          }
          if (event.key === 'Enter' && !isComposingKeyEvent(event)) {
            event.preventDefault();
            const row = rows[Math.min(active, rows.length - 1)];
            if (row) void activate(row);
          }
        }}
      />
      {notice && <p role="status">{notice}</p>}
      {!scope?.isCurrent() ? (
        <ErrorState
          title="Workspace search unavailable"
          description="Authorize this Station before searching its work."
        />
      ) : search.isError ? (
        <ErrorState
          title="Workspace search unavailable"
          description="This Station may require an update or a repaired connection. Command search remains available."
        />
      ) : search.isFetching || opening ? (
        <SkeletonBlock
          count={1}
          label={opening ? 'Resolving exact result' : 'Searching this Station'}
        />
      ) : null}
      {ready &&
        search.data?.sources.map((source) => (
          <p role="status" key={source.providerId}>
            {sourceLabel(source.providerId)}: {source.state}
            {source.state === 'partial' ? ' — bounded result window' : ''}
          </p>
        ))}
      {ready &&
        !search.isFetching &&
        rows.length === 0 &&
        query.trim().length >= 2 &&
        !search.isError &&
        search.data?.state === 'complete' && (
          <Empty variant="compact" label="No matching work on this Station" />
        )}
      <div
        id="workspace-search-results"
        role="listbox"
        aria-label="Workspace search results"
      >
        {rows.map((row, index) => (
          <Button
            variant="secondary"
            tabIndex={-1}
            role="option"
            aria-selected={index === Math.min(active, rows.length - 1)}
            id={`workspace-result-${index}`}
            key={row.key}
            disabled={opening}
            onClick={() => void activate(row)}
          >
            {row.title} · {sourceLabel(row.providerId)}
            {row.scope?.projectId ? ` · Project ${row.scope.projectId}` : ''}
            {row.snippet && <span>{row.snippet}</span>}
            {row.currentness.state !== 'current' && (
              <span>{row.currentness.state}</span>
            )}
          </Button>
        ))}
      </div>
    </Dialog>
  );
}
