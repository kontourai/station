import { describe, expect, it } from 'vitest';
import {
  buildToastStackLayout,
  selectToastStackItems,
  shouldHideCollapsedToastContent,
  TOAST_STACK_VISIBLE_CAP,
} from '../components/notifications/toast-stack-layout';

describe('toast-stack-layout', () => {
  it('does not hide content when only one toast is visible', () => {
    expect(shouldHideCollapsedToastContent(0, 1)).toBe(false);
  });

  it('hides collapsed content for every card behind the front', () => {
    expect(shouldHideCollapsedToastContent(0, 3)).toBe(false);
    expect(shouldHideCollapsedToastContent(1, 3)).toBe(true);
    expect(shouldHideCollapsedToastContent(2, 3)).toBe(true);
  });

  it('builds descending z-index and increasing offset by depth', () => {
    const layout = buildToastStackLayout(3);
    expect(layout.map((item) => item.depth)).toEqual([0, 1, 2]);
    expect(layout[0]!.offsetY).toBe(0);
    expect(layout[1]!.offsetY).toBeGreaterThan(0);
    expect(layout[2]!.offsetY).toBeGreaterThan(layout[1]!.offsetY);
    expect(layout[0]!.zIndex).toBeGreaterThan(layout[1]!.zIndex);
    expect(layout[0]!.scale).toBe(1);
    expect(layout[1]!.scale).toBeLessThan(1);
  });

  it('caps the visible stack to TOAST_STACK_VISIBLE_CAP keeping the front items', () => {
    const items = Array.from(
      { length: TOAST_STACK_VISIBLE_CAP + 3 },
      (_, i) => i,
    );
    const selected = selectToastStackItems(items);
    expect(selected).toHaveLength(TOAST_STACK_VISIBLE_CAP);
    expect(selected[0]).toBe(0);
    expect(selected.at(-1)).toBe(TOAST_STACK_VISIBLE_CAP - 1);
  });
});
