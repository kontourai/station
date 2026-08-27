/** @vitest-environment jsdom */

import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, test } from 'vitest';
import { resetRevealedIdsForTest, useRevealOnce } from '../useRevealOnce';

describe('useRevealOnce', () => {
  beforeEach(() => resetRevealedIdsForTest());

  test('first sight of an id returns the reveal class; a second component seeing the same id does not', () => {
    const first = renderHook(() => useRevealOnce('tool:call-1'));
    expect(first.result.current).toBe('reveal-once');

    const second = renderHook(() => useRevealOnce('tool:call-1'));
    expect(second.result.current).toBe('');
  });

  test('a different id reveals independently', () => {
    const first = renderHook(() => useRevealOnce('tool:call-1'));
    expect(first.result.current).toBe('reveal-once');

    const other = renderHook(() => useRevealOnce('tool:call-2'));
    expect(other.result.current).toBe('reveal-once');
  });

  test('re-renders of the first-sight instance keep the class so the animation is not cancelled', () => {
    const view = renderHook(({ id }: { id: string }) => useRevealOnce(id), {
      initialProps: { id: 'tool:call-1' },
    });
    expect(view.result.current).toBe('reveal-once');
    view.rerender({ id: 'tool:call-1' });
    expect(view.result.current).toBe('reveal-once');
  });

  test('DISCRIMINATING: unmount then remount of the same id must NOT replay the entrance', () => {
    // Virtualizer recycling / stream→history promotion / expand-collapse all
    // look like this to React: the component for an already-seen block is
    // unmounted and a fresh one mounts later with the same stable identity.
    const first = renderHook(() => useRevealOnce('tool:call-1'));
    expect(first.result.current).toBe('reveal-once');
    first.unmount();

    const remounted = renderHook(() => useRevealOnce('tool:call-1'));
    expect(remounted.result.current).toBe('');
  });

  test('a recycled instance whose id prop changes re-evaluates for the new id', () => {
    const view = renderHook(({ id }: { id: string }) => useRevealOnce(id), {
      initialProps: { id: 'tool:call-1' },
    });
    expect(view.result.current).toBe('reveal-once');

    // Same component instance now renders a different (unseen) row.
    view.rerender({ id: 'tool:call-2' });
    expect(view.result.current).toBe('reveal-once');

    // …and going back to the already-seen id does not replay.
    view.rerender({ id: 'tool:call-1' });
    expect(view.result.current).toBe('reveal-once'); // this instance was call-1's first sight
    const fresh = renderHook(() => useRevealOnce('tool:call-1'));
    expect(fresh.result.current).toBe('');
  });

  test('a missing id never reveals (no stable identity, no once-promise)', () => {
    const view = renderHook(() => useRevealOnce(undefined));
    expect(view.result.current).toBe('');
  });
});
