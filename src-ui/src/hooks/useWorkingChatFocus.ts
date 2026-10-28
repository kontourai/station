import {
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';

interface WorkingChatFocusOptions {
  activeSessionId: string | null;
  ready: boolean;
  /**
   * The chat is past its opening phases (a busy chat that will disable and
   * re-enable its composer when its turn ends is not). The request ends only
   * once a focused composer has stayed usable while settled.
   */
  settled?: boolean;
  terminal: boolean;
  surfaceRef: RefObject<HTMLElement | null>;
}

/**
 * How long a focused composer must stay usable before the request is done. A
 * chat that has just opened can disable its composer again ("Loading chat…")
 * and re-enable it later; until then the request stays, so focus follows the
 * composer back if nothing else claimed it.
 */
const SETTLE_MS = 2_000;

export function useWorkingChatFocus({
  activeSessionId,
  ready,
  settled = true,
  terminal,
  surfaceRef,
}: WorkingChatFocusOptions) {
  const [pending, setPending] = useState<{ sessionId: string } | null>(null);
  const [composer, onComposerEnabledChange] =
    useState<HTMLTextAreaElement | null>(null);
  // The composer focus was last put on: while it is being disabled it can
  // still hold focus for a moment, and that is not the person moving away.
  const lastComposer = useRef<HTMLTextAreaElement | null>(null);
  if (composer) lastComposer.current = composer;
  const requestComposerFocus = useCallback((sessionId: string) => {
    setPending({ sessionId });
  }, []);

  useEffect(() => {
    if (!pending) return;
    const deadline = window.setTimeout(() => setPending(null), 60_000);
    return () => window.clearTimeout(deadline);
  }, [pending]);

  useEffect(() => {
    if (!pending) return;
    if (activeSessionId !== pending.sessionId) {
      setPending(null);
      return;
    }
    // Focus may move to the chosen chat only from where the choice was made
    // (a control marked `data-working-chat-origin`, the dock's More menu) or
    // from nowhere; focus the user put anywhere else stays put.
    const mayRestoreFocus = (element: EventTarget | null) =>
      element === document.body ||
      (element instanceof Element &&
        !!element.closest('[data-working-chat-origin]'));
    const dialogOpen = () =>
      Array.from(
        document.querySelectorAll(
          '[role="dialog"], [role="alertdialog"], dialog[open]',
        ),
      ).some((dialog) => !dialog.closest('[aria-hidden="true"], [hidden]'));
    // Focus already on the composer (this request put it there) is ours too.
    const ours = (element: EventTarget | null) =>
      mayRestoreFocus(element) ||
      (element !== null && element === lastComposer.current);
    if (dialogOpen() || !ours(document.activeElement)) {
      setPending(null);
      return;
    }
    if (terminal) {
      setPending(null);
      surfaceRef.current
        ?.querySelector<HTMLElement>('[role="log"][tabindex]')
        ?.focus();
      return;
    }
    let settle: number | undefined;
    if (ready && composer && !composer.disabled && !composer.readOnly) {
      if (document.activeElement !== composer) composer.focus();
      if (settled)
        settle = window.setTimeout(() => setPending(null), SETTLE_MS);
    }
    const onFocusIn = (event: FocusEvent) => {
      if (!ours(event.target)) setPending(null);
    };
    const observer = new MutationObserver(() => {
      if (dialogOpen()) setPending(null);
    });
    document.addEventListener('focusin', onFocusIn);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['role', 'open', 'aria-hidden', 'hidden'],
    });
    return () => {
      window.clearTimeout(settle);
      document.removeEventListener('focusin', onFocusIn);
      observer.disconnect();
    };
  }, [
    pending,
    activeSessionId,
    ready,
    settled,
    terminal,
    composer,
    surfaceRef,
  ]);

  return { requestComposerFocus, onComposerEnabledChange };
}
