import { describe, expect, test } from 'vitest';
import {
  DEFAULT_DEVICE_REGION_ARRANGEMENT,
  type RegionArrangement,
  restoreSuspendedPanes,
  withSuspendedSurfaces,
} from '../regions/region-model';

const CHAT = ['chat'] as const;

function withBottom(
  bottom: Partial<RegionArrangement['bottom']>,
): RegionArrangement {
  return {
    ...DEFAULT_DEVICE_REGION_ARRANGEMENT,
    bottom: { ...DEFAULT_DEVICE_REGION_ARRANGEMENT.bottom, ...bottom },
  };
}

/**
 * The read view the region shells get while the Coding layout's centre owns
 * Chat. Chat is not rendered there, and nothing the user placed moves.
 */
describe('withSuspendedSurfaces', () => {
  test('a region holding only Chat is hidden and empty, however it was shown', () => {
    const real = withBottom({ visible: true, maximized: true });
    const view = withSuspendedSurfaces(real, CHAT);
    expect(view.bottom).toEqual({
      ...real.bottom,
      panes: [],
      occupant: null,
      visible: false,
      maximized: false,
    });
    // The real arrangement is untouched — the record is written from it.
    expect(real.bottom.panes).toEqual(['chat']);
  });

  test('Chat selected beside Terminal shows Terminal, and drops Chat’s maximize', () => {
    const view = withSuspendedSurfaces(
      withBottom({
        visible: true,
        panes: ['terminal', 'chat', 'activity'],
        occupant: 'chat',
        maximized: true,
      }),
      CHAT,
    );
    expect(view.bottom).toMatchObject({
      visible: true,
      panes: ['terminal', 'activity'],
      // The tab after Chat, as a close would select.
      occupant: 'activity',
      maximized: false,
    });
  });

  test('Chat behind another tab leaves that tab, its visibility and its maximize alone', () => {
    const view = withSuspendedSurfaces(
      withBottom({
        visible: true,
        panes: ['chat', 'activity'],
        occupant: 'activity',
        maximized: true,
      }),
      CHAT,
    );
    expect(view.bottom).toMatchObject({
      visible: true,
      panes: ['activity'],
      occupant: 'activity',
      maximized: true,
    });
  });

  test('regions without Chat keep their identity; no suspension is the input itself', () => {
    const real = withBottom({ visible: true });
    const view = withSuspendedSurfaces(real, CHAT);
    expect(view.left).toBe(real.left);
    expect(view.right).toBe(real.right);
    expect(view.main).toBe(real.main);
    expect(withSuspendedSurfaces(real, [])).toBe(real);
  });
});

describe('restoreSuspendedPanes', () => {
  test('a reorder made in the suspended view keeps Chat where it was', () => {
    expect(
      restoreSuspendedPanes(
        ['terminal', 'chat', 'activity'],
        ['activity', 'terminal'],
        CHAT,
      ),
    ).toEqual(['activity', 'chat', 'terminal']);
    expect(
      restoreSuspendedPanes(
        ['terminal', 'activity', 'chat'],
        ['activity', 'terminal'],
        CHAT,
      ),
    ).toEqual(['activity', 'terminal', 'chat']);
  });
});
