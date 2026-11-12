import { type RefObject, useCallback, useLayoutEffect } from 'react';

/**
 * Where each Project's channel list was scrolled when the reader opened a
 * conversation from it, for this page session (#4795). The list and the
 * conversation share one scrolling page, so the browser cannot restore it.
 */
const listScroll = new Map<string, { scroller: Element; top: number }>();

/**
 * The element that actually scrolls the Project page: the nearest ancestor
 * (the page itself included) whose content overflows a scrollable box. Which
 * one that is depends on the shell — on a phone the page grows and the
 * shell's main region scrolls — so it is found, not assumed.
 */
function scrollerOf(element: HTMLElement | null): Element | null {
  for (let node = element; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if (
      (overflowY === 'auto' || overflowY === 'scroll') &&
      node.scrollHeight > node.clientHeight
    )
      return node;
  }
  return document.scrollingElement;
}

/**
 * A phone's Project page keeps its channel list's place across a pushed
 * conversation: `openFromList` records the scroll position before it opens,
 * the conversation starts at the top, and the list returns to the recorded
 * position when it is shown again (Back, or the room's back button).
 */
export function useListScrollMemory(
  key: string,
  pageRef: RefObject<HTMLElement | null>,
  listShown: boolean,
  screenShown: boolean,
) {
  useLayoutEffect(() => {
    const saved = listScroll.get(key);
    if (screenShown) {
      // The element that held the list's offset, which the shorter screen
      // may no longer overflow.
      const scroller = saved?.scroller ?? scrollerOf(pageRef.current);
      if (scroller) scroller.scrollTop = 0;
      return;
    }
    if (!listShown || !saved) return;
    listScroll.delete(key);
    saved.scroller.scrollTop = saved.top;
  }, [key, listShown, screenShown, pageRef]);
  const openFromList = useCallback(
    (open: () => void) => {
      const scroller = scrollerOf(pageRef.current);
      if (listShown && scroller)
        listScroll.set(key, { scroller, top: scroller.scrollTop });
      open();
    },
    [key, listShown, pageRef],
  );
  return { openFromList };
}
