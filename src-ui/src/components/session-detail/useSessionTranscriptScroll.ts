import {
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

/** Follow new transcript content until the reader scrolls away from its tail. */
export function useSessionTranscriptScroll({
  identity,
  scrollRef,
  contentRef,
  ready,
  contentVersion,
  preserveReading = false,
}: {
  identity: string;
  scrollRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLElement | null>;
  ready: boolean;
  contentVersion: unknown;
  preserveReading?: boolean;
}) {
  const follow = useRef(!preserveReading);
  const lastSeenTop = useRef(0);
  const wheelReachesTail = useRef(false);
  const reader = useRef(identity);
  const readyRef = useRef(ready);
  readyRef.current = ready;
  const preserving = useRef(preserveReading);
  const [atLatest, setAtLatest] = useState(!preserveReading);

  const pinToLatest = useCallback(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    scroll.scrollTop = scroll.scrollHeight;
    // A shrink or a disappearing Jump toolbar can clamp our own pin upward.
    lastSeenTop.current = scroll.scrollTop;
  }, [scrollRef]);

  const jumpToLatest = () => {
    if (!scrollRef.current) return;
    follow.current = true;
    wheelReachesTail.current = false;
    pinToLatest();
    setAtLatest(true);
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: Transcript commits and the Jump toolbar changing visibility can change scroll height.
  useLayoutEffect(() => {
    if (reader.current !== identity) {
      reader.current = identity;
      follow.current = !preserveReading;
      wheelReachesTail.current = false;
    }
    if (preserveReading && !preserving.current) {
      follow.current = false;
      wheelReachesTail.current = false;
    }
    preserving.current = preserveReading;
    if (follow.current) {
      if (ready) pinToLatest();
      else if (scrollRef.current) {
        // Loading content can clamp the same scroller before it is ready.
        lastSeenTop.current = scrollRef.current.scrollTop;
      }
    }
    setAtLatest(follow.current);
  }, [
    identity,
    ready,
    contentVersion,
    preserveReading,
    scrollRef,
    pinToLatest,
    atLatest,
  ]);

  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const overflowAnchor = scroll.style.overflowAnchor;
    // Own the tail while following; preserve native reader anchoring on pause.
    if (atLatest) scroll.style.overflowAnchor = 'none';
    return () => {
      scroll.style.overflowAnchor = overflowAnchor;
    };
  }, [scrollRef, atLatest]);

  useEffect(() => {
    const scroll = scrollRef.current;
    const content = contentRef.current;
    if (!scroll || !content) return;
    lastSeenTop.current = scroll.scrollTop;
    const onWheel = (event: WheelEvent) => {
      // Remember a pixel wheel's tail intent across a delayed scroll event.
      wheelReachesTail.current =
        !event.defaultPrevented &&
        !event.ctrlKey &&
        !event.shiftKey &&
        event.deltaY > 0 &&
        event.deltaMode === WheelEvent.DOM_DELTA_PIXEL &&
        scroll.scrollTop + event.deltaY >=
          scroll.scrollHeight - scroll.clientHeight - 2;
    };
    const onScroll = (event: Event) => {
      const reachedWheelTail = wheelReachesTail.current;
      wheelReachesTail.current = false;
      // A nested code scroller can consume a wheel without moving this port.
      if (event.target !== scroll) return;
      const top = scroll.scrollTop;
      if (top < lastSeenTop.current - 1) {
        follow.current = false;
      } else if (
        scroll.scrollHeight - top - scroll.clientHeight <= 2 ||
        (reachedWheelTail && top > lastSeenTop.current + 1)
      ) {
        follow.current = true;
      }
      lastSeenTop.current = top;
      setAtLatest(follow.current);
    };
    const resize = () => {
      if (readyRef.current && follow.current) pinToLatest();
      setAtLatest(follow.current);
    };
    scroll.addEventListener('scroll', onScroll, {
      passive: true,
      capture: true,
    });
    scroll.addEventListener('wheel', onWheel, { passive: true });
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize);
    observer?.observe(content);
    observer?.observe(scroll);
    return () => {
      scroll.removeEventListener('scroll', onScroll, true);
      scroll.removeEventListener('wheel', onWheel);
      observer?.disconnect();
    };
  }, [scrollRef, contentRef, pinToLatest]);

  return {
    atLatest,
    jumpToLatest,
    pauseFollowing: () => {
      follow.current = false;
      wheelReachesTail.current = false;
      setAtLatest(false);
    },
  };
}
