import type { BrowserPendingDialogView } from '@kontourai/station-contracts/workspace-browser-pane';
import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import { Button } from '../../components/Button';
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
}: {
  dialog: BrowserPendingDialogView;
  pageHost: string;
  pending: boolean;
  error: string | null;
  onAnswer: (answer: { accept: boolean; promptText?: string }) => void;
  /** Offered where the card is shown outside the pane (the float). */
  onOpenInPane?: () => void;
  /**
   * Renew the person's control while this card is on screen. The server
   * dismisses a held dialog once the person's control ends; a person reading
   * it has not left.
   */
  onKeepAlive?: () => void;
}) {
  const titleId = useId();
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
  useEffect(() => {
    const timer = setInterval(() => {
      if (
        typeof document === 'undefined' ||
        document.visibilityState === 'visible'
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
      className="browser-pane__page-dialog"
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
      <p className="browser-pane__page-dialog-message" id={messageId}>
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
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="browser-pane__control browser-pane__page-dialog-open"
            onClick={onOpenInPane}
          >
            Open in pane
          </Button>
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
