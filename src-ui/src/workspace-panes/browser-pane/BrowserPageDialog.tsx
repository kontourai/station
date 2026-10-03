import type { BrowserPendingDialogView } from '@kontourai/station-contracts/workspace-browser-pane';
import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import { Button } from '../../components/Button';
import { IconButton } from '../../components/IconButton';
import { MonitorGlyph } from '../../components/icons/Glyph';
import { useCoarsePointer } from '../../hooks/useCoarsePointer';
import './BrowserPageDialog.css';

/**
 * A JavaScript dialog the page is showing and Station is holding for the
 * person in control (#90): `alert` (OK), `confirm` (Cancel / OK) or `prompt`
 * (a text answer, Cancel / OK). Drawn over the live view, because the page
 * underneath is waiting on it and takes no other input until it is answered.
 *
 * The message is the PAGE's text: shown as text, with the page's host, so it
 * is never mistaken for Station asking.
 */
/** Well inside the person's 30 s hold. */
const KEEP_ALIVE_MS = 10_000;

export function BrowserPageDialog({
  dialog,
  pageHost,
  pending,
  error,
  onAnswer,
  onOpenInPane,
  onKeepAlive,
  compact = false,
}: {
  dialog: BrowserPendingDialogView;
  pageHost: string;
  pending: boolean;
  error: string | null;
  onAnswer: (answer: { accept: boolean; promptText?: string }) => void;
  /** Offered where the card is shown outside the pane (the float). */
  onOpenInPane?: () => void;
  /**
   * Keep the person's hold alive while this card is on screen (the server
   * dismisses a held dialog once their control ends). The server caps it
   * from their last real input, so an unwatched page cannot hold forever.
   */
  onKeepAlive?: () => void;
  /** A small host (the float): tighter, with the page's text clamped. */
  compact?: boolean;
}) {
  const titleId = useId();
  const coarsePointer = useCoarsePointer();
  const messageId = useId();
  const [text, setText] = useState(dialog.defaultPrompt ?? '');
  const inputRef = useRef<HTMLInputElement>(null);
  const okRef = useRef<HTMLButtonElement>(null);
  // A new dialog takes focus: the page is waiting on it, and a keyboard
  // user must not have to hunt for it. Keyed on the dialog's identity.
  // biome-ignore lint/correctness/useExhaustiveDependencies: dialogId is the change key.
  useEffect(() => {
    setText(dialog.defaultPrompt ?? '');
    if (dialog.type === 'prompt') inputRef.current?.focus();
    else okRef.current?.focus();
  }, [dialog.dialogId]);

  const keepAliveRef = useRef(onKeepAlive);
  keepAliveRef.current = onKeepAlive;
  const cardRef = useRef<HTMLFormElement>(null);
  /** The card is actually on screen (laid out and in view), not just mounted. */
  const onScreenRef = useRef(typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    const card = cardRef.current;
    if (!card || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (entry) onScreenRef.current = entry.isIntersecting;
    });
    observer.observe(card);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const timer = setInterval(() => {
      // Only while a person could be reading it: the tab is visible and the
      // card is in view. The server caps how long this can hold control.
      if (
        onScreenRef.current &&
        (typeof document === 'undefined' ||
          document.visibilityState === 'visible')
      )
        keepAliveRef.current?.();
    }, KEEP_ALIVE_MS);
    return () => clearInterval(timer);
  }, []);

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onAnswer(
      dialog.type === 'prompt'
        ? { accept: true, promptText: text }
        : { accept: true },
    );
  };

  return (
    <form
      ref={cardRef}
      className={`browser-pane__page-dialog${compact ? ' browser-pane__page-dialog--compact' : ''}`}
      data-pointer={coarsePointer ? 'coarse' : 'fine'}
      role="alertdialog"
      aria-labelledby={titleId}
      aria-describedby={messageId}
      onSubmit={onSubmit}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && dialog.type !== 'alert' && !pending) {
          event.preventDefault();
          // Escape answers THIS dialog; it must not also close a menu, a
          // float or a panel around it.
          event.stopPropagation();
          onAnswer({ accept: false });
        }
      }}
    >
      <p className="browser-pane__page-dialog-title" id={titleId}>
        {`${pageHost} says`}
      </p>
      <p
        className="browser-pane__page-dialog-message"
        id={messageId}
        title={compact ? dialog.message : undefined}
      >
        {dialog.message || '(The page gave no message.)'}
      </p>
      {dialog.type === 'prompt' ? (
        <input
          ref={inputRef}
          className="browser-pane__page-dialog-input"
          aria-label="Your answer"
          value={text}
          maxLength={4096}
          onChange={(event) => setText(event.target.value)}
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
        />
      ) : null}
      {error ? (
        <p className="browser-pane__notice" role="alert">
          {error}
        </p>
      ) : null}
      <div className="browser-pane__page-dialog-actions">
        {onOpenInPane ? (
          <IconButton
            type="button"
            className="browser-pane__page-dialog-open"
            aria-label="Open in pane"
            title="Open in pane"
            onClick={onOpenInPane}
          >
            <MonitorGlyph />
          </IconButton>
        ) : null}
        {dialog.type === 'alert' ? null : (
          <Button
            type="button"
            className="browser-pane__control"
            disabled={pending}
            onClick={() => onAnswer({ accept: false })}
          >
            Cancel
          </Button>
        )}
        <Button
          ref={okRef}
          type="submit"
          variant="primary"
          className="browser-pane__control"
          pending={pending}
        >
          OK
        </Button>
      </div>
    </form>
  );
}
