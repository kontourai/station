import { ActionRow } from '../ActionRow';
import { Button } from '../Button';

export function ScheduleCardActions({
  acceptLabel,
  acceptingLabel,
  busy,
  accepting,
  declining,
  onAccept,
  onDecline,
}: {
  acceptLabel: string;
  acceptingLabel: string;
  busy: boolean;
  accepting: boolean;
  declining: boolean;
  onAccept: () => void;
  onDecline: () => void;
}) {
  return (
    <ActionRow
      className="agent-schedule-card__actions"
      overflowLabel="More ways to decide"
      secondary={
        <Button
          variant="danger-outline"
          size="sm"
          pending={declining}
          pendingLabel="Declining…"
          disabled={busy}
          onClick={onDecline}
        >
          Decline
        </Button>
      }
      primary={
        <Button
          variant="primary"
          size="sm"
          pending={accepting}
          pendingLabel={acceptingLabel}
          disabled={busy}
          onClick={onAccept}
        >
          {acceptLabel}
        </Button>
      }
    />
  );
}
