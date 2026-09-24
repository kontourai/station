import type {
  BrowserSessionActionView,
  BrowserSessionActorView,
  BrowserSessionView,
} from '@kontourai/station-contracts/workspace-browser-pane';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '../../components/Button';
import {
  Empty,
  ErrorState,
  SkeletonBlock,
  SkeletonList,
} from '../../components/state';
import {
  type BrowserPaneApi,
  browserPaneKeys,
  describeBrowserFailure,
} from './browserPaneApi';

const STATE_TEXT: Record<BrowserSessionView['state'], string> = {
  opening: 'Opening',
  live: 'Live',
  closed: 'Closed',
  'needs-reopen': 'Stopped',
};

/** Entries the PAGE caused; every other `system` entry is Station's own. */
const PAGE_ORIGINATED = new Set([
  'dialog-handled',
  'page-navigated',
  'link-followed',
]);

function describeBrowserActor(
  actor: BrowserSessionActorView,
  kind?: string,
): string {
  switch (actor.kind) {
    case 'operator':
      return 'the Station operator';
    case 'project-admin':
      return 'a Project admin';
    case 'agent':
      return 'an agent';
    case 'system':
      return kind !== undefined && PAGE_ORIGINATED.has(kind)
        ? 'the page'
        : 'Station';
  }
}

const ACTION_TEXT: Record<string, string> = {
  created: 'opened',
  navigated: 'navigated to',
  'navigation-refused': 'was refused an address',
  closed: 'closed the session',
  reopened: 'reopened the session',
  'host-exited': 'stopped the session: the browser exited',
  'server-stopped': 'stopped the session when Station stopped',
  'server-restarted': 'stopped the session when Station restarted',
  'history-navigated': 'moved through history to',
  reloaded: 'reloaded',
  'viewport-changed': 'changed the viewport',
  'page-navigated': 'navigated on its own to',
  'dialog-handled': 'showed a dialog Station answered',
  'link-followed': 'navigated to',
  'navigation-blocked': 'tried to open',
  // An agent's browser tool actions (#90 #122/#123).
  clicked: 'clicked',
  typed: 'typed',
  'key-pressed': 'pressed',
  scrolled: 'scrolled',
  inspected: 'read the page',
  'script-evaluated': 'ran JavaScript in the page',
  'thread-adopted': 'took over this session for its conversation',
  // Refused tool calls carry their reason code as the detail.
  'agent-refused': 'was refused a browser action',
  'control-taken': 'took control',
  'control-released': 'stopped controlling the browser',
};

/**
 * Why an agent was refused, in words (every code the server records as
 * `agent-refused`, browser-automation.ts `RECORDED_REFUSALS`). A code this
 * list does not know yet is shown as the code, never dropped.
 */
const REFUSAL_TEXT: Record<string, string> = {
  'human-controlling': 'a person was in control',
  'held-by-other': 'another agent was driving',
  interrupted: 'a person took over mid-action',
  'not-permitted': 'not allowed for agents in this Project',
  'url-not-allowed': 'that address is not allowed',
  'browser-refused': 'the browser refused it',
  obscured: 'something covered the target',
};

export function describeRefusal(code: string): string {
  return REFUSAL_TEXT[code] ?? `refused: ${code}`;
}

export function describeBrowserAction(
  action: BrowserSessionActionView,
): string {
  const who = describeBrowserActor(action.actor, action.kind);
  const verb =
    action.kind === 'link-followed' && action.cause
      ? `navigated after ${describeBrowserActor(action.cause)}'s click to`
      : (ACTION_TEXT[action.kind] ?? action.kind);
  const target = action.url ? ` ${action.url}` : '';
  const detail = !action.detail
    ? ''
    : action.kind === 'agent-refused'
      ? ` (${describeRefusal(action.detail)})`
      : ` (${action.detail})`;
  const times = action.count && action.count > 1 ? ` ×${action.count}` : '';
  return `${who} ${verb}${target}${detail}${times}`;
}

function ActionList({
  entries,
  label,
}: {
  entries: BrowserSessionActionView[];
  label: string;
}) {
  return (
    <ol className="browser-pane__history" aria-label={label}>
      {entries.map((action) => (
        <li key={action.seq}>
          <time dateTime={action.at}>
            {new Date(action.at).toLocaleTimeString()}
          </time>{' '}
          {describeBrowserAction(action)}
        </li>
      ))}
    </ol>
  );
}

/** The whole retained history of one session, fetched only when asked. */
function FullHistory({
  apiBase,
  api,
  session,
}: {
  apiBase: string;
  api: BrowserPaneApi;
  session: BrowserSessionView;
}) {
  const full = useQuery({
    queryKey: browserPaneKeys.fullHistory(apiBase, session.browserSessionId),
    queryFn: ({ signal }) => api.session(session.browserSessionId, signal),
  });
  if (full.isPending)
    return <SkeletonBlock count={1} label="Loading the full history" />;
  if (full.isError)
    return (
      <ErrorState
        title="The full history could not be read"
        description={describeBrowserFailure(full.error)}
      />
    );
  // `total` counts every action, including repeats folded into one entry,
  // so what is really no longer kept is total minus what the kept entries
  // stand for.
  const entries = full.data.history.entries;
  const represented = entries.reduce(
    (sum, entry) => sum + (entry.count ?? 1),
    0,
  );
  const dropped = full.data.history.total - represented;
  const folded = represented - entries.length;
  return (
    <>
      <ActionList entries={entries} label={`Full history of ${session.url}`} />
      {folded > 0 ? (
        <p className="browser-pane__hint">
          {folded} repeats are folded into the entries above.
        </p>
      ) : null}
      {dropped > 0 ? (
        <p className="browser-pane__hint">
          {dropped} older entries are no longer kept.
        </p>
      ) : null}
    </>
  );
}

/**
 * Every session this caller may see in the Project, agent-driven ones
 * included (D6: nothing is hidden), each with who drove it last (derived by
 * the server over its whole history), its URL and its recent actions, and
 * the full history on demand. Opening one attaches this pane to it.
 */
export function BrowserSessionList({
  apiBase,
  api,
  projectSlug,
  currentSessionId,
  onOpen,
}: {
  apiBase: string;
  api: BrowserPaneApi;
  projectSlug: string;
  currentSessionId?: string;
  onOpen: (browserSessionId: string) => void;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const sessions = useQuery({
    queryKey: browserPaneKeys.sessions(apiBase, projectSlug),
    queryFn: ({ signal }) => api.sessions(projectSlug, signal),
    refetchInterval: 5_000,
  });
  return (
    <section
      className="browser-pane__panel"
      aria-labelledby="browser-sessions-heading"
    >
      <h3 id="browser-sessions-heading">Browser sessions in this Project</h3>
      {sessions.isPending ? (
        <SkeletonList count={2} label="Loading browser sessions" />
      ) : sessions.isError ? (
        <ErrorState
          title="Browser sessions could not be listed"
          description={describeBrowserFailure(sessions.error)}
        />
      ) : sessions.data.length === 0 ? (
        <Empty
          variant="compact"
          label="Nothing open yet"
          description="Every browser session in this Project appears here, including ones an agent opened."
        />
      ) : (
        <ul className="browser-pane__list" aria-label="Browser sessions">
          {sessions.data.map((session) => {
            const current = session.browserSessionId === currentSessionId;
            const showFull = expanded === session.browserSessionId;
            const driver = session.activity?.lastDriver;
            // Entries the server still keeps: the ones in this summary plus
            // the ones it left out of it (not `total`, which also counts
            // folded repeats and evicted actions).
            const kept =
              session.history.entries.length +
              (session.history.omittedFromSummary ?? 0);
            return (
              <li
                key={session.browserSessionId}
                className="browser-pane__session"
                data-testid="browser-session-item"
              >
                <p className="browser-pane__session-url">
                  {session.url}
                  <span className="browser-pane__badge">
                    {STATE_TEXT[session.state]}
                  </span>
                  {session.activity?.agentDriven ? (
                    <span className="browser-pane__badge">Agent</span>
                  ) : null}
                </p>
                <p className="browser-pane__hint">
                  {driver
                    ? `Last driven by ${describeBrowserActor(driver)}.`
                    : 'Nobody has driven it yet.'}
                </p>
                {showFull ? (
                  <FullHistory apiBase={apiBase} api={api} session={session} />
                ) : session.history.entries.length > 0 ? (
                  <ActionList
                    entries={session.history.entries}
                    label={`Recent actions in ${session.url}`}
                  />
                ) : null}
                {kept > session.history.entries.length ? (
                  <Button
                    size="sm"
                    className="browser-pane__control"
                    aria-expanded={showFull}
                    onClick={() =>
                      setExpanded(showFull ? null : session.browserSessionId)
                    }
                  >
                    {showFull
                      ? 'Show recent actions only'
                      : `Show all ${kept} kept entries`}
                  </Button>
                ) : null}
                {current ? (
                  <p className="browser-pane__hint">Showing in this pane.</p>
                ) : (
                  <Button
                    size="sm"
                    className="browser-pane__control"
                    onClick={() => onOpen(session.browserSessionId)}
                  >
                    {`Open ${session.url}`}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
