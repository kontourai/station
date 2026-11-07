import {
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';

/**
 * Immersive (full-screen) viewing of one element, in place. The element is
 * never moved or remounted (its live stream stays the same stream): it is
 * laid over the whole viewport by CSS (`data-immersive`), and the Fullscreen
 * API is asked for on top of that where the platform grants it. A WebView or
 * frame that refuses it still gets the full-viewport layer, so immersive
 * does not depend on the API.
 *
 * It ends by `exit`, by Escape that nothing inside handled, or by the
 * platform leaving full screen (the system back gesture, Esc in a browser).
 */
export function useImmersive(target: RefObject<HTMLElement | null>): {
  immersive: boolean;
  enter: () => void;
  exit: () => void;
} {
  const [immersive, setImmersive] = useState(false);
  /** The platform granted full screen to this element during this session. */
  const grantedRef = useRef(false);

  const leaveFullscreen = useCallback(() => {
    if (
      typeof document !== 'undefined' &&
      document.fullscreenElement &&
      document.fullscreenElement === target.current
    )
      void document.exitFullscreen?.().catch(() => {});
  }, [target]);

  const enter = useCallback(() => {
    setImmersive(true);
    const element = target.current;
    try {
      const request = element?.requestFullscreen?.({ navigationUI: 'hide' });
      // A refusal is not an error: the full-viewport layer already stands.
      void request?.catch(() => {});
    } catch {
      /* the API is absent or refused synchronously: the layer stands */
    }
  }, [target]);

  const exit = useCallback(() => {
    grantedRef.current = false;
    setImmersive(false);
    leaveFullscreen();
  }, [leaveFullscreen]);

  useEffect(() => {
    if (!immersive) return;
    const onChange = () => {
      if (document.fullscreenElement === target.current) {
        grantedRef.current = true;
      } else if (grantedRef.current) {
        grantedRef.current = false;
        setImmersive(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      // Escape a surface's own keyboard target forwarded to the page is
      // the page's (it prevents default); any other Escape leaves.
      if (event.key === 'Escape' && !event.defaultPrevented) exit();
    };
    document.addEventListener('fullscreenchange', onChange);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('fullscreenchange', onChange);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [immersive, exit, target]);

  // Unmounting while immersive must not leave the document in full screen.
  useEffect(() => leaveFullscreen, [leaveFullscreen]);

  return { immersive, enter, exit };
}
