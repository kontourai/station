/** @vitest-environment jsdom */

import { renderHook } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { useRevealOnce } from '../useRevealOnce';

describe('useRevealOnce', () => {
  test('first sight of an id returns the reveal class; a second component seeing the same id does not', () => {
    const first = renderHook(() => useRevealOnce('tool:first-sight'));
    expect(first.result.current).toBe('reveal-once');

    const second = renderHook(() => useRevealOnce('tool:first-sight'));
    expect(second.result.current).toBe('');
  });

  test('a different id reveals independently', () => {
    const first = renderHook(() => useRevealOnce('tool:independent-first'));
    expect(first.result.current).toBe('reveal-once');

    const other = renderHook(() => useRevealOnce('tool:independent-other'));
    expect(other.result.current).toBe('reveal-once');
  });

  test('re-renders of the first-sight instance keep the class so the animation is not cancelled', () => {
    const view = renderHook(({ id }: { id: string }) => useRevealOnce(id), {
      initialProps: { id: 'tool:rerender' },
    });
    expect(view.result.current).toBe('reveal-once');
    view.rerender({ id: 'tool:rerender' });
    expect(view.result.current).toBe('reveal-once');
  });

  test('DISCRIMINATING: unmount then remount of the same id must NOT replay the entrance', () => {
    // Virtualizer recycling / stream→history promotion / expand-collapse all
    // look like this to React: the component for an already-seen block is
    // unmounted and a fresh one mounts later with the same stable identity.
    const first = renderHook(() => useRevealOnce('tool:remount'));
    expect(first.result.current).toBe('reveal-once');
    first.unmount();

    const remounted = renderHook(() => useRevealOnce('tool:remount'));
    expect(remounted.result.current).toBe('');
  });

  test('a recycled instance whose id prop changes re-evaluates for the new id', () => {
    const view = renderHook(({ id }: { id: string }) => useRevealOnce(id), {
      initialProps: { id: 'tool:recycle-first' },
    });
    expect(view.result.current).toBe('reveal-once');

    // Same component instance now renders a different (unseen) row.
    view.rerender({ id: 'tool:recycle-other' });
    expect(view.result.current).toBe('reveal-once');

    // …and going back to the already-seen id does not replay.
    view.rerender({ id: 'tool:recycle-first' });
    expect(view.result.current).toBe('reveal-once');
    const fresh = renderHook(() => useRevealOnce('tool:recycle-first'));
    expect(fresh.result.current).toBe('');
  });

  test('a missing id never reveals (no stable identity, no once-promise)', () => {
    const view = renderHook(() => useRevealOnce(undefined));
    expect(view.result.current).toBe('');
  });
});
