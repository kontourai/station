import { type RefObject, useCallback, useLayoutEffect } from 'react';

/**
 * Where each Project's channel list was scrolled when the reader opened a
 * conversation from it, for this page session (#4795). The list and the
 * conversation share one scrolling page, so the browser cannot restore it.
 */
const listScroll = new Map<string, number>();

/**
 * A phone's Project page keeps its channel list's place across a pushed
 * conversation: `openFromList` records the scroll position before it opens,
 * the conversation starts at the top, and the list returns to the recorded
 * position when it is shown again (Back, or the room's back button).
 */
export function useListScrollMemory(
  key: string,
  scrollerRef: RefObject<HTMLElement | null>,
  listShown: boolean,
  screenShown: boolean,
) {
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    if (screenShown) {
      scroller.scrollTop = 0;
      return;
    }
    if (!listShown) return;
    const saved = listScroll.get(key);
    if (saved === undefined) return;
    listScroll.delete(key);
    scroller.scrollTop = saved;
  }, [key, listShown, screenShown, scrollerRef]);
  const openFromList = useCallback(
    (open: () => void) => {
      const scroller = scrollerRef.current;
      if (listShown && scroller) listScroll.set(key, scroller.scrollTop);
      open();
    },
    [key, listShown, scrollerRef],
  );
  return { openFromList };
}
