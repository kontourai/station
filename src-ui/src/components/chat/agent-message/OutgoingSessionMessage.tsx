import { useOrchestrationSessionsQuery } from '@kontourai/station-sdk';
import { memo, useMemo } from 'react';
import { sessionTitle } from '../../../utils/sessionDisplay';
import { OutboxGlyph } from '../../icons/Glyph';
import { AgentSessionLink } from './AgentSessionLink';
import {
  describeStationControlCall,
  type SendToSessionCall,
  STATION_CONTROL_TOOL_LABELS,
} from './station-control-calls';
import './agent-message.css';

const OUTCOME_LABEL: Record<SendToSessionCall['outcome'], string> = {
  started: 'Started a turn',
  steered: 'Steered the running turn',
  refused: 'Refused',
  unconfirmed: 'Not confirmed',
  sending: 'Sending',
};

const PREVIEW_CHARS = 200;

function preview(text: string | undefined): string | undefined {
  const flat = text?.replace(/\s+/gu, ' ').trim();
  if (!flat) return undefined;
  const points = Array.from(flat);
  return points.length <= PREVIEW_CHARS
    ? flat
    : `${points.slice(0, PREVIEW_CHARS - 1).join('')}…`;
}

/**
 * `send_to_session` as the sender's transcript shows it: "Sent to <Session>"
 * and what became of the message (started a turn, steered the running one,
 * refused), with a link to the Session it went to. Icon, words and the
 * outcome label carry the meaning; the outcome tint is only a hint.
 */
export const OutgoingSessionMessage = memo(function OutgoingSessionMessage({
  toolCall,
}: {
  toolCall: Parameters<typeof describeStationControlCall>[0];
}) {
  const call = useMemo(
    () => describeStationControlCall(toolCall),
    [toolCall],
  ) as SendToSessionCall;
  const { data: sessions } = useOrchestrationSessionsQuery();
  const target = call.targetSessionId
    ? sessions?.find((session) => session.threadId === call.targetSessionId)
    : undefined;
  const title = target
    ? sessionTitle(target)
    : call.targetSessionId
      ? `Session ${call.targetSessionId.slice(0, 8)}`
      : 'another Session';
  const labels = STATION_CONTROL_TOOL_LABELS.send_to_session;
  const lead = call.outcome === 'sending' ? labels.pending : labels.done;
  const outcome =
    call.outcome === 'refused' && call.reason
      ? `Refused: ${call.reason}`
      : OUTCOME_LABEL[call.outcome];
  const text = preview(call.text);
  return (
    // biome-ignore lint/a11y/useSemanticElements: a named group around one transcript row, not a set of form controls
    <div
      className={`agent-outgoing agent-outgoing--${call.outcome}`}
      role="group"
      aria-label={`${lead} ${title}: ${outcome}`}
    >
      <div className="agent-outgoing__line">
        <span className="agent-outgoing__icon" aria-hidden="true">
          <OutboxGlyph />
        </span>
        <span className="agent-outgoing__label">
          {lead}{' '}
          {call.targetSessionId ? (
            <AgentSessionLink
              sessionId={call.targetSessionId}
              className="agent-outgoing__link"
              label={`Open ${title}, the Session this message went to`}
            >
              {title}
            </AgentSessionLink>
          ) : (
            title
          )}
        </span>
        <span className="agent-outgoing__outcome">{outcome}</span>
      </div>
      {text ? <p className="agent-outgoing__text">{text}</p> : null}
    </div>
  );
});
