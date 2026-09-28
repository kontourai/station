import type { FullAccessRevocationReport } from '@kontourai/station-contracts/environment-security';
import { useEffect, useRef } from 'react';

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

/** The revocation part of a scope-change or revoke answer, if it has one. */
export function readFullAccessRevocation(
  body: unknown,
  deviceName: string,
): FullAccessRevocationOutcome | null {
  if (!isRecord(body)) return null;
  if (body.fullAccessRevocationError !== undefined)
    return { kind: 'failed', deviceName };
  const report = body.fullAccessRevocation;
  if (
    !isRecord(report) ||
    !Array.isArray(report.reset) ||
    !Array.isArray(report.stillFullAccess)
  )
    return null;
  const unattributed = isRecord(report.unattributedHostStarts)
    ? report.unattributedHostStarts.sessions
    : undefined;
  // Revoking a device that had put nothing at full access says nothing
  // here: the revoke itself is the whole story.
  if (
    report.cause === 'device-revoked' &&
    report.reset.length === 0 &&
    report.stillFullAccess.length === 0 &&
    (!Array.isArray(unattributed) || unattributed.length === 0)
  )
    return null;
  return {
    kind: 'report',
    deviceName,
    report: report as unknown as FullAccessRevocationReport,
  };
}

export function FullAccessRevocationNotice({
  outcome,
  onDismiss,
}: {
  outcome: FullAccessRevocationOutcome;
  onDismiss: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
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
  const { reset, stillFullAccess } = outcome.report;
  const unattributed = outcome.report.unattributedHostStarts ?? {
    sessions: [],
    total: 0,
  };
  const nothing =
    reset.length === 0 &&
    stillFullAccess.length === 0 &&
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
                <code>{entry.conversationId}</code> (was{' '}
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
                <code>{entry.conversationId}</code>, because of{' '}
                {STILL_REASON[entry.reason] ?? entry.reason}
              </li>
            ))}
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
                <code>{entry.conversationId}</code>, started {entry.startedAt}
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
