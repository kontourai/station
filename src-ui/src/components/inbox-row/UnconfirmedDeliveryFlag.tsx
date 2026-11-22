import type { TurnDeliveryOutcome } from '@kontourai/station-contracts/orchestration';
import { useEffect, useRef, useState } from 'react';
import { toastStore } from '../../contexts/ToastContext';
import { recheckChatMessageDelivery } from '../../hooks/useMessageDeliveryState';
import { describeStationFailure } from '../../utils/stationFailure';
import type { WorkFacts } from '../../views/home/work-facts';
import { Button } from '../Button';
import {
  deliveryCheckResult,
  LAST_MESSAGE_UNCONFIRMED_LABEL,
} from '../chat/deliveryLabels';
import { useOptionalConversationConnection } from '../conversation/ConversationConnectionContext';
import { WarningGlyph } from '../icons/Glyph';

/** Where to act when the row cannot settle the message itself. */
const OPEN_TO_DISCARD = 'Open the chat to discard it.';
const OPEN_TO_CHECK = 'Open the chat to check it.';

/** How long after a Check its answer is still news when the flag goes away. */
const RESULT_FRESH_MS = 15_000;

/**
 * The answer Check reports for the row: the message note's sentence, plus
 * where to act when Station still cannot confirm it, so the flag is never a
 * dead end.
 */
function flagCheckResult(
  outcome: TurnDeliveryOutcome | undefined,
): string | null {
  const sentence = deliveryCheckResult(outcome);
  return outcome === 'indeterminate' ||
    outcome === 'expired' ||
    outcome === 'unknown'
    ? `${sentence} ${OPEN_TO_DISCARD}`
    : sentence;
}

/**
 * #5398: the inbox row's flag for a conversation that holds a message this
 * device sent whose delivery nothing can confirm. The row keeps the status
 * its ladder gives it (Done, Failed, Idle…) and its lane; this line says the
 * rest. Check asks Station once about every unconfirmed message the row
 * lists, each through the chat that holds it (two chats can hold one
 * conversation), and reports the newest one's answer; it never resends. The
 * message's own delivery note in the chat has the same Check and the other
 * recovery actions.
 *
 * A Check that settles the message removes the flag, and with it this line.
 * Its answer is then said once more through the shared notifications, which
 * are announced, so it is not lost with the row's change of status.
 *
 * `checkable` is false for a row this Station cannot check from here (a
 * conversation on another Station): the flag says to open the chat instead.
 */
export function UnconfirmedDeliveryFlag({
  turns,
  checkable,
  title,
  id,
}: {
  turns: NonNullable<WorkFacts['unconfirmedDelivery']>;
  checkable: boolean;
  /** The row's title, so each row's Check has its own accessible name. */
  title: string;
  /** The flag text's id, which the row's open button is described by. */
  id: string;
}) {
  const connection = useOptionalConversationConnection()?.station;
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const latest = useRef<{ text: string; at: number } | null>(null);
  useEffect(
    () => () => {
      const answer = latest.current;
      if (answer && Date.now() - answer.at < RESULT_FRESH_MS)
        toastStore.show(`${title}: ${answer.text}`);
    },
    [title],
  );
  const report = (text: string | null) => {
    setResult(text);
    latest.current = text ? { text, at: Date.now() } : null;
  };
  const run = async () => {
    setBusy(true);
    report(null);
    try {
      // Oldest first, so the answer reported is the newest message's.
      let outcome: TurnDeliveryOutcome | undefined;
      for (const turn of turns) {
        outcome = await recheckChatMessageDelivery(
          turn.chatSessionId,
          turn.clientTurnId,
          connection,
        );
      }
      report(flagCheckResult(outcome));
    } catch (error) {
      // The same translation the message's own Check uses.
      report(describeStationFailure(error).body);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="inbox-row__flag" data-testid="inbox-row-unconfirmed-flag">
      <WarningGlyph className="inbox-row__flag-glyph" />
      <span id={id} className="inbox-row__flag-text">
        {LAST_MESSAGE_UNCONFIRMED_LABEL}
        {checkable ? '' : `. ${OPEN_TO_CHECK}`}
      </span>
      {checkable && (
        <Button
          variant="link"
          className="inbox-row__flag-action"
          pending={busy}
          aria-label={`Check delivery in ${title}`}
          onClick={() => void run()}
        >
          Check
        </Button>
      )}
      <span className="inbox-row__flag-result" role="status">
        {result}
      </span>
    </div>
  );
}
