import { useEffect, useState, useSyncExternalStore } from 'react';
import { activeChatsStore } from '../../../contexts/active-chats-store';
import { useRecheckMessageDelivery } from '../../../hooks/useMessageDeliveryState';
import { useStationOutlivesApp } from '../../../hooks/useStationOutlivesApp';
import type { MessageDeliveryState } from '../../../utils/messageDeliveryState';
import {
  AWAITING_CONFIRMATION_LABEL,
  MAY_HAVE_REACHED_LABEL,
} from '../deliveryLabels';
import {
  UnconfirmedDiscardConfirm,
  useUnconfirmedDiscardDisclosure,
} from '../UnconfirmedDiscardConfirm';

/** An action's result on the delivery line: an error is an alert. */
export interface DeliveryNotice {
  text: string;
  error: boolean;
}

/** Every state a bubble labels: all but `delivered`, which is a plain bubble. */
export type UndeliveredState = Exclude<MessageDeliveryState, 'delivered'>;

/**
 * Each label answers "does it go if I close the app?" in a few words; the
 * title says the rest. `sending` and `received` depend on more than the state
 * (whether the send was saved on this device; whether Station outlives the
 * app), so they are worded where those facts are read.
 */
const LABELS: Record<
  Exclude<UndeliveredState, 'received' | 'sending'>,
  { text: string; title: string }
> = {
  'waiting-to-send': {
    text: 'Saved on this device · sends when connected',
    title:
      'Station has not seen this yet. It stays on this device and is sent when Station can be reached, including after you reopen the app.',
  },
  'awaiting-confirmation': {
    text: AWAITING_CONFIRMATION_LABEL,
    title:
      'No answer came back. When Station can be reached it is asked about this message, and the message is sent once, with the same key, only if it never arrived.',
  },
  'waiting-behind-unsent': {
    text: 'Waiting behind an unsent message',
    title:
      'An earlier message in this chat was not sent. This one stays on this device and goes once that one is retried or discarded.',
  },
  'waiting-for-station': {
    text: 'Saved on this device · waits for its Station',
    title:
      'Written for another Station. It stays on this device and is sent only there, once this app is connected to it.',
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
    text: MAY_HAVE_REACHED_LABEL,
    title:
      'Station cannot confirm whether the agent got this message, so it is not sent again. Check asks Station again.',
  },
  unanswered: {
    text: 'Not confirmed',
    title:
      'This device has no answer from Station about this message. If it reached the agent, its reply appears here.',
  },
};

/**
 * The delivery line inside the user's own bubble until the agent has the
 * message. One status region stays mounted while the note is, and only its
 * text changes, so the first change after Sending (Received, Not sent) is
 * announced. `sending` itself is shown outside the region: every send passes
 * through it, and announcing it each time would be noise.
 */
export function MessageDeliveryNote({
  chatKey,
  clientTurnId,
  state,
  text,
  notice: outsideNotice,
}: {
  chatKey: string;
  clientTurnId: string;
  state: UndeliveredState;
  text: string;
  /** A result from an action the bubble's own menu ran (Discard). */
  notice?: DeliveryNotice | null;
}) {
  const [busy, setBusy] = useState(false);
  const [ownNotice, setNotice] = useState<DeliveryNotice | null>(null);
  const notice = ownNotice ?? outsideNotice ?? null;
  const discardDisclosure = useUnconfirmedDiscardDisclosure();
  const recheck = useRecheckMessageDelivery(chatKey);
  const savedOnDevice = useSyncExternalStore(activeChatsStore.subscribe, () => {
    const chat = activeChatsStore.getSnapshot()[chatKey];
    return (
      chat?.durableClientTurnId === clientTurnId &&
      chat.pendingClientTurnId === clientTurnId
    );
  });
  const canDiscardUnconfirmed = useUnconfirmedDiscardable(
    clientTurnId,
    state === 'unconfirmed',
  );

  const run = async (
    action: () => Promise<string | null | undefined>,
  ): Promise<void> => {
    setBusy(true);
    setNotice(null);
    try {
      const result = await action();
      setNotice(result ? { text: result, error: false } : null);
    } catch (error) {
      setNotice({
        text: `That didn't work: ${error instanceof Error ? error.message : String(error)}`,
        error: true,
      });
    } finally {
      setBusy(false);
    }
  };

  const sendingTitle = savedOnDevice
    ? 'Saved on this device. If the app closes before Station answers, it is checked and sent when you reopen it.'
    : 'Waiting for Station to answer.';

  return (
    <div className="message-delivery" data-delivery-state={state}>
      <div className="message-delivery__line">
        {state === 'sending' ? (
          <span className="message-delivery__label" title={sendingTitle}>
            Sending…
          </span>
        ) : null}
        <span role="status" className="message-delivery__status">
          {state === 'sending' ? null : state === 'received' ? (
            <ReceivedLabel />
          ) : (
            <span
              className="message-delivery__label"
              title={LABELS[state].title}
            >
              {LABELS[state].text}
            </span>
          )}
        </span>
        {state === 'not-sent' ? (
          <span className="message-delivery__actions">
            <button
              type="button"
              className="message-delivery__action"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const { retryNotSentMessage } = await import(
                    // Loaded on demand: the actions write the outbox, which a
                    // plain bubble never needs.
                    '../../../lib/messageDeliveryActions'
                  );
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
                  const { editMessageInComposer, ALREADY_DELIVERED } =
                    await import('../../../lib/messageDeliveryActions');
                  return (await editMessageInComposer(
                    chatKey,
                    clientTurnId,
                    text,
                  )) === 'delivered'
                    ? ALREADY_DELIVERED
                    : null;
                })
              }
            >
              Edit
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
            {canDiscardUnconfirmed ? (
              <button
                type="button"
                className="message-delivery__action"
                disabled={busy}
                {...discardDisclosure.triggerProps}
              >
                Discard…
              </button>
            ) : null}
          </span>
        ) : null}
      </div>
      {discardDisclosure.open &&
      state === 'unconfirmed' &&
      canDiscardUnconfirmed ? (
        <UnconfirmedDiscardConfirm
          busy={busy}
          {...discardDisclosure.confirmProps}
          onConfirm={() =>
            void run(async () => {
              const { discardMessage, ALREADY_DELIVERED } = await import(
                '../../../lib/messageDeliveryActions'
              );
              return (await discardMessage(
                chatKey,
                clientTurnId,
                'unconfirmed',
              )) === 'delivered'
                ? ALREADY_DELIVERED
                : null;
            })
          }
        />
      ) : null}
      {notice?.error ? (
        <span className="message-delivery__notice" role="alert">
          {notice.text}
        </span>
      ) : null}
      {/* Informational results (a Check that changed nothing) are polite. */}
      <span className="message-delivery__notice" role="status">
        {notice && !notice.error ? notice.text : null}
      </span>
    </div>
  );
}

/**
 * Discard… is offered for an unconfirmed message only when its outbox row is
 * the unconfirmed record itself (`may-have-started`) or there is none. A row
 * still `invoking` or `pending` is a send under way or waiting, which an
 * explicit dismissal would refuse anyway.
 */
function useUnconfirmedDiscardable(
  clientTurnId: string,
  unconfirmed: boolean,
): boolean {
  const [discardable, setDiscardable] = useState(false);
  useEffect(() => {
    if (!unconfirmed) {
      setDiscardable(false);
      return;
    }
    let active = true;
    let unsubscribe = () => {};
    void import('../../../lib/outboundQueue')
      .then(({ outboundDispatch }) => {
        const read = () =>
          void outboundDispatch
            .rowStatus(clientTurnId)
            .then((status) => {
              if (active)
                setDiscardable(
                  status === undefined || status === 'may-have-started',
                );
            })
            .catch(() => {
              if (active) setDiscardable(false);
            });
        if (!active) return;
        read();
        unsubscribe = outboundDispatch.subscribe(read);
      })
      .catch(() => undefined);
    return () => {
      active = false;
      unsubscribe();
    };
  }, [clientTurnId, unconfirmed]);
  return discardable;
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
