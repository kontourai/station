import { useState } from 'react';
import { useRecheckMessageDelivery } from '../../hooks/useMessageDeliveryState';
import type { WorkFacts } from '../../views/home/work-facts';
import { Button } from '../Button';
import {
  deliveryCheckResult,
  LAST_REPLY_UNCONFIRMED_LABEL,
} from '../chat/deliveryLabels';
import { WarningGlyph } from '../icons/Glyph';

/**
 * #5398: the inbox row's flag for a conversation that holds a message of
 * this device's whose delivery nothing can confirm. The row keeps the status
 * its ladder gives it (Done, Failed, Idle…) and its lane; this line says the
 * rest. Check asks Station once about the chat's unconfirmed messages and
 * reports what it found; it never resends (the message's own delivery note
 * in the chat has the same Check and the other recovery actions).
 *
 * `checkable` is false for a row this Station cannot check from here (a
 * conversation on another Station): the flag still shows.
 */
export function UnconfirmedDeliveryFlag({
  turns,
  checkable,
  title,
}: {
  turns: NonNullable<WorkFacts['unconfirmedDelivery']>;
  checkable: boolean;
  /** The row's title, so each row's Check has its own accessible name. */
  title: string;
}) {
  // One chat holds the row's messages in practice; Check asks about that
  // chat's, newest last, and reports the newest one's answer.
  const chatSessionId = turns[0]!.chatSessionId;
  const check = useRecheckMessageDelivery(chatSessionId);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setResult(null);
    try {
      let outcome: Awaited<ReturnType<typeof check>>;
      for (const turn of turns) {
        if (turn.chatSessionId !== chatSessionId) continue;
        outcome = await check(turn.clientTurnId);
      }
      setResult(deliveryCheckResult(outcome));
    } catch (error) {
      setResult(
        error instanceof Error
          ? error.message
          : 'Could not check. Open the chat to try again.',
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="inbox-row__flag" data-testid="inbox-row-unconfirmed-flag">
      <WarningGlyph className="inbox-row__flag-glyph" />
      <span className="inbox-row__flag-text">
        {LAST_REPLY_UNCONFIRMED_LABEL}
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
