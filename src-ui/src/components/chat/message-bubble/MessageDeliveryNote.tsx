import { useId, useRef, useState } from 'react';
import { useStationOutlivesApp } from '../../../hooks/useStationOutlivesApp';
import type { MessageDeliveryState } from '../../../utils/messageDeliveryState';
import { describeStationFailure } from '../../../utils/stationFailure';
import { ActionOverflowMenu } from '../../ActionOverflowMenu';
import { Button } from '../../Button';
import type { DeliveryPort } from '../../conversation/DeliveryPort';
import {
  AWAITING_CONFIRMATION_LABEL,
  MAY_HAVE_REACHED_LABEL,
  receivedDeliveryLabel,
} from '../deliveryLabels';
import {
  UnconfirmedDiscardConfirm,
  useUnconfirmedDiscardDisclosure,
} from '../UnconfirmedDiscardConfirm';
import '../chat.css';

/** An action's result on the delivery line: an error is an alert. */
export interface DeliveryNotice {
  text: string;
  error: boolean;
}

/** The happy path, told by the bubble's outline and a glyph, never a line. */
type HappyState = 'sending' | 'received' | 'delivered';
/** The states the user must read or act on: one short line each. */
type ExceptionState = Exclude<MessageDeliveryState, HappyState>;

function isException(state: MessageDeliveryState): state is ExceptionState {
  return state !== 'sending' && state !== 'received' && state !== 'delivered';
}

/**
 * One short line per exception: the fact, with any action as a button beside
 * it. The title carries the rest.
 */
const LABELS: Record<ExceptionState, { text: string; title: string }> = {
  'waiting-to-send': {
    text: 'Sends when connected',
    title:
      'Kept on this device. Sent when Station is reachable, even after a restart.',
  },
  'awaiting-confirmation': {
    text: AWAITING_CONFIRMATION_LABEL,
    title:
      "Station will be asked whether it got this. It is sent once, only if it didn't.",
  },
  'waiting-behind-unsent': {
    text: 'Waits for the unsent message above',
    title:
      "An earlier message wasn't sent. This one goes after you retry or discard that one.",
  },
  'waiting-for-station': {
    text: 'Waits for its own Station',
    title: 'Written for another Station. Sent only there, once connected.',
  },
  'held-on-device': {
    text: 'Queued. Sends after this reply.',
    title:
      'Kept on this device until the reply ends. If the app closes first, it stays here to send.',
  },
  'held-for-send': {
    text: 'Queued. Send when ready.',
    title: 'Kept on this device. Sent only when you choose Send.',
  },
  'not-sent': {
    text: 'Not sent',
    title: "Station didn't take it. Retry can't send it twice.",
  },
  unconfirmed: {
    text: MAY_HAVE_REACHED_LABEL,
    title:
      "Station can't confirm delivery, so it won't resend. Check asks again.",
  },
  unanswered: {
    text: 'Not confirmed',
    title:
      'No answer from Station. If the agent got it, its reply appears here.',
  },
};

/**
 * Where the user's own message stands, inside its bubble.
 *
 * The happy path (sending, received by Station, delivered to the agent) has
 * no text: the bubble's outline and a small glyph beside it carry it, and the
 * glyph's title and accessible name state the fact. The exception states get
 * one short line with their action, revealed in place (grid rows 0fr to 1fr)
 * so neighbours never jump. A note that has shown an undelivered state stays
 * mounted once delivered, so its glyph fades out instead of vanishing.
 *
 * One status region stays mounted and only its text changes, so the first
 * change after Sending (Received, Not sent) is announced. `sending` itself is
 * not: every send passes through it.
 */
export function MessageDeliveryNote({
  port,
  state,
  notice: outsideNotice,
  variant = 'bubble',
}: {
  port: DeliveryPort;
  state: MessageDeliveryState;
  /** A result from an action the bubble's own menu ran (Discard). */
  notice?: DeliveryNotice | null;
  variant?: 'bubble' | 'inline';
}) {
  const [busy, setBusy] = useState(false);
  const [ownNotice, setNotice] = useState<DeliveryNotice | null>(null);
  const notice = ownNotice ?? outsideNotice ?? null;
  const discardDisclosure = useUnconfirmedDiscardDisclosure();
  const titleId = useId();
  const { savedOnDevice, canDiscardUnconfirmed } = port;
  // The line keeps its last exception's words while it folds away, so the
  // collapse never shows an empty band.
  const seenUndelivered = useRef(state !== 'delivered');
  if (state !== 'delivered') seenUndelivered.current = true;
  const lastException = useRef<ExceptionState | undefined>(undefined);
  if (isException(state)) lastException.current = state;

  // A message already delivered when it first renders (history, a remount)
  // is a plain filled bubble: there is no transition to show.
  if (!seenUndelivered.current) return null;

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
        text: describeStationFailure(error).body,
        error: true,
      });
    } finally {
      setBusy(false);
    }
  };

  // The received wording depends on whether Station outlives the app, read
  // only while received (`ReceivedText`), as it always was.
  const glyphLabel =
    state === 'sending' ? (
      savedOnDevice ? (
        'Sending. Kept on this device if the app closes.'
      ) : (
        'Sending'
      )
    ) : state === 'received' ? (
      <ReceivedText value={port.stationOutlivesApp} />
    ) : (
      'Delivered'
    );
  const lineOpen = isException(state);
  const line = lastException.current;
  // What a screen reader is told: the received fact or the exception line.
  const announcement =
    state === 'received' ? (
      <ReceivedText value={port.stationOutlivesApp} />
    ) : isException(state) ? (
      LABELS[state].text
    ) : null;

  return (
    <div
      className={`message-delivery${variant === 'inline' ? ' message-delivery--inline' : ''}`}
      data-delivery-state={state}
    >
      <span
        className="message-delivery__glyph"
        data-glyph={
          state === 'sending'
            ? 'sending'
            : state === 'received' || state === 'delivered'
              ? 'received'
              : 'none'
        }
        role="img"
        aria-labelledby={titleId}
        aria-hidden={
          state === 'sending' || state === 'received' ? undefined : true
        }
      >
        {/* biome-ignore lint/a11y/noSvgWithoutTitle: the title is set below from the delivery state; the rule cannot see dynamic text. */}
        <svg viewBox="0 0 16 16" focusable="false">
          {/* The glyph's tooltip and its accessible name. */}
          <title id={titleId}>{glyphLabel}</title>
          <circle
            className="message-delivery__glyph-ring"
            cx="8"
            cy="8"
            r="5.5"
          />
          <path
            className="message-delivery__glyph-check"
            d="M5 8.25 7.1 10.3 11 6"
          />
        </svg>
      </span>
      <span role="status" className="message-delivery__status">
        {announcement}
      </span>
      <div
        className="message-delivery__reveal"
        data-open={lineOpen ? 'true' : undefined}
        inert={!lineOpen}
      >
        <div className="message-delivery__reveal-inner">
          <div className="message-delivery__line">
            {line ? (
              <span
                className="message-delivery__label"
                data-tone={line}
                title={LABELS[line].title}
                // The status region above already speaks this line.
                aria-hidden="true"
              >
                {LABELS[line].text}
              </span>
            ) : null}
            {state === 'not-sent' ? (
              <span className="message-delivery__actions">
                {port.canRetry !== false && port.retry && (
                  <button
                    type="button"
                    className="message-delivery__action"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await port.retry?.();
                        return null;
                      })
                    }
                  >
                    Retry
                  </button>
                )}
                {port.edit && (
                  <button
                    type="button"
                    className="message-delivery__action"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        return port.edit?.();
                      })
                    }
                  >
                    Edit
                  </button>
                )}
              </span>
            ) : (state === 'held-on-device' || state === 'held-for-send') &&
              port.release ? (
              <Button
                size="sm"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await port.release?.();
                    return null;
                  })
                }
              >
                Send
              </Button>
            ) : state === 'unconfirmed' || state === 'awaiting-confirmation' ? (
              <span className="message-delivery__actions">
                {port.check && (
                  <button
                    type="button"
                    className="message-delivery__action"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        const outcome = await port.check?.();
                        if (outcome === undefined)
                          return 'Nothing new to check right now.';
                        if (outcome === 'not-received')
                          return 'Station did not receive it. Retry sends it with the same message key.';
                        if (outcome === 'received' || outcome === 'queued')
                          return 'Station has the message. The agent has not started it yet.';
                        if (outcome === 'started')
                          return 'The agent started this message.';
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
                )}
                {(port.edit || port.copy) && (
                  <ActionOverflowMenu
                    label="More delivery actions"
                    actions={[
                      ...(port.edit
                        ? [
                            {
                              key: 'edit-copy',
                              label: 'Edit a copy',
                              disabled: busy,
                              onSelect: () => void run(() => port.edit!()),
                            },
                          ]
                        : []),
                      ...(port.copy
                        ? [
                            {
                              key: 'copy-message',
                              label: 'Copy message',
                              disabled: busy,
                              onSelect: () => void run(() => port.copy!()),
                            },
                          ]
                        : []),
                    ]}
                  />
                )}
                {canDiscardUnconfirmed && port.discard ? (
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
        </div>
      </div>
      {discardDisclosure.open &&
      (state === 'unconfirmed' || state === 'awaiting-confirmation') &&
      canDiscardUnconfirmed &&
      port.discard ? (
        <UnconfirmedDiscardConfirm
          busy={busy}
          {...discardDisclosure.confirmProps}
          onConfirm={() =>
            void run(async () => {
              return port.discard?.();
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
 * Station has the message; the agent does not yet. Says closing the app is
 * safe only when that Station keeps running without it
 * (`useStationOutlivesApp`), so the platform is read only in this state.
 */
function ReceivedText({ value }: { value?: boolean | null }) {
  return value === undefined ? (
    <ObservedReceivedText />
  ) : (
    <>{receivedDeliveryLabel(value ?? undefined)}</>
  );
}
function ObservedReceivedText() {
  return <>{receivedDeliveryLabel(useStationOutlivesApp())}</>;
}
