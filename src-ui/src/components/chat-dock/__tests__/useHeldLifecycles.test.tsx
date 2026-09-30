/** @vitest-environment jsdom */
import { act, cleanup, render, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { HomeLifecycleLabel } from '../../../utils/lifecycle-priority';
import type { HomeWorkItem } from '../../../views/home/home-view-model';
import { LifecycleStatusChip } from '../../home/LifecycleStatusChip';
import { groupMobileActivity } from '../mobile-activity-groups';
import { LIFECYCLE_HOLD_MS, useHeldLifecycles } from '../useHeldLifecycles';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const item = (id: string, lifecycleLabel: HomeLifecycleLabel) =>
  ({ id, lifecycleLabel }) as HomeWorkItem;

describe('useHeldLifecycles — no row jumps from status churn', () => {
  test('a blip back and forth never reaches the list', () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(
      ({ items }) => useHeldLifecycles(items),
      { initialProps: { items: [item('a', 'Running'), item('b', 'Ready')] } },
    );
    const shown: string[] = [];
    rerender({ items: [item('a', 'Ready'), item('b', 'Ready')] });
    shown.push(result.current[0]!.lifecycleLabel);
    act(() => {
      vi.advanceTimersByTime(400);
    });
    shown.push(result.current[0]!.lifecycleLabel);
    rerender({ items: [item('a', 'Running'), item('b', 'Ready')] });
    shown.push(result.current[0]!.lifecycleLabel);
    act(() => {
      vi.advanceTimersByTime(LIFECYCLE_HOLD_MS * 2);
    });
    shown.push(result.current[0]!.lifecycleLabel);
    expect(shown).toEqual(['Running', 'Running', 'Running', 'Running']);
  });

  test('a change that holds is shown once the hold elapses', () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(
      ({ items }) => useHeldLifecycles(items),
      { initialProps: { items: [item('a', 'Running')] } },
    );
    rerender({ items: [item('a', 'Completed')] });
    expect(result.current[0]!.lifecycleLabel).toBe('Running');
    act(() => {
      vi.advanceTimersByTime(LIFECYCLE_HOLD_MS);
    });
    expect(result.current[0]!.lifecycleLabel).toBe('Completed');
  });

  test('a state that asks the user to act is shown at once', () => {
    const { result, rerender } = renderHook(
      ({ items }) => useHeldLifecycles(items),
      { initialProps: { items: [item('a', 'Running')] } },
    );
    rerender({ items: [item('a', 'Needs attention')] });
    expect(result.current[0]!.lifecycleLabel).toBe('Needs attention');
    rerender({ items: [item('a', 'Failed')] });
    expect(result.current[0]!.lifecycleLabel).toBe('Failed');
  });

  test('with nothing held the same array comes back, so grouping memoizes', () => {
    const items = [item('a', 'Running'), item('b', 'Completed')];
    const { result, rerender } = renderHook(
      ({ list }) => useHeldLifecycles(list),
      { initialProps: { list: items } },
    );
    expect(result.current).toBe(items);
    rerender({ list: items });
    expect(result.current).toBe(items);
  });
});

/** The row's lane as the dock inbox and mobile switcher compute it. */
function useLaneOf(items: HomeWorkItem[], id: string): string | undefined {
  const groups = groupMobileActivity(useHeldLifecycles(items), 0);
  return groups.find((g) => g.items.some((i) => i.id === id))?.id;
}

const row = (lifecycleLabel: HomeLifecycleLabel) =>
  ({
    id: 'a',
    kind: 'chat',
    kindLabel: 'Direct chat',
    title: 't',
    projectLabel: 'p',
    agentLabel: 'a',
    modelLabel: 'm',
    updatedAt: 0,
    lifecycleLabel,
  }) as HomeWorkItem;

describe('held lifecycles through the Needs you / Running / Idle lanes', () => {
  test('Needs you is never delayed, entering or leaving', () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(
      ({ items }) => useLaneOf(items, 'a'),
      { initialProps: { items: [row('Running')] } },
    );
    expect(result.current).toBe('running');
    rerender({ items: [row('Needs attention')] });
    expect(result.current).toBe('needsYou');
    // Answered: back to Running on the same render, never a stale ask.
    rerender({ items: [row('Running')] });
    expect(result.current).toBe('running');
    rerender({ items: [row('Ready')] });
    rerender({ items: [row('Needs attention')] });
    expect(result.current).toBe('needsYou');
  });

  test('Running -> Idle holds in Running, then moves once', () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(
      ({ items }) => useLaneOf(items, 'a'),
      { initialProps: { items: [row('Running')] } },
    );
    rerender({ items: [row('Ready')] });
    expect(result.current).toBe('running');
    act(() => {
      vi.advanceTimersByTime(LIFECYCLE_HOLD_MS);
    });
    expect(result.current).toBe('idle');
  });
});

describe('LifecycleStatusChip — one glyph system, calm by default', () => {
  test('first render is still; a change under the eyes morphs once', () => {
    const view = render(<LifecycleStatusChip lifecycle="Running" />);
    const chip = () => view.container.querySelector('.lifecycle-chip');
    expect(chip()?.getAttribute('data-lifecycle-morph')).toBeNull();
    // Not the current row: the working orbit rests.
    expect(
      view.container
        .querySelector('.live-status-glyph')
        ?.getAttribute('data-animate'),
    ).toBe('false');
    view.rerender(<LifecycleStatusChip lifecycle="Completed" />);
    expect(chip()?.getAttribute('data-lifecycle-morph')).toBe('true');
    expect(chip()?.textContent).toBe('Done');
    expect(
      view.container
        .querySelector('.live-status-glyph')
        ?.getAttribute('data-kind'),
    ).toBe('done');
  });

  test('only the row the user is in keeps the working glyph moving', () => {
    const view = render(<LifecycleStatusChip lifecycle="Running" live />);
    expect(
      view.container
        .querySelector('.live-status-glyph')
        ?.getAttribute('data-animate'),
    ).toBe('true');
  });

  test('fifty rows open with no animation running', () => {
    const view = render(
      <div>
        {Array.from({ length: 50 }, (_, index) => (
          <LifecycleStatusChip
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed list
            key={index}
            lifecycle={index % 5 === 0 ? 'Running' : 'Completed'}
          />
        ))}
      </div>,
    );
    expect(
      view.container.querySelectorAll(
        '[data-animate="true"], [data-lifecycle-morph="true"]',
      ),
    ).toHaveLength(0);
  });
});
