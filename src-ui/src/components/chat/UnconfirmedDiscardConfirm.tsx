import './UnconfirmedDiscardConfirm.css';

/**
 * The one confirmation for discarding a message that may have reached the
 * agent (#3596), on its bubble and in the outbox list alike: the risk first,
 * then Keep it or the explicit "I checked, discard it".
 */
export function UnconfirmedDiscardConfirm({
  busy = false,
  onKeep,
  onConfirm,
}: {
  busy?: boolean;
  onKeep: () => void;
  onConfirm: () => void;
}) {
  return (
    <fieldset
      className="unconfirmed-discard"
      aria-label="Discard this message?"
    >
      <p className="unconfirmed-discard__risk">
        It may already have reached the agent. Discarding removes it from this
        device only: it does not stop anything the agent started, and it is
        never sent again.
      </p>
      <span className="unconfirmed-discard__actions">
        <button
          type="button"
          className="unconfirmed-discard__button"
          onClick={onKeep}
        >
          Keep it
        </button>
        <button
          type="button"
          className="unconfirmed-discard__button unconfirmed-discard__button--danger"
          disabled={busy}
          onClick={onConfirm}
        >
          I checked, discard it
        </button>
      </span>
    </fieldset>
  );
}
