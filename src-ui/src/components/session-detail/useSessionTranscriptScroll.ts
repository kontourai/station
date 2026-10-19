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
  const readerReachesTail = useRef(false);
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
    readerReachesTail.current = false;
    pinToLatest();
    setAtLatest(true);
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: Transcript commits and the Jump toolbar changing visibility can change scroll height.
  useLayoutEffect(() => {
    if (reader.current !== identity) {
      reader.current = identity;
      follow.current = !preserveReading;
      readerReachesTail.current = false;
    }
    if (preserveReading && !preserving.current) {
      follow.current = false;
      readerReachesTail.current = false;
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
    let lastSeenHeight = scroll.scrollHeight;
    let observedHeight = lastSeenHeight;
    let lastGrowthDelta = 0;
    const measureHeight = () => {
      const height = scroll.scrollHeight;
      if (height !== observedHeight) {
        lastGrowthDelta = Math.max(0, height - observedHeight);
        observedHeight = height;
      }
      return height;
    };
    const beginReaderInput = () => {
      // Only growth after this input can explain arriving at an outdated tail.
      readerReachesTail.current = false;
      measureHeight();
      lastGrowthDelta = 0;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      beginReaderInput();
      readerReachesTail.current =
        event.target === scroll &&
        !event.defaultPrevented &&
        event.key === 'End';
    };
    const onWheel = (event: WheelEvent) => {
      beginReaderInput();
      // Remember a pixel wheel's tail intent across a delayed scroll event.
      readerReachesTail.current =
        !event.defaultPrevented &&
        !event.ctrlKey &&
        !event.shiftKey &&
        event.deltaY > 0 &&
        event.deltaMode === WheelEvent.DOM_DELTA_PIXEL &&
        scroll.scrollTop + event.deltaY >=
          scroll.scrollHeight - scroll.clientHeight - 2;
    };
    const onScroll = (event: Event) => {
      const reachedReaderTail = readerReachesTail.current;
      readerReachesTail.current = false;
      // A nested code scroller can consume a wheel without moving this port.
      if (event.target !== scroll) return;
      const top = scroll.scrollTop;
      const height = measureHeight();
      const distance = height - top - scroll.clientHeight;
      // Native anchoring can move a paused reader down by exactly the growth.
      const anchored =
        height > lastSeenHeight &&
        Math.abs(top - lastSeenTop.current - (height - lastSeenHeight)) <= 1;
      if (distance <= 2) {
        follow.current = true;
      } else if (top < lastSeenTop.current - 1) {
        follow.current = false;
      } else if (
        top > lastSeenTop.current + 1 &&
        (reachedReaderTail || (!anchored && distance <= lastGrowthDelta + 2))
      ) {
        follow.current = true;
        pinToLatest();
      }
      lastSeenTop.current = scroll.scrollTop;
      lastSeenHeight = scroll.scrollHeight;
      setAtLatest(follow.current);
    };
    const resize = () => {
      measureHeight();
      if (readyRef.current && follow.current) pinToLatest();
      setAtLatest(follow.current);
    };
    scroll.addEventListener('scroll', onScroll, {
      passive: true,
      capture: true,
    });
    scroll.addEventListener('wheel', onWheel, { passive: true });
    scroll.addEventListener('keydown', onKeyDown);
    scroll.addEventListener('pointerdown', beginReaderInput, { passive: true });
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize);
    const observeContent = () => {
      observer?.disconnect();
      observer?.observe(scroll);
      observer?.observe(content);
      // Errors, attention and Details share the port, outside the transcript.
      for (const child of scroll.children) observer?.observe(child);
    };
    observeContent();
    const children = new MutationObserver(observeContent);
    children.observe(scroll, { childList: true });
    return () => {
      scroll.removeEventListener('scroll', onScroll, true);
      scroll.removeEventListener('wheel', onWheel);
      scroll.removeEventListener('keydown', onKeyDown);
      scroll.removeEventListener('pointerdown', beginReaderInput);
      observer?.disconnect();
      children.disconnect();
    };
  }, [scrollRef, contentRef, pinToLatest]);

  return {
    atLatest,
    jumpToLatest,
    pauseFollowing: () => {
      follow.current = false;
      readerReachesTail.current = false;
      setAtLatest(false);
    },
  };
}
