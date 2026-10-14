import { useState } from 'react';
import { useRecheckMessageDelivery } from '../../../hooks/useMessageDeliveryState';
import { useStationOutlivesApp } from '../../../hooks/useStationOutlivesApp';
import type { MessageDeliveryState } from '../../../utils/messageDeliveryState';

/** Every state a bubble labels: all but `delivered`, which is a plain bubble. */
export type UndeliveredState = Exclude<MessageDeliveryState, 'delivered'>;

/**
 * Each label answers "does it go if I close the app?" in a few words; the
 * title says the rest. `received` is told apart by whether Station outlives
 * the app (`ReceivedLabel`).
 */
const LABELS: Record<
  Exclude<UndeliveredState, 'received'>,
  { text: string; title: string }
> = {
  sending: {
    text: 'Sending…',
    title:
      'Saved on this device. If the app closes before Station answers, it is checked and sent when you reopen it.',
  },
  'waiting-to-send': {
    text: 'Saved on this device · sends when connected',
    title:
      'Station has not seen this yet. It stays on this device and is sent when Station can be reached, including after you reopen the app.',
  },
  'held-on-device': {
    text: 'Queued on this device',
    title:
      'Waiting for the current reply to finish. Station has not seen it yet; if the app closes first, it is kept here for you to send.',
  },
  'not-sent': {
    text: 'Not sent',
    title:
      'Station did not take this message. Retry sends it again as the same message, so it can never arrive twice.',
  },
  unconfirmed: {
    text: 'May have reached the agent',
    title:
      'Station cannot confirm whether the agent got this message, so it is not sent again. Check asks Station again.',
  },
};

const UNCONFIRMED_DISCARD_RISK =
  'It may already have reached the agent. Discarding removes it from this device only: it does not stop anything the agent started, and it is never sent again.';

/** Loaded on demand: the actions write the outbox, which a plain bubble never needs. */
const loadActions = () => import('../../../lib/messageDeliveryActions');

/**
 * The delivery line inside the user's own bubble until the agent has the
 * message. A state change is announced politely, except `sending`, which
 * every send passes through and would otherwise announce each time.
 */
export function MessageDeliveryNote({
  chatKey,
  clientTurnId,
  state,
  text,
}: {
  chatKey: string;
  clientTurnId: string;
  state: UndeliveredState;
  text: string;
}) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const recheck = useRecheckMessageDelivery(chatKey);

  const run = async (action: () => Promise<string | null | undefined>) => {
    setBusy(true);
    setNotice(null);
    try {
      setNotice((await action()) ?? null);
    } catch (error) {
      setNotice(
        `That didn't work: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      setBusy(false);
    }
  };

  const label =
    state === 'received' ? (
      <ReceivedLabel />
    ) : (
      <span className="message-delivery__label" title={LABELS[state].title}>
        {LABELS[state].text}
      </span>
    );

  return (
    <div className="message-delivery" data-delivery-state={state}>
      <div className="message-delivery__line">
        <span role={state === 'sending' ? undefined : 'status'}>{label}</span>
        {state === 'not-sent' ? (
          <span className="message-delivery__actions">
            <button
              type="button"
              className="message-delivery__action"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const { retryNotSentMessage } = await loadActions();
                  await retryNotSentMessage(clientTurnId);
                  return null;
                })
              }
            >
              Retry
            </button>
            <button
              type="button"
              className="message-delivery__action"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const { editMessageInComposer } = await loadActions();
                  await editMessageInComposer(chatKey, clientTurnId, text);
                  return null;
                })
              }
            >
              Edit
            </button>
            <button
              type="button"
              className="message-delivery__action"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const { discardMessage } = await loadActions();
                  await discardMessage(chatKey, clientTurnId, 'not-sent');
                  return null;
                })
              }
            >
              Discard
            </button>
          </span>
        ) : state === 'unconfirmed' ? (
          <span className="message-delivery__actions">
            <button
              type="button"
              className="message-delivery__action"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const outcome = await recheck(clientTurnId);
                  if (outcome === undefined)
                    return 'Nothing new to check right now.';
                  return outcome === 'indeterminate' ||
                    outcome === 'expired' ||
                    outcome === 'unknown'
                    ? 'Station still can’t confirm it.'
                    : null;
                })
              }
            >
              Check
            </button>
            <button
              type="button"
              className="message-delivery__action"
              disabled={busy}
              aria-expanded={confirmingDiscard}
              onClick={() => setConfirmingDiscard((open) => !open)}
            >
              Discard…
            </button>
          </span>
        ) : null}
      </div>
      {confirmingDiscard && state === 'unconfirmed' ? (
        <fieldset
          className="message-delivery__confirm"
          aria-label="Discard this message?"
        >
          <p>{UNCONFIRMED_DISCARD_RISK}</p>
          <span className="message-delivery__actions">
            <button
              type="button"
              className="message-delivery__action"
              onClick={() => setConfirmingDiscard(false)}
            >
              Keep it
            </button>
            <button
              type="button"
              className="message-delivery__action message-delivery__action--danger"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const { discardMessage } = await loadActions();
                  await discardMessage(chatKey, clientTurnId, 'unconfirmed');
                  return null;
                })
              }
            >
              I checked, discard it
            </button>
          </span>
        </fieldset>
      ) : null}
      {notice ? (
        <span className="message-delivery__notice" role="alert">
          {notice}
        </span>
      ) : null}
    </div>
  );
}

/**
 * Station has the message; the agent does not yet. Safe to close only when
 * that Station keeps running without this app (`useStationOutlivesApp`):
 * the desktop's own Station stops with it, and an unreported one promises
 * nothing.
 */
function ReceivedLabel() {
  const outlives = useStationOutlivesApp();
  const [text, title] =
    outlives === true
      ? [
          'Received · safe to close',
          'Station has your message and is starting the agent. It is safe to close the app.',
        ]
      : outlives === false
        ? [
            'Received · keep the app open',
            'Station has your message and is starting the agent. This Station stops when the app closes.',
          ]
        : ['Received', 'Station has your message and is starting the agent.'];
  return (
    <span className="message-delivery__label" title={title}>
      {text}
    </span>
  );
}
