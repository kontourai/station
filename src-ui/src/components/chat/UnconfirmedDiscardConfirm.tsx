import { useEffect, useId, useRef, useState } from 'react';
import './UnconfirmedDiscardConfirm.css';

/**
 * The Discard… button and its confirmation, as one disclosure. The button
 * stays mounted while the confirmation is open (it toggles it and points at
 * it), focus moves into the confirmation when it opens, and Keep it hands
 * focus back to the button.
 */
export function useUnconfirmedDiscardDisclosure() {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const confirmId = useId();
  return {
    open,
    close: () => setOpen(false),
    triggerProps: {
      ref: triggerRef,
      'aria-expanded': open,
      'aria-controls': open ? confirmId : undefined,
      onClick: () => setOpen((value) => !value),
    },
    confirmProps: {
      id: confirmId,
      onKeep: () => {
        setOpen(false);
        triggerRef.current?.focus();
      },
    },
  };
}

/**
 * The one confirmation for discarding a message that may have reached the
 * agent (#3596), on its bubble, in the outbox list, in the transcript's
 * notice and in the composer alike: the risk first, then Keep it or the
 * explicit "I checked, discard it". It takes focus when it opens (on Keep
 * it, the safe choice), so a keyboard or screen reader user lands on the
 * question rather than on the page.
 */
export function UnconfirmedDiscardConfirm({
  id,
  busy = false,
  onKeep,
  onConfirm,
}: {
  id?: string;
  busy?: boolean;
  onKeep: () => void;
  onConfirm: () => void;
}) {
  const keepRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    keepRef.current?.focus();
  }, []);
  return (
    <fieldset
      id={id}
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
          ref={keepRef}
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
