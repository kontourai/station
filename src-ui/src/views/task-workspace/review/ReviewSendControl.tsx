import { useState } from 'react';
import { ActionOverflowMenu } from '../../../components/ActionOverflowMenu';
import { Button } from '../../../components/Button';
import {
  ArrowDownGlyph,
  ArrowUpGlyph,
  CopyGlyph,
} from '../../../components/icons/Glyph';
import type { ReviewDeliveryActions, ReviewSendMode } from './review-types';

export function ReviewSendControl({
  ids,
  onSend,
  onCopyForAgent,
  sending = false,
  bulk = false,
}: ReviewDeliveryActions & { ids: readonly string[]; bulk?: boolean }) {
  const [mode, setMode] = useState<ReviewSendMode>('send');
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<string>();
  async function deliver() {
    if (!ids.length || pending || sending) return;
    setPending(true);
    setFeedback(undefined);
    try {
      if (onSend) await onSend(ids, mode);
      else if (onCopyForAgent) {
        await onCopyForAgent(ids);
        setFeedback('Copied');
      }
    } catch (cause) {
      setFeedback(
        cause instanceof Error ? cause.message : 'Send failed. Retry.',
      );
    } finally {
      setPending(false);
    }
  }
  const label = onSend
    ? `${mode === 'send' ? 'Send' : 'Send + Resolve'}${bulk ? ` ${ids.length}` : ''}`
    : 'Copy for agent';
  return (
    <div className="review-delivery">
      <fieldset
        className="review-send"
        aria-label={bulk ? 'Send selected threads' : 'Send thread'}
      >
        <Button
          size="sm"
          variant={bulk ? 'primary' : 'ghost'}
          disabled={!ids.length || (!onSend && !onCopyForAgent)}
          pending={pending || sending}
          onClick={() => void deliver()}
          data-review-send={bulk || undefined}
          title={bulk ? '⌥C' : undefined}
        >
          {onSend ? <ArrowUpGlyph /> : <CopyGlyph />}
          {label}
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
      {feedback && (
        <span role="status" className="review-delivery__feedback">
          {feedback}
        </span>
      )}
    </div>
  );
}
