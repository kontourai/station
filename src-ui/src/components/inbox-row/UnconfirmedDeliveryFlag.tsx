import type { TurnDeliveryOutcome } from '@kontourai/station-contracts/orchestration';
import { useEffect, useRef, useState } from 'react';
import { toastStore } from '../../contexts/ToastContext';
import { recheckChatMessageDelivery } from '../../hooks/useMessageDeliveryState';
import { describeStationFailure } from '../../utils/stationFailure';
import type { WorkFacts } from '../../views/home/work-facts';
import { Button } from '../Button';
import {
  inboxCheckResult,
  LAST_MESSAGE_UNCONFIRMED_LABEL,
} from '../chat/deliveryLabels';
import { useOptionalConversationConnection } from '../conversation/ConversationConnectionContext';
import { WarningGlyph } from '../icons/Glyph';

const OPEN_TO_CHECK = 'Open the chat to check it.';

/** One press asks about at most this many messages, the newest ones. */
const CHECK_LIMIT = 5;

/** How long after a settling Check its answer is still news. */
const RESULT_FRESH_MS = 15_000;

/** Answers that settle a message: the outbox stops holding it unconfirmed. */
function settles(outcome: TurnDeliveryOutcome | undefined): boolean {
  return outcome === 'started' || outcome === 'not-received';
}

/**
 * #5398: the inbox row's flag for a conversation that holds a message this
 * device sent whose delivery nothing can confirm. The row keeps the status
 * its ladder gives it (Done, Failed, Idle…) and its lane; this line says the
 * rest. Check asks Station once about the newest unconfirmed messages the
 * row lists (at most `CHECK_LIMIT`), each through the chat that holds it
 * (two chats can hold one conversation), and reports the most serious
 * answer (`inboxCheckResult`); it never resends. The message's own delivery
 * note in the chat has the same Check and the other recovery actions.
 *
 * A Check whose every answer settles its message removes the flag, and with
 * it this line. That answer is then said once more through the shared
 * notifications, which are announced. Only that: a flag that leaves the
 * screen for any other reason (navigation, a filter, a closed dock) says
 * nothing, and neither does an answer that leaves the flag in place.
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
  const titleRef = useRef(title);
  titleRef.current = title;
  /** The last Check's answer, when every message it asked about settled. */
  const settled = useRef<{ text: string; at: number } | null>(null);
  useEffect(
    () => () => {
      const answer = settled.current;
      if (answer && Date.now() - answer.at < RESULT_FRESH_MS)
        toastStore.show(
          `${titleRef.current.replace(/[.!?]+$/, '')}: ${answer.text}`,
        );
    },
    [],
  );
  const run = async () => {
    setBusy(true);
    setResult(null);
    settled.current = null;
    const asked = turns.slice(-CHECK_LIMIT);
    const remaining = turns.length - asked.length;
    try {
      const outcomes: (TurnDeliveryOutcome | undefined)[] = [];
      for (const turn of asked) {
        outcomes.push(
          await recheckChatMessageDelivery(
            turn.chatSessionId,
            turn.clientTurnId,
            connection,
          ),
        );
      }
      const text = inboxCheckResult(outcomes, remaining);
      setResult(text);
      if (text && remaining === 0 && outcomes.every(settles))
        settled.current = { text, at: Date.now() };
    } catch (error) {
      // The same translation the message's own Check uses.
      setResult(describeStationFailure(error).body);
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
