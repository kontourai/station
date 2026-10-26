import { useState } from 'react';
import { ActionOverflowMenu } from '../../../components/ActionOverflowMenu';
import { Button } from '../../../components/Button';
import {
  ArrowDownGlyph,
  CheckGlyph,
  CopyGlyph,
  OutboxGlyph,
} from '../../../components/icons/Glyph';
import { ErrorState } from '../../../components/state';
import { useCoarsePointer } from '../../../hooks/useCoarsePointer';
import type { ReviewDeliveryActions, ReviewSendMode } from './review-types';

export function ReviewSendControl({
  ids,
  onSend,
  onCopyForAgent,
  sending = false,
}: ReviewDeliveryActions & { ids: readonly string[] }) {
  const coarse = useCoarsePointer();
  const [mode, setMode] = useState<ReviewSendMode>('send');
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<string>();
  const [error, setError] = useState<string>();
  async function deliver() {
    if (!ids.length || pending || sending) return;
    setPending(true);
    setFeedback(undefined);
    setError(undefined);
    try {
      if (onSend) await onSend(ids, mode);
      else if (onCopyForAgent) {
        await onCopyForAgent(ids);
        setFeedback('Copied');
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Send failed. Retry.');
    } finally {
      setPending(false);
    }
  }
  const label = onSend
    ? ids.length
      ? `${mode === 'send' ? 'Send' : 'Send + Resolve'} ${ids.length}`
      : 'Send'
    : 'Copy for agent';
  return (
    <div className="review-delivery">
      <fieldset className="review-send" aria-label="Send filtered threads">
        <Button
          size="sm"
          variant={ids.length > 0 ? 'primary' : 'ghost'}
          disabled={!ids.length || (!onSend && !onCopyForAgent)}
          pending={pending || sending}
          onClick={() => void deliver()}
          data-review-send
          title={coarse ? label : `${label} · ⌥C`}
          aria-label={label}
        >
          {onSend ? <OutboxGlyph /> : <CopyGlyph />}
          {onSend && ids.length ? `Send ${ids.length}` : label}
          {onSend && ids.length > 0 && mode === 'send-and-resolve' && (
            <CheckGlyph />
          )}
        </Button>
        {onSend && (
          <ActionOverflowMenu
            label="Choose send mode"
            triggerGlyph={<ArrowDownGlyph />}
            actions={(['send', 'send-and-resolve'] as const).map((value) => ({
              key: value,
              label: value === 'send' ? 'Send' : 'Send + Resolve',
              checked: mode === value,
              exclusive: true,
              onSelect: () => setMode(value),
            }))}
          />
        )}
      </fieldset>
      {error && <ErrorState variant="compact" title={error} />}
      {feedback && (
        <span role="status" className="review-delivery__feedback">
          {feedback}
        </span>
      )}
    </div>
  );
}
