import { TASK_REVIEW_LIMITS } from '@kontourai/station-contracts/task-review';
import { type CSSProperties, useRef, useState } from 'react';
import { Button } from '../../../components/Button';
import { CloseGlyph, MessageGlyph } from '../../../components/icons/Glyph';
import {
  ResponsiveDialogSurface,
  ResponsiveSurfaceActions,
} from '../../../components/ResponsiveDialogSurface';
import { useUnsavedGuard } from '../../../hooks/useUnsavedGuard';

export function ReviewAnchorComposer({
  onSubmit,
  onCancel,
  position,
}: {
  onSubmit: (body: string) => void | Promise<void>;
  onCancel: () => void;
  position?: { left: number; top: number };
}) {
  const [body, setBody] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const input = useRef<HTMLTextAreaElement>(null);
  const panelStyle: CSSProperties & {
    '--review-left'?: string;
    '--review-top'?: string;
  } = position
    ? {
        '--review-left': `${position.left}px`,
        '--review-top': `${position.top}px`,
      }
    : {};
  const { guard, DiscardModal } = useUnsavedGuard(body.length > 0, () => {
    setBody('');
    return true;
  });
  return (
    <>
      <ResponsiveDialogSurface
        layer="popover"
        historyMode="none"
        ariaLabel="New review comment"
        onClose={() => guard(onCancel)}
        dismissible={!pending}
        initialFocusRef={input}
        overlayClassName="review-composer-overlay"
        panelClassName="review-composer"
        panelStyle={panelStyle}
      >
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            if (!body.trim() || pending) return;
            setPending(true);
            setError(undefined);
            try {
              await onSubmit(body.trim());
              setBody('');
              onCancel();
            } catch (cause) {
              setError(
                cause instanceof Error
                  ? cause.message
                  : 'Could not create review comment.',
              );
            } finally {
              setPending(false);
            }
          }}
        >
          <textarea
            ref={input}
            aria-label="New comment"
            placeholder="Comment…"
            rows={3}
            value={body}
            maxLength={TASK_REVIEW_LIMITS.bodyChars}
            disabled={pending}
            onChange={(event) => setBody(event.target.value)}
          />
          <ResponsiveSurfaceActions className="review-controls">
            <Button
              type="submit"
              size="sm"
              variant="primary"
              pending={pending}
              disabled={!body.trim()}
            >
              <MessageGlyph />
              Comment
            </Button>
            <Button
              size="sm"
              disabled={pending}
              aria-label="Cancel comment"
              onClick={() => guard(onCancel)}
            >
              <CloseGlyph />
            </Button>
          </ResponsiveSurfaceActions>
          {error && <p role="alert">{error}</p>}
        </form>
      </ResponsiveDialogSurface>
      <DiscardModal />
    </>
  );
}
