import { useRef, useState } from 'react';

/**
 * station#3315 — hand-rolled pointer reorder for the project rail.
 *
 * No DnD dependency exists in this repo (checked before writing this), and the
 * in-repo reorder precedents are command/button driven (queued messages, pane
 * host tabs), so this stays minimal: a per-row drag handle captures the
 * pointer, the insertion index is derived from row midpoints, and the commit
 * is one call with the full reordered slug list. Keyboard access is the same
 * handle: ArrowUp/ArrowDown move the row one step per press, each announced
 * through a polite live region the caller renders (station#3331).
 *
 * There is deliberately NO focus-restore after a keyboard move. station#3331
 * predicted that the optimistic reorder of a keyed row list would relocate the
 * focused handle's DOM node and drop focus. A real-browser A/B against builds
 * with and without a restore disproved it in the two engines that were run —
 * Chromium and WebKit (Playwright's build, not the shipped Tauri WKWebView);
 * Gecko was not covered. React moves the existing node with `insertBefore`,
 * and moving a focused element inside the same document keeps it focused, so
 * consecutive Arrow presses land. Machinery for a loss that does not happen
 * would be a mechanism nothing derives.
 */

/** Splice semantics: remove `from`, insert at `to` (indexes in the current list). */
export function reorderedSlugs(
  slugs: readonly string[],
  from: number,
  to: number,
): string[] {
  const next = [...slugs];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/** Which edge of a row carries the insertion marker, or none. */
export type DropEdge = 'top' | 'bottom' | null;

/**
 * Where the insertion marker belongs, in the CURRENT (pre-drop) row indices.
 *
 * `targetIndex` returns a POST-removal insertion index, and rows render at
 * pre-removal indices — the two spaces differ by one for a downward drag,
 * because the dragged row is removed from ABOVE the target before the insert.
 * So `to` names the row the dragged row will land *after*, and the marker goes
 * on that row's BOTTOM edge; drawing it on the top edge put the line one row
 * higher than where the row actually landed. Upward the spaces coincide, so
 * the marker sits on the target row's top edge. `to === from` is not a move
 * and shows no marker.
 */
export function dropEdgeFor(from: number, to: number, index: number): DropEdge {
  if (to === from || index !== to) return null;
  return to > from ? 'bottom' : 'top';
}

export interface ProjectRowReorderProps {
  index: number;
  count: number;
  /** True while this row is the one being dragged. */
  dragging: boolean;
  /** Edge of THIS row the pending insertion marker sits on, if any. */
  dropEdge: DropEdge;
  handleProps: {
    onPointerDown: (event: React.PointerEvent<HTMLElement>) => void;
    onPointerMove: (event: React.PointerEvent<HTMLElement>) => void;
    onPointerUp: (event: React.PointerEvent<HTMLElement>) => void;
    onPointerCancel: (event: React.PointerEvent<HTMLElement>) => void;
    onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => void;
  };
  registerRow: (element: HTMLElement | null) => void;
}

export interface ProjectListReorderOptions {
  /**
   * Human name for a slug, used in the move announcement. Defaults to the
   * slug — a rail with no names is still better announced than not at all.
   */
  labelFor?: (slug: string) => string;
}

export function useProjectListReorder(
  slugs: readonly string[],
  commit: (order: string[]) => void,
  options?: ProjectListReorderOptions,
): {
  rowReorderProps: (index: number) => ProjectRowReorderProps;
  /**
   * Text for a polite live region announcing the last KEYBOARD move. Pointer
   * drags are self-announcing on screen and would spam the region.
   */
  announcement: string;
} {
  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null);
  // Mirror of `drag` for the pointer handlers: committing an order inside a
  // state-updater callback would be a side effect (double-invoked under
  // StrictMode), so handlers read the ref and render reads the state.
  const dragRef = useRef<{ from: number; to: number } | null>(null);
  const updateDrag = (value: { from: number; to: number } | null) => {
    dragRef.current = value;
    setDrag(value);
  };
  const rowsRef = useRef(new Map<number, HTMLElement>());
  const [announcement, setAnnouncement] = useState('');

  const move = (
    from: number,
    to: number,
    source: 'pointer' | 'keyboard' = 'pointer',
  ) => {
    if (to < 0 || to >= slugs.length || from === to) return;
    const slug = slugs[from];
    commit(reorderedSlugs(slugs, from, to));
    if (source !== 'keyboard') return;
    // Every Arrow move changes `to` by one, so consecutive announcements always
    // differ — a live region only re-announces on changed text.
    setAnnouncement(
      `${options?.labelFor?.(slug) ?? slug} moved to position ${to + 1} of ${slugs.length}`,
    );
  };

  // The insertion index for a pointer at `clientY`: how many OTHER rows have
  // their midpoint above it. This is exactly the index the dragged row lands
  // at after splice-removal, so edge positions need no special cases.
  const targetIndex = (from: number, clientY: number): number => {
    let to = 0;
    for (const [index, element] of rowsRef.current) {
      if (index === from) continue;
      const rect = element.getBoundingClientRect();
      if (clientY > rect.top + rect.height / 2) to += 1;
    }
    return to;
  };

  const rowReorderProps = (index: number): ProjectRowReorderProps => ({
    index,
    count: slugs.length,
    dragging: drag?.from === index,
    dropEdge: drag === null ? null : dropEdgeFor(drag.from, drag.to, index),
    registerRow: (element) => {
      if (element) rowsRef.current.set(index, element);
      else rowsRef.current.delete(index);
    },
    handleProps: {
      onPointerDown: (event) => {
        if (event.pointerType === 'mouse' && event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        updateDrag({ from: index, to: index });
      },
      onPointerMove: (event) => {
        const current = dragRef.current;
        if (current && current.from === index) {
          updateDrag({ from: index, to: targetIndex(index, event.clientY) });
        }
      },
      onPointerUp: (event) => {
        const current = dragRef.current;
        updateDrag(null);
        if (current && current.from === index) {
          const to = targetIndex(index, event.clientY);
          if (to !== index) move(index, to);
        }
      },
      onPointerCancel: () => updateDrag(null),
      onKeyDown: (event) => {
        if (event.key === 'ArrowUp') {
          event.preventDefault();
          move(index, index - 1, 'keyboard');
        } else if (event.key === 'ArrowDown') {
          event.preventDefault();
          move(index, index + 1, 'keyboard');
        }
      },
    },
  });

  return { rowReorderProps, announcement };
}
