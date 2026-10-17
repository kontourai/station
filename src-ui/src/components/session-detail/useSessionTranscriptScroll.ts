import {
  type RefObject,
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
  const reader = useRef(identity);
  const readyRef = useRef(ready);
  readyRef.current = ready;
  const preserving = useRef(preserveReading);
  const [atLatest, setAtLatest] = useState(true);

  const jumpToLatest = () => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    follow.current = true;
    scroll.scrollTop = scroll.scrollHeight;
    setAtLatest(true);
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: A transcript update changes the committed scroll height even when reader identity and readiness stay the same.
  useLayoutEffect(() => {
    if (reader.current !== identity) {
      reader.current = identity;
      follow.current = !preserveReading;
    }
    if (preserveReading && !preserving.current) follow.current = false;
    preserving.current = preserveReading;
    const scroll = scrollRef.current;
    if (!scroll || !ready) return;
    if (follow.current) scroll.scrollTop = scroll.scrollHeight;
    setAtLatest(
      scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 64,
    );
  }, [identity, ready, contentVersion, preserveReading, scrollRef]);

  useEffect(() => {
    const scroll = scrollRef.current;
    const content = contentRef.current;
    if (!scroll || !content) return;
    let readerUntil = 0;
    let resumeTimer: ReturnType<typeof setTimeout> | undefined;
    const onScroll = () => {
      const latest =
        scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 64;
      const atBottom =
        scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight <= 2;
      follow.current = atBottom && performance.now() >= readerUntil;
      clearTimeout(resumeTimer);
      if (atBottom && !follow.current) {
        resumeTimer = setTimeout(onScroll, readerUntil - performance.now());
      }
      setAtLatest(latest);
    };
    const stopFollowing = () => {
      readerUntil = performance.now() + 200;
      clearTimeout(resumeTimer);
      follow.current = false;
    };
    const resize = () => {
      if (readyRef.current && follow.current) {
        scroll.scrollTop = scroll.scrollHeight;
      }
      setAtLatest(
        scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 64,
      );
    };
    scroll.addEventListener('scroll', onScroll, { passive: true });
    scroll.addEventListener('wheel', stopFollowing, { passive: true });
    scroll.addEventListener('touchstart', stopFollowing, { passive: true });
    scroll.addEventListener('pointerdown', stopFollowing, { passive: true });
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize);
    observer?.observe(content);
    observer?.observe(scroll);
    return () => {
      clearTimeout(resumeTimer);
      scroll.removeEventListener('scroll', onScroll);
      scroll.removeEventListener('wheel', stopFollowing);
      scroll.removeEventListener('touchstart', stopFollowing);
      scroll.removeEventListener('pointerdown', stopFollowing);
      observer?.disconnect();
    };
  }, [scrollRef, contentRef]);

  return {
    atLatest,
    jumpToLatest,
    pauseFollowing: () => {
      follow.current = false;
    },
  };
}
