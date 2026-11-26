import type { EngineId } from '@kontourai/station-contracts/agent-identity';
import type { ClientOriginSender } from '@kontourai/station-contracts/client-origin';
import { engineDisplayLabel } from '@kontourai/station-contracts/engine-display';
import type { ReactNode } from 'react';
import { ArrowDownGlyph, InboxGlyph } from '../../icons/Glyph';
import { AgentSessionLink } from './AgentSessionLink';
import './agent-message.css';

/** What to call a sender's Session when it has no title. */
function senderSessionLabel(sender: ClientOriginSender): string {
  return sender.title ?? `Session ${sender.sessionId.slice(0, 8)}`;
}

/** The sender's Agent for the header: its own name, else its engine's. */
function senderAgentLabel(sender: ClientOriginSender): string | undefined {
  return (
    sender.agent ??
    (sender.engine
      ? (engineDisplayLabel(sender.engine as EngineId) ?? sender.engine)
      : undefined)
  );
}

const PULL_REQUEST_FEEDBACK_LABEL = 'Pull request feedback from Station';

/** Which Station flow sent a row nobody typed (`stationTurnOrigin`). */
export type IncomingStationOrigin = 'delegation' | 'automation';

/**
 * An unattributed row a known Station flow sent says which flow: a delegated
 * Task's brief is the delegating agent's instructions, not "sender unknown".
 */
function unattributedLabel(origin: IncomingStationOrigin | undefined): string {
  if (origin === 'delegation') return 'Task brief from the delegating agent';
  if (origin === 'automation') return 'Automation run started by Station';
  return 'Automated message · sender unknown';
}

/** The accessible name of the whole incoming message. */
export function incomingMessageLabel(
  sender: ClientOriginSender,
  origin?: IncomingStationOrigin,
): string {
  if (sender.kind === 'unattributed')
    return origin
      ? `${unattributedLabel(origin)}, not from you`
      : 'Automated message: sender unknown';
  if (sender.kind === 'provider') return 'The engine replied on its own';
  if (sender.kind === 'coordinator') return 'Update from Station';
  if (sender.kind === 'pull-request-feedback')
    return `${PULL_REQUEST_FEEDBACK_LABEL}, not from you`;
  const agent = senderAgentLabel(sender);
  const source = agent ?? senderSessionLabel(sender);
  if (sender.kind === 'delegation-result') return `Task result from ${source}`;
  return `Message from another agent: ${senderSessionLabel(sender)}${agent ? `, ${agent}` : ''}`;
}

/**
 * The header of a message another agent sent: an inbox icon, "From <Session>
 * · <agent>", and a link to the Session that sent it. The words and the icon
 * say who sent it; the accent colour only repeats it.
 */
export function IncomingAgentHeader({
  sender,
  origin,
}: {
  sender: ClientOriginSender;
  origin?: IncomingStationOrigin;
}) {
  if (sender.kind === 'unattributed')
    return (
      <p
        className="agent-cause"
        {...(origin ? { 'data-station-origin': origin } : {})}
      >
        <InboxGlyph />
        {unattributedLabel(origin)}
      </p>
    );
  if (sender.kind === 'provider')
    return (
      <p className="agent-cause">
        <InboxGlyph />
        The engine replied on its own
      </p>
    );
  if (sender.kind === 'coordinator')
    return (
      <p className="agent-cause">
        <InboxGlyph />
        Update from Station
      </p>
    );
  // Station composed it from the pull request's checks and reviews: not a
  // link, since no Session sent it.
  if (sender.kind === 'pull-request-feedback')
    return (
      <p className="agent-cause">
        <InboxGlyph />
        {PULL_REQUEST_FEEDBACK_LABEL}
      </p>
    );
  const session = senderSessionLabel(sender);
  const agent = senderAgentLabel(sender);
  return (
    <div className="agent-incoming__header">
      <span className="agent-incoming__icon" aria-hidden="true">
        <InboxGlyph />
      </span>
      <AgentSessionLink
        sessionId={sender.sessionId}
        requestKey={sender.requestKey}
        direction="sent"
        className="agent-incoming__link"
        label={`Open ${session}, the Session that sent this message`}
      >
        <span className="agent-incoming__from">
          {sender.kind === 'delegation-result' ? 'Task result from' : 'From'}
        </span>{' '}
        <span className="agent-incoming__session">{session}</span>
        {agent ? (
          <>
            {' '}
            <span aria-hidden="true">·</span>{' '}
            <span className="agent-incoming__agent">{agent}</span>
          </>
        ) : null}
      </AgentSessionLink>
      <span className="sr-only">
        This is a message from another agent, not from you.
      </span>
    </div>
  );
}

/** The phone cause stays one row until the reader asks for its details. */
export function IncomingAgentCause({
  sender,
  origin,
  children,
}: {
  sender: ClientOriginSender;
  origin?: IncomingStationOrigin;
  children?: ReactNode;
}) {
  const label =
    sender.kind === 'unattributed'
      ? unattributedLabel(origin)
      : sender.kind === 'provider'
        ? 'The engine replied on its own'
        : sender.kind === 'coordinator'
          ? 'Update from Station'
          : sender.kind === 'pull-request-feedback'
            ? PULL_REQUEST_FEEDBACK_LABEL
            : sender.kind === 'delegation-result'
              ? incomingMessageLabel(sender)
              : `From ${senderSessionLabel(sender)}${senderAgentLabel(sender) ? ` · ${senderAgentLabel(sender)}` : ''}`;
  return (
    <details
      className="agent-cause-disclosure"
      open={sender.kind === 'delegation-result' || undefined}
    >
      <summary className="agent-cause">
        <InboxGlyph />
        <span>{label}</span>
        <ArrowDownGlyph className="agent-cause__caret" />
      </summary>
      <div className="agent-cause-disclosure__details agent-incoming">
        <IncomingAgentHeader sender={sender} origin={origin} />
        {sender.kind === 'provider' && (
          <p>
            {senderAgentLabel(sender) ?? 'The engine'} started this turn without
            a person or Session sending a request.
          </p>
        )}
        {children}
      </div>
    </details>
  );
}
