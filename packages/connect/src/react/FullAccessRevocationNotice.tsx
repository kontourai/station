import type { FullAccessRevocationReport } from '@kontourai/station-contracts/environment-security';
import { sanitizeUntrustedDisplayText } from '@kontourai/station-contracts/orchestration';
import { activityDeepLink } from '@kontourai/station-contracts/surface-deep-link';
import { useEffect, useRef, useState } from 'react';

/**
 * #1796 (G3): what taking a device's full access away did, as the scope and
 * revoke routes answer it. Rendered as plain text: conversation ids come
 * from the Station, and nothing here is Markdown.
 */
export type FullAccessRevocationOutcome =
  | { kind: 'report'; deviceName: string; report: FullAccessRevocationReport }
  | { kind: 'failed'; deviceName: string };

const RESET_WAS: Record<string, string> = {
  never: 'its full-access decision',
  'default-reaching-full-access':
    'its Default pick, which resolved to full access',
  'host-start': 'a session it started at full access',
  'auto-on-host': 'its Auto decision on a session its grant had unconfined',
};
const UNCONFINED_UNTIL: Record<string, string> = {
  'next-turn':
    'its engine is running: a turn already running finishes unconfined, and its next turn runs confined',
  // Sent by Stations from before #2898.
  'engine-restart':
    'its engine is running with no decision to re-apply, so it keeps its starting posture until it restarts',
  'grant-not-checked': 'this Station does not re-check the grant at each turn',
};
const STILL_REASON: Record<string, string> = {
  'operator-decision': 'the operator’s own decision',
  'another-device-decision': 'another device’s decision',
  'unattributed-decision': 'a decision with no recorded author',
  'agent-default': 'the Agent’s default approval mode',
  'station-default': 'the Station’s default approval mode',
};

const LIST_STYLE = { listStyle: 'disc', paddingLeft: '20px', margin: '4px 0' };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

type Report = FullAccessRevocationReport;
const RESET_KINDS: readonly Report['reset'][number]['was'][] = [
  'never',
  'default-reaching-full-access',
  'host-start',
  'auto-on-host',
];
const UNTIL_KINDS: readonly Report['stillUnconfined'][number]['until'][] = [
  'next-turn',
  'engine-restart',
  'grant-not-checked',
];
const STILL_KINDS: readonly Report['stillFullAccess'][number]['reason'][] = [
  'operator-decision',
  'another-device-decision',
  'unattributed-decision',
  'agent-default',
  'station-default',
];
const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 && value.length <= 256
    ? value
    : undefined;
function oneOf<T extends string>(
  values: readonly T[],
  value: unknown,
): T | undefined {
  return values.find((candidate) => candidate === value);
}

/** An entry's title and session, when it carries valid ones. */
const named = (
  entry: Record<string, unknown>,
): { title?: string; sessionId?: string } => {
  // A title comes from session content: strip bidi and zero-width
  // characters so it cannot pass itself off as another conversation.
  const rawTitle = text(entry.title);
  const title = rawTitle
    ? sanitizeUntrustedDisplayText(rawTitle, 256) || undefined
    : undefined;
  const sessionId = text(entry.sessionId);
  return {
    ...(title ? { title } : {}),
    ...(sessionId ? { sessionId } : {}),
  };
};

/**
 * The report, read field by field from the Station's answer: entries that
 * do not match the contract are dropped, not cast through.
 */
function parseReport(value: unknown): Report | null {
  if (!isRecord(value)) return null;
  const cause =
    value.cause === 'device-revoked' || value.cause === 'scope-removed'
      ? value.cause
      : null;
  if (
    !cause ||
    !Array.isArray(value.reset) ||
    !Array.isArray(value.stillFullAccess)
  )
    return null;
  const reset: Array<Report['reset'][number]> = [];
  for (const entry of value.reset) {
    if (!isRecord(entry)) continue;
    const conversationId = text(entry.conversationId);
    const was = oneOf(RESET_KINDS, entry.was);
    if (conversationId && was)
      reset.push({ conversationId, ...named(entry), was });
  }
  const stillFullAccess: Array<Report['stillFullAccess'][number]> = [];
  for (const entry of value.stillFullAccess) {
    if (!isRecord(entry)) continue;
    const conversationId = text(entry.conversationId);
    const reason = oneOf(STILL_KINDS, entry.reason);
    if (conversationId && reason)
      stillFullAccess.push({ conversationId, ...named(entry), reason });
  }
  const reconfined: Array<Report['reconfined'][number]> = [];
  for (const entry of Array.isArray(value.reconfined) ? value.reconfined : []) {
    if (!isRecord(entry)) continue;
    const conversationId = text(entry.conversationId);
    if (conversationId) reconfined.push({ conversationId, ...named(entry) });
  }
  const stillUnconfined: Array<Report['stillUnconfined'][number]> = [];
  for (const entry of Array.isArray(value.stillUnconfined)
    ? value.stillUnconfined
    : []) {
    if (!isRecord(entry)) continue;
    const conversationId = text(entry.conversationId);
    const until = oneOf(UNTIL_KINDS, entry.until);
    if (conversationId && until)
      stillUnconfined.push({ conversationId, ...named(entry), until });
  }
  const sessions: Array<Report['unattributedHostStarts']['sessions'][number]> =
    [];
  const unattributed = isRecord(value.unattributedHostStarts)
    ? value.unattributedHostStarts
    : undefined;
  for (const entry of Array.isArray(unattributed?.sessions)
    ? unattributed.sessions
    : []) {
    if (!isRecord(entry)) continue;
    const conversationId = text(entry.conversationId);
    const startedAt = text(entry.startedAt);
    if (conversationId && startedAt)
      sessions.push({ conversationId, ...named(entry), startedAt });
  }
  const total =
    typeof unattributed?.total === 'number' &&
    Number.isInteger(unattributed.total) &&
    unattributed.total >= sessions.length
      ? unattributed.total
      : sessions.length;
  return {
    cause,
    reset,
    stillFullAccess,
    reconfined,
    stillUnconfined,
    unattributedHostStarts: { sessions, total },
  };
}

/** The revocation part of a scope-change or revoke answer, if it has one. */
export function readFullAccessRevocation(
  body: unknown,
  deviceName: string,
): FullAccessRevocationOutcome | null {
  if (!isRecord(body)) return null;
  if (body.fullAccessRevocationError !== undefined)
    return { kind: 'failed', deviceName };
  const report = parseReport(body.fullAccessRevocation);
  if (!report) return null;
  // Revoking a device that had put nothing at full access says nothing
  // here: the revoke itself is the whole story.
  if (
    report.cause === 'device-revoked' &&
    report.reset.length === 0 &&
    report.stillFullAccess.length === 0 &&
    report.reconfined.length === 0 &&
    report.stillUnconfined.length === 0 &&
    report.unattributedHostStarts.sessions.length === 0
  )
    return null;
  return { kind: 'report', deviceName, report };
}

/**
 * A conversation as the notice lists it: its title (plain text) and id, and
 * where it names a session, a link that opens it in Activity.
 */
function ConversationRef({
  entry,
}: {
  entry: { conversationId: string; title?: string; sessionId?: string };
}) {
  const name = entry.title ?? 'Untitled conversation';
  return (
    <>
      {entry.sessionId ? (
        <a href={activityDeepLink({ sessionId: entry.sessionId })}>{name}</a>
      ) : (
        <span>{name}</span>
      )}{' '}
      <code style={{ opacity: 0.7 }}>{entry.conversationId}</code>
    </>
  );
}

/** What "Stop now" did to one running session. */
type StopState = 'stopping' | 'stopped' | 'failed';

export function FullAccessRevocationNotice({
  outcome,
  onDismiss,
  onStopSession,
}: {
  outcome: FullAccessRevocationOutcome;
  onDismiss: () => void;
  /**
   * #2898: stops a session the report lists as still running unconfined, at
   * once rather than after its running turn; resolves to whether the
   * Station stopped it. Without it, no "Stop now" is offered.
   */
  onStopSession?: (sessionId: string) => Promise<boolean>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [stops, setStops] = useState<ReadonlyMap<string, StopState>>(
    () => new Map(),
  );
  const stop = (sessionId: string) => {
    if (!onStopSession || stops.get(sessionId) === 'stopping') return;
    const mark = (state: StopState) =>
      setStops((current) => new Map(current).set(sessionId, state));
    mark('stopping');
    onStopSession(sessionId).then(
      (stopped) => mark(stopped ? 'stopped' : 'failed'),
      () => mark('failed'),
    );
  };
  // The notice sits below the device list; bring it into view.
  useEffect(() => {
    ref.current?.scrollIntoView?.({ block: 'nearest' });
  }, []);
  if (outcome.kind === 'failed')
    return (
      <div
        ref={ref}
        role="alert"
        className="station-connect-row__meta--warning"
      >
        Full access was removed from “{outcome.deviceName}”, but Station could
        not reset the conversations it had put at full access. They keep their
        current approval mode until someone changes it.
      </div>
    );
  const { reset, stillFullAccess, reconfined, stillUnconfined } =
    outcome.report;
  const unattributed = outcome.report.unattributedHostStarts;
  const nothing =
    reset.length === 0 &&
    stillFullAccess.length === 0 &&
    reconfined.length === 0 &&
    stillUnconfined.length === 0 &&
    unattributed.sessions.length === 0;
  return (
    <div
      ref={ref}
      role="status"
      className="station-connect-panel__intro"
      data-testid="full-access-revocation"
    >
      <strong>
        {outcome.report.cause === 'device-revoked'
          ? `“${outcome.deviceName}” was revoked, and so was the full access it had given.`
          : `Full access removed from “${outcome.deviceName}”.`}
      </strong>
      {nothing ? (
        <div>No conversation was at full access through this device.</div>
      ) : null}
      {reset.length > 0 ? (
        <>
          <div>
            Reset to Ask. A turn already running finishes first; the next one
            asks:
          </div>
          <ul style={LIST_STYLE}>
            {reset.map((entry) => (
              <li key={`reset-${entry.conversationId}`}>
                <ConversationRef entry={entry} /> (was{' '}
                {RESET_WAS[entry.was] ?? entry.was})
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {stillFullAccess.length > 0 ? (
        <>
          <div>Still at full access, not changed:</div>
          <ul style={LIST_STYLE}>
            {stillFullAccess.map((entry) => (
              <li key={`still-${entry.conversationId}`}>
                <ConversationRef entry={entry} />, because of{' '}
                {STILL_REASON[entry.reason] ?? entry.reason}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {reconfined.length > 0 ? (
        <>
          <div>
            Re-confined from its next turn (runs inside the workspace again):
          </div>
          <ul style={LIST_STYLE}>
            {reconfined.map((entry) => (
              <li key={`reconfined-${entry.conversationId}`}>
                <ConversationRef entry={entry} />
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {stillUnconfined.length > 0 ? (
        <>
          <div>Still unconfined:</div>
          <ul style={LIST_STYLE}>
            {stillUnconfined.map((entry) => {
              const sessionId =
                entry.until === 'next-turn' ? entry.sessionId : undefined;
              const state = sessionId ? stops.get(sessionId) : undefined;
              return (
                <li
                  key={`unconfined-${entry.conversationId}-${entry.sessionId ?? ''}`}
                >
                  <ConversationRef entry={entry} />
                  {state === 'stopped' ? (
                    ', stopped: its next start runs confined.'
                  ) : (
                    <>
                      , because {UNCONFINED_UNTIL[entry.until] ?? entry.until}
                    </>
                  )}
                  {sessionId && onStopSession ? (
                    state === 'stopped' ? null : (
                      <>
                        {' '}
                        <button
                          type="button"
                          onClick={() => stop(sessionId)}
                          disabled={state === 'stopping'}
                          aria-label={`Stop ${entry.title ?? entry.conversationId} now`}
                          className="station-connect-btn station-connect-btn--secondary station-connect-btn--inline"
                        >
                          {state === 'stopping' ? 'Stopping…' : 'Stop now'}
                        </button>
                        {state === 'failed' ? (
                          <span role="alert">
                            {' '}
                            Station could not stop it. Open it and stop it
                            there.
                          </span>
                        ) : null}
                      </>
                    )
                  ) : null}
                </li>
              );
            })}
          </ul>
        </>
      ) : null}
      {unattributed.sessions.length > 0 ? (
        <>
          <div>
            Unattributed host start: still at full access, not changed. These
            started before Station recorded who granted full access, so they may
            be this device’s:
          </div>
          <ul style={LIST_STYLE}>
            {unattributed.sessions.map((entry) => (
              <li key={`unattributed-${entry.conversationId}`}>
                <ConversationRef entry={entry} />, started {entry.startedAt}
              </li>
            ))}
          </ul>
          {unattributed.total > unattributed.sessions.length ? (
            <div>
              …and {unattributed.total - unattributed.sessions.length} more (
              {unattributed.total} in all).
            </div>
          ) : null}
        </>
      ) : null}
      <button
        type="button"
        onClick={onDismiss}
        className="station-connect-btn station-connect-btn--secondary station-connect-btn--inline"
      >
        Dismiss
      </button>
    </div>
  );
}
