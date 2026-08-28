import { describe, expect, test } from 'vitest';
import {
  clampPaneWidth,
  collapseSplitPaneState,
  expandSplitPaneState,
  framedBreadcrumbSegments,
  isSplitPaneMobile,
  parseSplitPaneState,
  resizePaneFromKeyboard,
  resizePaneFromPointer,
  SPLIT_PANE_DEFAULT_WIDTH,
  SPLIT_PANE_MAX_WIDTH,
  SPLIT_PANE_MIN_WIDTH,
  serializeSplitPaneState,
  shouldShowMobileDetailSheet,
  splitPaneStorageKey,
  visibleBreadcrumbSegments,
} from '../components/SplitPaneLayout.logic';

describe('SplitPaneLayout.logic', () => {
  test('builds the documented localStorage key', () => {
    expect(splitPaneStorageKey('models')).toBe('station:split-pane:models');
  });

  test('clamps resize widths to the skeleton range', () => {
    expect(clampPaneWidth(160)).toBe(SPLIT_PANE_MIN_WIDTH);
    expect(clampPaneWidth(312.6)).toBe(313);
    expect(clampPaneWidth(520)).toBe(SPLIT_PANE_MAX_WIDTH);
    expect(clampPaneWidth(Number.NaN)).toBe(SPLIT_PANE_DEFAULT_WIDTH);
  });

  test('derives width from pointer position and pane origin', () => {
    expect(resizePaneFromPointer(540, 200)).toBe(340);
    expect(resizePaneFromPointer(250, 100)).toBe(SPLIT_PANE_MIN_WIDTH);
  });

  test('derives keyboard resize widths with clamp boundaries', () => {
    expect(resizePaneFromKeyboard(280, 'ArrowRight')).toBe(296);
    expect(resizePaneFromKeyboard(280, 'ArrowLeft')).toBe(264);
    expect(resizePaneFromKeyboard(280, 'ArrowRight', { shiftKey: true })).toBe(
      320,
    );
    expect(resizePaneFromKeyboard(225, 'ArrowLeft')).toBe(SPLIT_PANE_MIN_WIDTH);
    expect(resizePaneFromKeyboard(410, 'ArrowRight')).toBe(
      SPLIT_PANE_MAX_WIDTH,
    );
    expect(resizePaneFromKeyboard(280, 'Home')).toBe(SPLIT_PANE_MIN_WIDTH);
    expect(resizePaneFromKeyboard(280, 'End')).toBe(SPLIT_PANE_MAX_WIDTH);
    expect(resizePaneFromKeyboard(280, 'Tab')).toBeNull();
  });

  test('parses persisted state with clamped width and fallback safety', () => {
    expect(parseSplitPaneState(null)).toEqual({
      width: SPLIT_PANE_DEFAULT_WIDTH,
      collapsed: false,
    });
    expect(parseSplitPaneState('{bad json')).toEqual({
      width: SPLIT_PANE_DEFAULT_WIDTH,
      collapsed: false,
    });
    expect(
      parseSplitPaneState(JSON.stringify({ width: 999, collapsed: true })),
    ).toEqual({
      width: SPLIT_PANE_MAX_WIDTH,
      collapsed: true,
    });
  });

  test('serializes persisted state through the same clamp', () => {
    expect(
      JSON.parse(serializeSplitPaneState({ width: 100, collapsed: true })),
    ).toEqual({
      width: SPLIT_PANE_MIN_WIDTH,
      collapsed: true,
    });
  });

  test('collapse and expand preserve width', () => {
    const state = { width: 330, collapsed: false };
    expect(collapseSplitPaneState(state)).toEqual({
      width: 330,
      collapsed: true,
    });
    expect(expandSplitPaneState({ width: 330, collapsed: true })).toEqual({
      width: 330,
      collapsed: false,
    });
  });

  test('classifies mobile breakpoint and detail sheet visibility', () => {
    expect(isSplitPaneMobile(768)).toBe(true);
    expect(isSplitPaneMobile(769)).toBe(false);
    expect(shouldShowMobileDetailSheet(true, 'item-1')).toBe(true);
    expect(shouldShowMobileDetailSheet(true, null)).toBe(false);
    expect(shouldShowMobileDetailSheet(true, null, true)).toBe(true);
    expect(shouldShowMobileDetailSheet(false, 'item-1')).toBe(false);
  });
});

/**
 * archive#2931 — the shell names the collection ONCE. A one-crumb trail that
 * restates the title is that name printed twice, one line apart (the shipped
 * `SESSIONS` above **Sessions**); a real multi-crumb breadcrumb is navigation
 * and is kept intact, current-page crumb included.
 */
describe('visibleBreadcrumbSegments', () => {
  test('drops a lone segment that restates the title', () => {
    expect(visibleBreadcrumbSegments('Sessions', 'Sessions')).toEqual([]);
  });

  test('matches case-insensitively and on collapsed whitespace', () => {
    expect(visibleBreadcrumbSegments('review queue', 'Review Queue')).toEqual(
      [],
    );
    expect(visibleBreadcrumbSegments('  Plugins  ', 'Plugins')).toEqual([]);
  });

  test('keeps a lone segment that says something the title does not', () => {
    expect(visibleBreadcrumbSegments('skills', 'Installed Skills')).toEqual([
      'skills',
    ]);
  });

  test('keeps a multi-segment breadcrumb even when the last crumb matches', () => {
    expect(
      visibleBreadcrumbSegments('Connections / Providers', 'Providers'),
    ).toEqual(['Connections', 'Providers']);
  });

  test('keeps a lone segment the view wired a breadcrumb link to', () => {
    expect(
      visibleBreadcrumbSegments('Sessions', 'Sessions', {
        sessions: () => {},
      }),
    ).toEqual(['Sessions']);
  });

  test('leaves an unrelated multi-segment breadcrumb untouched', () => {
    expect(
      visibleBreadcrumbSegments('connections / tools', 'Tool Servers'),
    ).toEqual(['connections', 'tools']);
  });
});

/**
 * archive#4463 — the FRAMED page header's
 * eyebrow. A top-level route gets no eyebrow at all (the retired
 * `AGENTS`-over-**Agents** pattern); a subpage's eyebrow is its parent only,
 * never a trail that restates the title a second time.
 */
describe('framedBreadcrumbSegments', () => {
  test('drops a lone segment that restates the title — no eyebrow for a top-level route', () => {
    expect(framedBreadcrumbSegments('agents', 'Agents')).toEqual([]);
    expect(framedBreadcrumbSegments('Activity', 'Activity')).toEqual([]);
    expect(framedBreadcrumbSegments('plugins', 'Plugins')).toEqual([]);
  });

  test('matches case-insensitively and on collapsed whitespace', () => {
    expect(framedBreadcrumbSegments('review', 'Review')).toEqual([]);
    expect(framedBreadcrumbSegments('  Plugins  ', 'Plugins')).toEqual([]);
  });

  test('keeps a lone segment that says something the title does not', () => {
    expect(framedBreadcrumbSegments('skills', 'Installed Skills')).toEqual([
      'skills',
    ]);
  });

  test('drops the trailing crumb that restates the title, keeping only the parent', () => {
    expect(
      framedBreadcrumbSegments('Connections / Engines', 'Engines'),
    ).toEqual(['Connections']);
    expect(
      framedBreadcrumbSegments('Connections / Providers', 'Providers'),
    ).toEqual(['Connections']);
  });

  test('keeps every segment when the last one does not restate the title', () => {
    expect(framedBreadcrumbSegments('Agents / my-agent', 'Tools')).toEqual([
      'Agents',
      'my-agent',
    ]);
  });
});
