import type {
  BrowserConsoleEntryView,
  BrowserConsoleLevelView,
  BrowserConsoleView,
} from '@kontourai/station-contracts/workspace-browser-pane';
import {
  type UseQueryResult,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { IconButton } from '../../components/IconButton';
import { ArrowDownGlyph, DiscardGlyph } from '../../components/icons/Glyph';
import {
  type BrowserPaneApi,
  browserPaneKeys,
  describeBrowserFailure,
} from './browserPaneApi';

/**
 * The page's console (#90): what it logged, its uncaught exceptions and the
 * browser's own messages about it, read from the server's bounded capture.
 *
 * Read incrementally (`after` the newest entry already held): once a second
 * with the drawer open, every three seconds closed, so the toolbar can badge
 * new errors. The client keeps the same bound as the server; what the server
 * evicted is said as a count, never silently missing. Everything shown is
 * page text: rendered as text, never as markup.
 */

/** Matches the server's bound: the drawer never holds more than it keeps. */
const BROWSER_CONSOLE_CLIENT_LIMIT = 500;
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
 * Append a read to what is held. Entries of two browser generations never
 * mix: `seq` restarts with each one (a reopen), so a read from a different
 * generation replaces what is held.
 */
export function mergeConsoleRead(
  held: BrowserConsoleView | undefined,
  read: BrowserConsoleView,
): BrowserConsoleView {
  if (!held || held.generation !== read.generation) return read;
  const entries = [...held.entries, ...read.entries];
  return {
    ...read,
    entries: entries.slice(-BROWSER_CONSOLE_CLIENT_LIMIT),
  };
}

/** How often the console is read while its drawer is closed (for the badge). */
const CLOSED_POLL_MS = 3_000;

export interface BrowserConsoleState {
  read: UseQueryResult<BrowserConsoleView>;
  /** Errors captured since the drawer was last open (for the toolbar badge). */
  unreadErrors: number;
}

/**
 * The page's console as the pane holds it: read incrementally while the
 * session is live — every second with the drawer open, every three seconds
 * closed so the toolbar can badge new errors — and counted unread until the
 * drawer is opened.
 */
export function useBrowserConsole({
  apiBase,
  api,
  browserSessionId,
  live,
  open,
}: {
  apiBase: string;
  api: BrowserPaneApi;
  browserSessionId: string;
  live: boolean;
  open: boolean;
}): BrowserConsoleState {
  const queryClient = useQueryClient();
  const key = browserPaneKeys.console(apiBase, browserSessionId);
  const read = useQuery({
    queryKey: key,
    queryFn: async ({ signal }) => {
      const held = queryClient.getQueryData<BrowserConsoleView>(key);
      const next = await api.console(browserSessionId, held?.latestSeq, signal);
      if (held && next.generation !== held.generation) {
        // A new browser generation: its entries from the start, not the
        // tail after a cursor that belonged to the old one.
        return api.console(browserSessionId, undefined, signal);
      }
      return mergeConsoleRead(held, next);
    },
    enabled: live,
    retry: false,
    refetchInterval: live ? (open ? POLL_MS : CLOSED_POLL_MS) : false,
  });
  /** Entries of `generation` at or below `seq` have been seen. */
  const [seen, setSeen] = useState<{ generation: number; seq: number } | null>(
    null,
  );
  const latest = read.data?.latestSeq;
  const generation = read.data?.generation;
  useEffect(() => {
    if (latest === undefined || generation === undefined) return;
    setSeen((current) => {
      // The first read is the baseline: what the page logged before this
      // pane looked is not "new". While the drawer is open, all is seen.
      if (current === null || open) return { generation, seq: latest };
      // A reopened browser starts over: every error it logs is unseen.
      if (current.generation !== generation) return { generation, seq: 0 };
      return current;
    });
  }, [latest, generation, open]);
  const unreadErrors =
    seen === null || seen.generation !== generation
      ? 0
      : (read.data?.entries ?? []).filter(
          (entry) => entry.level === 'error' && entry.seq > seen.seq,
        ).length;
  return { read, unreadErrors };
}

export function BrowserConsoleDrawer({
  read: consoleRead,
  live,
}: {
  read: UseQueryResult<BrowserConsoleView>;
  live: boolean;
}) {
  const [level, setLevel] = useState<LevelFilter>('all');
  /** Entries at or below this seq were cleared from view (not from the page). */
  const [cleared, setCleared] = useState<{
    generation: number;
    seq: number;
  } | null>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const stuckToBottom = useRef(true);

  const data = consoleRead.data;
  const shown = (data?.entries ?? []).filter(
    (entry) =>
      (cleared === null ||
        cleared.generation !== data?.generation ||
        entry.seq > cleared.seq) &&
      (level === 'all' || entry.level === level),
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
        <span className="browser-pane__console-filter">
          <select
            className="choice-trigger browser-pane__console-select"
            aria-label="Show console level"
            title="Show console level"
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
        </span>
        <IconButton
          aria-label="Clear console"
          title="Clear console"
          disabled={!data || data.entries.length === 0}
          onClick={() =>
            data &&
            setCleared({ generation: data.generation, seq: data.latestSeq })
          }
        >
          <DiscardGlyph />
        </IconButton>
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
