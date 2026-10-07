import type { EngineId } from '@kontourai/station-contracts/agent-identity';
import type { ClientOriginSender } from '@kontourai/station-contracts/client-origin';
import { engineDisplayLabel } from '@kontourai/station-contracts/engine-display';
import type { ReactNode } from 'react';
import { InboxGlyph } from '../../icons/Glyph';
import { AgentSessionLink } from './AgentSessionLink';
import './agent-message.css';

/** What to call a sender's Session when it has no title. */
export function senderSessionLabel(sender: ClientOriginSender): string {
  return sender.title ?? `Session ${sender.sessionId.slice(0, 8)}`;
}

/** The sender's Agent for the header: its own name, else its engine's. */
export function senderAgentLabel(
  sender: ClientOriginSender,
): string | undefined {
  return (
    sender.agent ??
    (sender.engine
      ? (engineDisplayLabel(sender.engine as EngineId) ?? sender.engine)
      : undefined)
  );
}

/** The accessible name of the whole incoming message. */
export function incomingMessageLabel(sender: ClientOriginSender): string {
  if (sender.kind === 'unattributed')
    return 'Non-person input: sender not recorded';
  if (sender.kind === 'provider') return 'The engine replied on its own';
  const agent = senderAgentLabel(sender);
  return `Message from another agent: ${senderSessionLabel(sender)}${agent ? `, ${agent}` : ''}`;
}

/**
 * The header of a message another agent sent: an inbox icon, "From <Session>
 * · <agent>", and a link to the Session that sent it. The words and the icon
 * say who sent it; the accent colour only repeats it.
 */
export function IncomingAgentHeader({
  sender,
}: {
  sender: ClientOriginSender;
}) {
  if (sender.kind === 'unattributed')
    return (
      <p className="agent-cause">
        <InboxGlyph />
        Non-person input · sender not recorded
      </p>
    );
  if (sender.kind === 'provider')
    return (
      <p className="agent-cause">
        <InboxGlyph />
        The engine replied on its own
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
        <span className="agent-incoming__from">From</span>{' '}
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
  children,
}: {
  sender: ClientOriginSender;
  children?: ReactNode;
}) {
  const label =
    sender.kind === 'unattributed'
      ? 'Non-person input · sender not recorded'
      : sender.kind === 'provider'
        ? 'The engine replied on its own'
        : `From ${senderSessionLabel(sender)}${senderAgentLabel(sender) ? ` · ${senderAgentLabel(sender)}` : ''}`;
  return (
    <details className="agent-cause-disclosure">
      <summary className="agent-cause">
        <InboxGlyph />
        <span>{label}</span>
      </summary>
      <div className="agent-cause-disclosure__details">
        <IncomingAgentHeader sender={sender} />
        {sender.kind === 'provider' && (
          <p>No person or Session sent a request for this turn.</p>
        )}
        {children}
      </div>
    </details>
  );
}
