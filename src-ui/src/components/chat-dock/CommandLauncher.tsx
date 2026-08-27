import {
  captureReturnFocus,
  restoreReturnFocus,
} from '@kontourai/station-shared/return-focus';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useMobileVisualViewport } from '../../hooks/useMobileVisualViewport';
import { isComposingKeyEvent } from '../../lib/isComposingKeyEvent';
import { ResponsiveDialogCloseButton } from '../ResponsiveDialogSurface';
import {
  buildCommandLauncherPreview,
  COMMAND_LAUNCHER_SUGGESTIONS,
  type CommandLauncherContext,
} from './command-launcher-model';

interface CommandLauncherProps {
  context: CommandLauncherContext;
  returnFocusTarget?: HTMLElement | null;
  onClose: () => void;
  onConfirm: (intent: string) => void;
}

const FOCUSABLE =
  'button:not(:disabled), input:not(:disabled), [href], [tabindex]:not([tabindex="-1"])';

export function CommandLauncher({
  context,
  returnFocusTarget,
  onClose,
  onConfirm,
}: CommandLauncherProps) {
  const [intent, setIntent] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const returnFocusRef = useRef<HTMLElement[]>([]);
  const backdropPointerDismissRef = useRef(false);
  const visualViewport = useMobileVisualViewport();
  const preview = useMemo(
    () => buildCommandLauncherPreview(intent, context),
    [context, intent],
  );

  const closeAndRestoreFocus = useCallback(() => {
    const chain = returnFocusRef.current;
    const dialog = dialogRef.current;
    onClose();
    restoreReturnFocus(chain, dialog);
  }, [onClose]);

  const dismissBackdropOnMouseDown = useCallback(() => {
    backdropPointerDismissRef.current = true;
    closeAndRestoreFocus();
  }, [closeAndRestoreFocus]);

  const dismissBackdropOnClick = useCallback(() => {
    if (backdropPointerDismissRef.current) {
      backdropPointerDismissRef.current = false;
      return;
    }
    closeAndRestoreFocus();
  }, [closeAndRestoreFocus]);

  useLayoutEffect(() => {
    returnFocusRef.current = captureReturnFocus(returnFocusTarget);
    inputRef.current?.focus();
  }, [returnFocusTarget]);

  useEffect(() => {
    const containFocus = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeAndRestoreFocus();
        return;
      }
      if (event.key !== 'Tab') return;
      const controls = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [],
      ).filter((element) => !element.hasAttribute('disabled'));
      if (controls.length === 0) return;
      const first = controls[0];
      const last = controls.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', containFocus);
    return () => document.removeEventListener('keydown', containFocus);
  }, [closeAndRestoreFocus]);

  const submitIntent = useCallback(() => {
    if (!preview.intent || isSubmitting) return;
    setIsSubmitting(true);
    onConfirm(preview.intent);
    closeAndRestoreFocus();
  }, [closeAndRestoreFocus, isSubmitting, onConfirm, preview.intent]);

  return (
    <div
      className="command-launcher__overlay responsive-surface-overlay"
      style={visualViewport.style}
    >
      <button
        type="button"
        aria-label="Dismiss command launcher"
        onMouseDown={dismissBackdropOnMouseDown}
        onClick={dismissBackdropOnClick}
        style={{
          position: 'absolute',
          inset: 0,
          border: 0,
          padding: 0,
          background: 'transparent',
          cursor: 'default',
        }}
      />
      <div
        className="command-launcher responsive-surface-panel"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="command-launcher-title"
        style={{ position: 'relative', zIndex: 1 }}
      >
        <header className="command-launcher__header">
          <div>
            <span className="command-launcher__eyebrow">Active work</span>
            <h2 id="command-launcher-title">Command launcher</h2>
          </div>
          <ResponsiveDialogCloseButton
            label="Close command launcher"
            onClick={closeAndRestoreFocus}
          />
        </header>

        <div className="command-launcher__body">
          <label htmlFor="command-launcher-intent">
            What should the agent do?
          </label>
          <input
            id="command-launcher-intent"
            ref={inputRef}
            value={intent}
            placeholder="Describe the next action"
            onChange={(event) => setIntent(event.target.value)}
            onKeyDown={(event) => {
              if (
                event.key === 'Enter' &&
                !isComposingKeyEvent(event) &&
                preview.intent
              ) {
                event.preventDefault();
                submitIntent();
              }
            }}
          />

          <section
            className="command-launcher__suggestions"
            aria-label="Suggested intents"
          >
            {COMMAND_LAUNCHER_SUGGESTIONS.map((suggestion) => (
              <button
                key={suggestion.id}
                type="button"
                onClick={() => setIntent(suggestion.intent)}
              >
                {suggestion.label}
              </button>
            ))}
          </section>

          <section
            className="command-launcher__preview"
            aria-label="Command preview"
          >
            <h3>Preview</h3>
            <dl>
              <div>
                <dt>Intent</dt>
                <dd>{preview.intent || 'Enter an intent'}</dd>
              </div>
              <div>
                <dt>Project</dt>
                <dd>{preview.project}</dd>
              </div>
              <div>
                <dt>Agent</dt>
                <dd>{preview.agent}</dd>
              </div>
              <div>
                <dt>Model</dt>
                <dd>{preview.model}</dd>
              </div>
              <div>
                <dt>Mode</dt>
                <dd>{preview.mode}</dd>
              </div>
              <div>
                <dt>Attachments</dt>
                <dd>{preview.attachmentSummary}</dd>
              </div>
            </dl>
          </section>
        </div>

        <footer className="command-launcher__footer">
          <button type="button" onClick={closeAndRestoreFocus}>
            Cancel
          </button>
          <button
            type="button"
            className="command-launcher__confirm"
            disabled={!preview.intent || isSubmitting}
            onClick={submitIntent}
          >
            {isSubmitting ? 'Sending…' : 'Confirm and send'}
          </button>
        </footer>
      </div>
    </div>
  );
}
