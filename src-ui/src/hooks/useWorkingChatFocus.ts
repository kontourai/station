import {
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';

interface WorkingChatFocusOptions {
  activeSessionId: string | null;
  /** The chat is writable and its composer may take focus. */
  ready: boolean;
  /**
   * The chat is busy (its turn still running) but its composer takes a
   * draft. Only a request made `whileBusy` (a chat just started from the New
   * chat draft) focuses it then; choosing a working chat waits for `ready`.
   */
  draftable?: boolean;
  terminal: boolean;
  surfaceRef: RefObject<HTMLElement | null>;
}

/**
 * How long a focused composer must stay usable in a writable chat before the
 * request is done. A chat that has just opened can disable its composer again
 * ("Loading chat…"), and a busy one disables it when its turn ends; until it
 * settles the request stays, so focus follows the composer back if nothing
 * else claimed it.
 */
const SETTLE_MS = 2_000;
/** A request whose chat never becomes focusable gives up after this long. */
const NOT_READY_DEADLINE_MS = 60_000;

export function useWorkingChatFocus({
  activeSessionId,
  ready,
  draftable = false,
  terminal,
  surfaceRef,
}: WorkingChatFocusOptions) {
  const [pending, setPending] = useState<{
    sessionId: string;
    whileBusy: boolean;
  } | null>(null);
  const [composer, onComposerEnabledChange] =
    useState<HTMLTextAreaElement | null>(null);
  // The composer focus was last put on: while it is being disabled it can
  // still hold focus for a moment, and that is not the person moving away.
  const lastComposer = useRef<HTMLTextAreaElement | null>(null);
  if (composer) lastComposer.current = composer;
  const requestComposerFocus = useCallback(
    (sessionId: string, options?: { whileBusy?: boolean }) => {
      setPending({ sessionId, whileBusy: options?.whileBusy === true });
    },
    [],
  );
  const canFocus = ready || (draftable && pending?.whileBusy === true);

  // The deadline covers only waiting for a focusable composer (including a
  // writable chat whose composer never registers): a busy chat holding a
  // draft-ready composer may run a turn far longer than a minute.
  const composerUsable =
    composer !== null && !composer.disabled && !composer.readOnly;
  useEffect(() => {
    if (!pending || (canFocus && composerUsable)) return;
    const deadline = window.setTimeout(
      () => setPending(null),
      NOT_READY_DEADLINE_MS,
    );
    return () => window.clearTimeout(deadline);
  }, [pending, canFocus, composerUsable]);

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
    // Focus already on the composer (this request put it there) is ours too.
    const ours = (element: EventTarget | null) =>
      mayRestoreFocus(element) ||
      (element !== null && element === lastComposer.current);
    const dialogOpen = () =>
      Array.from(
        document.querySelectorAll(
          '[role="dialog"], [role="alertdialog"], dialog[open]',
        ),
      ).some((dialog) => !dialog.closest('[aria-hidden="true"], [hidden]'));
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
    if (canFocus && composer && !composer.disabled && !composer.readOnly) {
      if (document.activeElement !== composer) composer.focus();
      if (ready) settle = window.setTimeout(() => setPending(null), SETTLE_MS);
    }
    const onFocusIn = (event: FocusEvent) => {
      if (!ours(event.target)) setPending(null);
    };
    // Leaving the composer for nothing focusable (a click on transcript text)
    // lands on the page without a `focusin`: that is the person moving away,
    // unless the composer lost focus because it was disabled, or the window
    // lost focus (a tab or app switch returns it to the composer).
    const onFocusOut = (event: FocusEvent) => {
      const target = event.target;
      if (
        document.hasFocus() &&
        target === lastComposer.current &&
        target instanceof HTMLTextAreaElement &&
        !target.disabled
      )
        setPending(null);
    };
    const observer = new MutationObserver(() => {
      if (dialogOpen()) setPending(null);
    });
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onFocusOut);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['role', 'open', 'aria-hidden', 'hidden'],
    });
    return () => {
      window.clearTimeout(settle);
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', onFocusOut);
      observer.disconnect();
    };
  }, [
    pending,
    activeSessionId,
    ready,
    canFocus,
    terminal,
    composer,
    surfaceRef,
  ]);

  return { requestComposerFocus, onComposerEnabledChange };
}
