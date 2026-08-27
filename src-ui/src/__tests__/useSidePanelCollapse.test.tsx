/**
 * @vitest-environment jsdom
 */

import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, test } from 'vitest';
import { useSidePanelCollapse } from '../hooks/useSidePanelCollapse';

const KEY = 'station-side-panel-collapsed:proj:code';

beforeEach(() => {
  localStorage.clear();
});

describe('useSidePanelCollapse', () => {
  test('defaults collapsed when nothing is configured', () => {
    const { result } = renderHook(() =>
      useSidePanelCollapse('proj', 'code', true),
    );
    expect(result.current.collapsed).toBe(true);
  });

  test('defaults expanded when at least one tool is configured', () => {
    const { result } = renderHook(() =>
      useSidePanelCollapse('proj', 'code', false),
    );
    expect(result.current.collapsed).toBe(false);
  });

  test('re-applies the default when it resolves asynchronously', () => {
    // Start collapsed (nothing configured yet), then a query resolves and the
    // default flips to expanded — with no explicit user choice yet, the panel
    // follows the new default.
    const { result, rerender } = renderHook(
      ({ def }: { def: boolean }) => useSidePanelCollapse('proj', 'code', def),
      { initialProps: { def: true } },
    );
    expect(result.current.collapsed).toBe(true);
    rerender({ def: false });
    expect(result.current.collapsed).toBe(false);
  });

  test('toggle persists the choice and survives remount', () => {
    const { result, unmount } = renderHook(() =>
      useSidePanelCollapse('proj', 'code', false),
    );
    act(() => result.current.toggle());
    expect(result.current.collapsed).toBe(true);
    expect(localStorage.getItem(KEY)).toBe('true');
    unmount();

    // Remount with a default that disagrees — the stored explicit choice wins.
    const { result: result2 } = renderHook(() =>
      useSidePanelCollapse('proj', 'code', false),
    );
    expect(result2.current.collapsed).toBe(true);
  });

  test('an explicit choice is sticky even when the default later changes', () => {
    const { result, rerender } = renderHook(
      ({ def }: { def: boolean }) => useSidePanelCollapse('proj', 'code', def),
      { initialProps: { def: true } },
    );
    // User explicitly expands.
    act(() => result.current.setCollapsed(false));
    expect(result.current.collapsed).toBe(false);
    // A later default flip to collapsed must NOT override the user choice.
    rerender({ def: true });
    expect(result.current.collapsed).toBe(false);
  });

  test('keys are scoped per project + layout', () => {
    const { result } = renderHook(() =>
      useSidePanelCollapse('proj', 'code', false),
    );
    act(() => result.current.toggle());
    expect(localStorage.getItem(KEY)).toBe('true');
    expect(
      localStorage.getItem('station-side-panel-collapsed:other:code'),
    ).toBeNull();
  });
});
