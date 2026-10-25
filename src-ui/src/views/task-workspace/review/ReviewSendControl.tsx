import { useState } from 'react';
import { ActionOverflowMenu } from '../../../components/ActionOverflowMenu';
import { Button } from '../../../components/Button';
import {
  ArrowDownGlyph,
  ArrowUpGlyph,
  CheckGlyph,
  CopyGlyph,
} from '../../../components/icons/Glyph';
import type { ReviewDeliveryActions, ReviewSendMode } from './review-types';

export function ReviewSendControl({
  ids,
  onSend,
  onCopyForAgent,
  sending = false,
}: ReviewDeliveryActions & { ids: readonly string[] }) {
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
    ? `${mode === 'send' ? 'Send' : 'Send + Resolve'} ${ids.length}`
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
          title={`${mode === 'send' ? 'Send' : 'Send + Resolve'} · ⌥C`}
          aria-label={label}
        >
          {onSend ? <ArrowUpGlyph /> : <CopyGlyph />}
          {onSend ? `Send ${ids.length}` : label}
          {onSend && mode === 'send-and-resolve' && <CheckGlyph />}
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
