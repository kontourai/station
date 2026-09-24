/**
 * The phone layer's pure half (`openPhonePaneLayer` / `restorePhonePaneLayer`
 * in region-model.ts): on a bottom-only device a pane opens OVER Chat as a
 * selected tab of Chat's region, and the way back returns the region to what
 * it showed. The provider half — the history entry, Back, the "‹ Chat"
 * control — is `RegionModelContext-phone-layer.test.tsx`.
 */

import { describe, expect, test } from 'vitest';
import {
  DEFAULT_DEVICE_REGION_ARRANGEMENT,
  openPhonePaneLayer,
  placeSurface,
  type RegionArrangement,
  removeRegionPane,
  restorePhonePaneLayer,
  updateRegion,
} from '../regions/region-model';

const PR = 'pr:github.com/kontourai/station#2049';
const OTHER_PR = 'pr:github.com/kontourai/station#2050';

/** A phone reading a conversation: Chat alone in a visible, docked bottom. */
function chatShowing(): RegionArrangement {
  return updateRegion(DEFAULT_DEVICE_REGION_ARRANGEMENT, 'bottom', {
    visible: true,
  });
}

const OPEN = {
  lastShownRegion: 'bottom',
  maximize: true,
  layer: null,
} as const;

describe('openPhonePaneLayer', () => {
  test('puts the pane in Chat’s region as a selected, maximized tab, with Chat kept behind it', () => {
    const opened = openPhonePaneLayer(chatShowing(), PR, OPEN);
    expect(opened).not.toBeNull();
    expect(opened?.arrangement.bottom).toMatchObject({
      panes: ['chat', PR],
      occupant: PR,
      visible: true,
      maximized: true,
    });
    // Nothing else moved, and no other region was folded away.
    expect(opened?.arrangement.right).toEqual(chatShowing().right);
    expect(opened?.layer).toEqual({
      region: 'bottom',
      surfaceId: PR,
      mintedTab: true,
      previous: { selected: 'chat', maximized: false, visible: true },
    });
  });

  test('without `maximize` (a wide coarse device) the region keeps its size', () => {
    const opened = openPhonePaneLayer(chatShowing(), PR, {
      ...OPEN,
      maximize: false,
    });
    expect(opened?.arrangement.bottom.maximized).toBe(false);
    expect(opened?.arrangement.bottom.occupant).toBe(PR);
  });

  test('follows Chat to whichever region holds it', () => {
    const chatRight = placeSurface(chatShowing(), 'chat', 'right');
    const opened = openPhonePaneLayer(chatRight, PR, OPEN);
    expect(opened?.layer.region).toBe('right');
    expect(opened?.arrangement.right).toMatchObject({
      panes: ['chat', PR],
      occupant: PR,
    });
  });

  test('a pane held in another region moves over Chat and counts as minted', () => {
    const heldRight = placeSurface(chatShowing(), PR, 'right');
    const withChatShown = updateRegion(heldRight, 'bottom', {
      visible: true,
      occupant: 'chat',
    });
    const opened = openPhonePaneLayer(withChatShown, PR, OPEN);
    expect(opened?.arrangement.right.panes).toEqual([]);
    expect(opened?.arrangement.bottom.panes).toEqual(['chat', PR]);
    expect(opened?.layer.mintedTab).toBe(true);
  });

  test('a pane already in Chat’s region is selected, not minted', () => {
    const joined = updateRegion(chatShowing(), 'bottom', {
      panes: ['chat', PR],
      occupant: 'chat',
    });
    const opened = openPhonePaneLayer(joined, PR, OPEN);
    expect(opened?.layer.mintedTab).toBe(false);
    expect(opened?.arrangement.bottom.panes).toEqual(['chat', PR]);
    expect(opened?.arrangement.bottom.occupant).toBe(PR);
  });

  test('a second open replaces the layer’s minted pane and keeps the ORIGINAL previous', () => {
    const first = openPhonePaneLayer(chatShowing(), PR, OPEN);
    if (!first) throw new Error('first open did not apply');
    const second = openPhonePaneLayer(first.arrangement, OTHER_PR, {
      ...OPEN,
      layer: first.layer,
    });
    expect(second?.arrangement.bottom).toMatchObject({
      panes: ['chat', OTHER_PR],
      occupant: OTHER_PR,
      maximized: true,
    });
    // The previous is the pre-layer Chat, not the first pane.
    expect(second?.layer.previous).toEqual(first.layer.previous);
    expect(second?.layer.mintedTab).toBe(true);
  });

  test('does not apply to Chat, nor to a surface that cannot occupy Chat’s region', () => {
    expect(openPhonePaneLayer(chatShowing(), 'chat', OPEN)).toBeNull();
    // Home declares `main` only.
    expect(openPhonePaneLayer(chatShowing(), 'home', OPEN)).toBeNull();
  });
});

describe('restorePhonePaneLayer', () => {
  test('Back: Chat is selected again, the region restored, and the minted tab removed', () => {
    const before = chatShowing();
    const opened = openPhonePaneLayer(before, PR, OPEN);
    if (!opened) throw new Error('open did not apply');
    const restored = restorePhonePaneLayer(opened.arrangement, opened.layer);
    expect(restored.bottom).toEqual(before.bottom);
  });

  test('a maximized Chat comes back maximized', () => {
    const before = updateRegion(chatShowing(), 'bottom', { maximized: true });
    const opened = openPhonePaneLayer(before, PR, OPEN);
    if (!opened) throw new Error('open did not apply');
    expect(
      restorePhonePaneLayer(opened.arrangement, opened.layer).bottom,
    ).toEqual(before.bottom);
  });

  test('a hidden Chat region is hidden again', () => {
    const before = DEFAULT_DEVICE_REGION_ARRANGEMENT;
    const opened = openPhonePaneLayer(before, PR, OPEN);
    if (!opened) throw new Error('open did not apply');
    expect(opened.arrangement.bottom.visible).toBe(true);
    expect(
      restorePhonePaneLayer(opened.arrangement, opened.layer).bottom,
    ).toEqual(before.bottom);
  });

  test('a pane that was already a tab stays a tab behind Chat', () => {
    const joined = updateRegion(chatShowing(), 'bottom', {
      panes: ['chat', PR],
      occupant: 'chat',
    });
    const opened = openPhonePaneLayer(joined, PR, OPEN);
    if (!opened) throw new Error('open did not apply');
    expect(
      restorePhonePaneLayer(opened.arrangement, opened.layer).bottom,
    ).toEqual(joined.bottom);
  });

  test('after the user already switched to Chat, only the minted tab and the maximize are undone', () => {
    const opened = openPhonePaneLayer(chatShowing(), PR, OPEN);
    if (!opened) throw new Error('open did not apply');
    const switched = updateRegion(opened.arrangement, 'bottom', {
      occupant: 'chat',
    });
    expect(restorePhonePaneLayer(switched, opened.layer).bottom).toMatchObject({
      panes: ['chat'],
      occupant: 'chat',
      visible: true,
      maximized: false,
    });
  });

  test('after the user hid the region, it stays hidden', () => {
    const opened = openPhonePaneLayer(chatShowing(), PR, OPEN);
    if (!opened) throw new Error('open did not apply');
    const hidden = updateRegion(opened.arrangement, 'bottom', {
      visible: false,
    });
    expect(restorePhonePaneLayer(hidden, opened.layer).bottom).toMatchObject({
      panes: ['chat'],
      visible: false,
    });
  });

  test('after the user closed the pane’s tab, the maximize the layer added is undone', () => {
    const opened = openPhonePaneLayer(chatShowing(), PR, OPEN);
    if (!opened) throw new Error('open did not apply');
    const closed = removeRegionPane(opened.arrangement, 'bottom', PR);
    expect(restorePhonePaneLayer(closed, opened.layer).bottom).toEqual(
      chatShowing().bottom,
    );
  });
});
