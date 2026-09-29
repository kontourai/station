import type {
  BrowserConsoleEntryView,
  BrowserConsoleLevelView,
  BrowserConsoleView,
} from '@kontourai/station-contracts/workspace-browser-pane';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Button } from '../../components/Button';
import { ArrowDownGlyph } from '../../components/icons/Glyph';
import {
  type BrowserPaneApi,
  browserPaneKeys,
  describeBrowserFailure,
} from './browserPaneApi';

/**
 * The page's console (#90): what it logged, its uncaught exceptions and the
 * browser's own messages about it, read from the server's bounded capture.
 *
 * Polled only while the drawer is open, and incrementally (`after` the
 * newest entry already held), so an open drawer costs one small read a
 * second. The client keeps the same bound as the server; what the server
 * evicted is said as a count, never silently missing. Everything shown is
 * page text: rendered as text, never as markup.
 */

/** Matches the server's bound: the drawer never holds more than it keeps. */
export const BROWSER_CONSOLE_CLIENT_LIMIT = 500;
const POLL_MS = 1_000;

type LevelFilter = 'all' | BrowserConsoleLevelView;

const LEVEL_OPTIONS: ReadonlyArray<{ value: LevelFilter; label: string }> = [
  { value: 'all', label: 'All levels' },
  { value: 'error', label: 'Errors' },
  { value: 'warning', label: 'Warnings' },
  { value: 'info', label: 'Info' },
  { value: 'debug', label: 'Debug' },
];

const LEVEL_TEXT: Record<BrowserConsoleLevelView, string> = {
  error: 'Error',
  warning: 'Warning',
  info: 'Info',
  debug: 'Debug',
};

function location(entry: BrowserConsoleEntryView): string | null {
  if (!entry.url) return null;
  return entry.line === undefined ? entry.url : `${entry.url}:${entry.line}`;
}

/**
 * Append a read to what is held. A read whose newest entry is OLDER than the
 * cursor means the browser restarted (a new generation starts at 1): the
 * held entries belong to a page that is gone, so start over from the read.
 */
export function mergeConsoleRead(
  held: BrowserConsoleView | undefined,
  read: BrowserConsoleView,
  after: number | undefined,
): BrowserConsoleView {
  if (!held || after === undefined || read.latestSeq < after) return read;
  const entries = [...held.entries, ...read.entries];
  return {
    ...read,
    entries: entries.slice(-BROWSER_CONSOLE_CLIENT_LIMIT),
  };
}

export function BrowserConsoleDrawer({
  apiBase,
  api,
  browserSessionId,
  live,
}: {
  apiBase: string;
  api: BrowserPaneApi;
  browserSessionId: string;
  live: boolean;
}) {
  const queryClient = useQueryClient();
  const key = browserPaneKeys.console(apiBase, browserSessionId);
  const consoleRead = useQuery({
    queryKey: key,
    queryFn: async ({ signal }) => {
      const held = queryClient.getQueryData<BrowserConsoleView>(key);
      const after = held?.latestSeq;
      const read = await api.console(browserSessionId, after, signal);
      if (after !== undefined && read.latestSeq < after) {
        // A new browser generation: read it whole.
        return api.console(browserSessionId, undefined, signal);
      }
      return mergeConsoleRead(held, read, after);
    },
    enabled: live,
    retry: false,
    refetchInterval: live ? POLL_MS : false,
  });
  const [level, setLevel] = useState<LevelFilter>('all');
  /** Entries at or below this seq were cleared from view (not from the page). */
  const [clearedThrough, setClearedThrough] = useState(0);
  const listRef = useRef<HTMLOListElement>(null);
  const stuckToBottom = useRef(true);

  const data = consoleRead.data;
  const shown = (data?.entries ?? []).filter(
    (entry) =>
      entry.seq > clearedThrough && (level === 'all' || entry.level === level),
  );
  const newest = shown.at(-1)?.seq;
  // Follow new lines only while the reader is already at the bottom.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `newest` is the change key for "a line arrived".
  useEffect(() => {
    const list = listRef.current;
    if (list && stuckToBottom.current) list.scrollTop = list.scrollHeight;
  }, [newest]);

  let body: ReactNode;
  if (!live) {
    body = (
      <p className="browser-pane__hint">
        The console is read from a running page. Reopen the session to see it.
      </p>
    );
  } else if (consoleRead.isPending) {
    body = <p className="browser-pane__hint">Reading the console…</p>;
  } else if (consoleRead.isError) {
    body = (
      <p className="browser-pane__notice" role="alert">
        {describeBrowserFailure(consoleRead.error)}
      </p>
    );
  } else if (data && !data.capturing) {
    body = (
      <p className="browser-pane__hint">
        This Station does not capture the console for this session.
      </p>
    );
  } else if (shown.length === 0) {
    body = (
      <p className="browser-pane__hint">
        {level === 'all'
          ? 'Nothing logged yet.'
          : `No ${LEVEL_OPTIONS.find((o) => o.value === level)?.label.toLowerCase()} yet.`}
      </p>
    );
  } else {
    body = (
      <ol
        ref={listRef}
        className="browser-pane__console-list"
        aria-label="Console messages"
        onScroll={(event) => {
          const list = event.currentTarget;
          stuckToBottom.current =
            list.scrollHeight - list.scrollTop - list.clientHeight < 24;
        }}
      >
        {shown.map((entry) => {
          const where = location(entry);
          return (
            <li
              key={entry.seq}
              className="browser-pane__console-entry"
              data-level={entry.level}
            >
              <span className="browser-pane__console-level">
                {entry.source === 'exception'
                  ? 'Uncaught'
                  : LEVEL_TEXT[entry.level]}
              </span>
              <span className="browser-pane__console-text">
                {entry.text}
                {entry.truncated ? ' … (cut)' : ''}
              </span>
              {where ? (
                <span className="browser-pane__console-where">{where}</span>
              ) : null}
            </li>
          );
        })}
      </ol>
    );
  }

  return (
    <section
      className="browser-pane__panel browser-pane__console"
      aria-label="Console"
    >
      <div className="browser-pane__console-bar">
        <h3>Console</h3>
        <label className="browser-pane__viewport">
          <span className="sr-only">Level</span>
          <select
            className="choice-trigger browser-pane__select"
            aria-label="Show console level"
            value={level}
            onChange={(event) => setLevel(event.target.value as LevelFilter)}
          >
            {LEVEL_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <ArrowDownGlyph className="choice-caret browser-pane__caret" />
        </label>
        <Button
          size="sm"
          className="browser-pane__control"
          disabled={!data || data.entries.length === 0}
          onClick={() => setClearedThrough(data?.latestSeq ?? 0)}
        >
          Clear
        </Button>
      </div>
      {data && data.dropped > 0 ? (
        <p className="browser-pane__hint" role="status">
          {`${data.dropped} older ${data.dropped === 1 ? 'message was' : 'messages were'} dropped: the console keeps the latest ${BROWSER_CONSOLE_CLIENT_LIMIT}.`}
        </p>
      ) : null}
      {body}
    </section>
  );
}
