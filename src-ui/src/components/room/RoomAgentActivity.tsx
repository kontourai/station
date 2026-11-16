import { Button } from '../Button';
import { roomShortTime } from './groupRows';
import { RoomAvatar } from './RoomAvatar';
import './RoomAgentActivity.css';

/** Where one Agent request is, as its record says (#4800). */
export type RoomAgentPhase = 'starting' | 'working' | 'failed' | 'stopped';

/**
 * A live row in the conversation for one Agent request: the Agent, its
 * current step, and Stop while it works; "Couldn't finish" or "Stopped"
 * with Retry once it ends without an answer. The answer itself is a
 * message, so a finished request has no row. One owner for Project
 * channels and Task rooms.
 */
export function RoomAgentActivity({
  agent,
  phase,
  detail,
  askedBy,
  at,
  onStop,
  stopping = false,
  onRetry,
}: {
  agent: string;
  phase: RoomAgentPhase;
  /** Why it ended, for `failed`; who asked otherwise. */
  detail?: string;
  askedBy?: string;
  at?: string;
  /** Only the person who asked may stop it. */
  onStop?(): void;
  stopping?: boolean;
  onRetry?(): void;
}) {
  const working = phase === 'starting' || phase === 'working';
  const step =
    phase === 'starting'
      ? 'Starting…'
      : phase === 'working'
        ? 'Working on it…'
        : phase === 'failed'
          ? 'Couldn’t finish'
          : 'Stopped';
  const when = at && Number.isFinite(Date.parse(at)) ? roomShortTime(at) : '';
  return (
    <div
      className={`room-agent-activity room-agent-activity--${phase}`}
      // Each change of step is announced once, politely.
      aria-live="polite"
    >
      <RoomAvatar name={agent} agent />
      <div className="room-agent-activity__body">
        <p className="room-agent-activity__line">
          <span className="room-agent-activity__name">{agent}</span>
          <span className="room-agent-activity__step">
            {working && (
              <span className="room-agent-activity__pulse" aria-hidden="true" />
            )}
            {step}
          </span>
        </p>
        <p className="room-agent-activity__meta">
          {[
            detail,
            askedBy ? `Asked by ${askedBy}` : '',
            when ? (working ? `started ${when}` : when) : '',
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
      </div>
      {(working ? onStop : onRetry) && (
        <span className="room-agent-activity__actions">
          {working ? (
            <Button
              size="sm"
              variant="secondary"
              pending={stopping}
              pendingLabel="Stopping"
              aria-label={`Stop ${agent}`}
              onClick={onStop}
            >
              Stop
            </Button>
          ) : (
            <Button size="sm" aria-label={`Retry ${agent}`} onClick={onRetry}>
              Retry
            </Button>
          )}
        </span>
      )}
    </div>
  );
}
