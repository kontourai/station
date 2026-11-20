import { Button } from '../Button';
import { roomShortTime } from './groupRows';
import { RoomAvatar } from './RoomAvatar';
import './RoomAgentActivity.css';
import './RoomThreadSummary.css';

/**
 * Under a message with replies: who replied, how many, and when last (#4790,
 * #4795). One owner for the Task room's agent threads and the Project
 * room's reply threads, so both read the same.
 */
export function RoomThreadSummary({
  repliers,
  count,
  lastAt,
  disabled,
  onOpen,
  working,
}: {
  /** An Agent answering in this thread now (#4800): "Writer is working…". */
  working?: string;
  repliers: readonly { key: string; label: string; agent: boolean }[];
  count: number;
  lastAt?: string;
  disabled?: boolean;
  onOpen(): void;
}) {
  return (
    <span className="room-thread-summary">
      <span className="room-thread-summary__faces">
        {repliers.slice(0, 3).map((replier) => (
          <RoomAvatar
            key={replier.key}
            name={replier.label}
            agent={replier.agent}
          />
        ))}
      </span>
      <Button
        variant="ghost"
        size="sm"
        className="room-thread-summary__count"
        disabled={disabled}
        onClick={onOpen}
      >
        {`${count} ${count === 1 ? 'reply' : 'replies'}`}
      </Button>
      {working ? (
        <span className="room-thread-summary__working">
          <span className="room-agent-activity__pulse" aria-hidden="true" />
          {working} is working…
        </span>
      ) : null}
      {!working && lastAt && Number.isFinite(Date.parse(lastAt)) && (
        <span className="room-thread-summary__last">
          Last reply {roomShortTime(lastAt)}
        </span>
      )}
    </span>
  );
}
