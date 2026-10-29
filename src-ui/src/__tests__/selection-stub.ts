import { vi } from 'vitest';

/**
 * Selects `node`'s text and lays the selection out at `rect`, since jsdom
 * computes no geometry and `wantsNativeContextMenu` asks whether the press
 * landed ON the selected text. Undo with `vi.restoreAllMocks()` and
 * `removeAllRanges()`.
 */
export function selectTextAt(
  node: Node,
  rect: { left: number; top: number; right: number; bottom: number },
) {
  const range = document.createRange();
  range.selectNodeContents(node);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  const domRect = {
    ...rect,
    x: rect.left,
    y: rect.top,
    width: rect.right - rect.left,
    height: rect.bottom - rect.top,
    toJSON: () => rect,
  } as DOMRect;
  if (!('getClientRects' in Range.prototype)) {
    Object.defineProperty(Range.prototype, 'getClientRects', {
      value: () => [],
      configurable: true,
      writable: true,
    });
  }
  vi.spyOn(Range.prototype, 'getClientRects').mockReturnValue([
    domRect,
  ] as unknown as DOMRectList);
}
