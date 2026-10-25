import { TASK_REVIEW_LIMITS } from '@kontourai/station-contracts/task-review';
import { type CSSProperties, useRef, useState } from 'react';
import { Button } from '../../../components/Button';
import { CloseGlyph, MessageGlyph } from '../../../components/icons/Glyph';
import {
  ResponsiveDialogSurface,
  ResponsiveSurfaceActions,
} from '../../../components/ResponsiveDialogSurface';
import { useUnsavedGuard } from '../../../hooks/useUnsavedGuard';
import { useReviewDraft } from './useReviewDraft';

export function ReviewAnchorComposer({
  onSubmit,
  onCancel,
  position,
  draftKey,
}: {
  onSubmit: (body: string) => void | Promise<void>;
  onCancel: () => void;
  position?: { left: number; top: number };
  draftKey: string;
}) {
  const { body, setBody, saved } = useReviewDraft(draftKey);
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
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                setBody('');
                onCancel();
              }
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
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
            {saved && (
              <span className="review-draft-status" role="status">
                draft saved
              </span>
            )}

            <Button
              type="submit"
              size="sm"
              variant="primary"
              pending={pending}
              disabled={!body.trim()}
            >
              <MessageGlyph />
              Comment <kbd>⌘Enter</kbd>
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
