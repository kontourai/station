import { type RefObject, useCallback, useEffect, useState } from 'react';

interface WorkingChatFocusOptions {
  activeSessionId: string | null;
  ready: boolean;
  terminal: boolean;
  surfaceRef: RefObject<HTMLElement | null>;
}

export function useWorkingChatFocus({
  activeSessionId,
  ready,
  terminal,
  surfaceRef,
}: WorkingChatFocusOptions) {
  const [pending, setPending] = useState<{ sessionId: string } | null>(null);
  const [composer, onComposerEnabledChange] =
    useState<HTMLTextAreaElement | null>(null);
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
    const mayRestoreFocus = (element: EventTarget | null) =>
      element === document.body ||
      (element instanceof Element && !!element.closest('.chat-dock__activity'));
    const dialogOpen = () =>
      Array.from(
        document.querySelectorAll(
          '[role="dialog"], [role="alertdialog"], dialog[open]',
        ),
      ).some((dialog) => !dialog.closest('[aria-hidden="true"], [hidden]'));
    if (dialogOpen() || !mayRestoreFocus(document.activeElement)) {
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
    if (ready && composer && !composer.disabled && !composer.readOnly) {
      setPending(null);
      composer.focus();
      return;
    }
    const onFocusIn = (event: FocusEvent) => {
      if (!mayRestoreFocus(event.target)) setPending(null);
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
      document.removeEventListener('focusin', onFocusIn);
      observer.disconnect();
    };
  }, [pending, activeSessionId, ready, terminal, composer, surfaceRef]);

  return { requestComposerFocus, onComposerEnabledChange };
}
