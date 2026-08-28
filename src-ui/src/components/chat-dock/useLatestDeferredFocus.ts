import { useCallback, useEffect, useRef } from 'react';

/** Schedule only the latest post-binding focus and cancel it on unmount. */
export function useLatestDeferredFocus(focus: (sessionId: string) => void) {
  const focusRef = useRef(focus);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  focusRef.current = focus;

  const cancel = useCallback(() => {
    if (timerRef.current === undefined) return;
    clearTimeout(timerRef.current);
    timerRef.current = undefined;
  }, []);

  const schedule = useCallback(
    (sessionId: string) => {
      cancel();
      timerRef.current = setTimeout(() => {
        timerRef.current = undefined;
        focusRef.current(sessionId);
      }, 0);
    },
    [cancel],
  );

  useEffect(() => cancel, [cancel]);
  return { cancel, schedule };
}
