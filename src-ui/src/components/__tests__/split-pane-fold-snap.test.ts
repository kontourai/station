import { describe, expect, it } from 'vitest';
import {
  FOLD_SNAP_MIN_DETAIL,
  FOLD_SNAP_MIN_LIST,
  foldSnappedListWidth,
} from '../split-pane-metrics';

const open = { stacked: false, collapsed: false };
const vertical = (start: number, end: number) => ({
  axis: 'vertical' as const,
  start,
  end,
});

describe('foldSnappedListWidth', () => {
  it('gives the list exactly the room before a vertical crease', () => {
    // A Book-posture Duo with the sidebar open: 455.5 - 216.
    expect(foldSnappedListWidth(vertical(240, 456), open)).toBe(240);
  });

  it('pins the floors it documents', () => {
    expect(FOLD_SNAP_MIN_LIST).toBe(200);
    expect(FOLD_SNAP_MIN_DETAIL).toBe(280);
    expect(foldSnappedListWidth(vertical(199, 500), open)).toBeNull();
    expect(foldSnappedListWidth(vertical(200, 279), open)).toBeNull();
    expect(foldSnappedListWidth(vertical(200, 280), open)).toBe(200);
  });

  it('leaves stacked, collapsed, horizontal and absent folds alone', () => {
    expect(
      foldSnappedListWidth(vertical(300, 400), { ...open, stacked: true }),
    ).toBeNull();
    expect(
      foldSnappedListWidth(vertical(300, 400), { ...open, collapsed: true }),
    ).toBeNull();
    expect(
      foldSnappedListWidth({ axis: 'horizontal', start: 300, end: 400 }, open),
    ).toBeNull();
    expect(foldSnappedListWidth(null, open)).toBeNull();
  });
});
