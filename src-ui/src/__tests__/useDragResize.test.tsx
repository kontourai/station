/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { useDragResize } from '../hooks/useDragResize';

function withPointerCapture(el: Element) {
  Object.assign(el, {
    setPointerCapture: vi.fn(),
    hasPointerCapture: vi.fn(() => true),
    releasePointerCapture: vi.fn(),
  });
  return el as HTMLElement & {
    setPointerCapture: ReturnType<typeof vi.fn>;
    hasPointerCapture: ReturnType<typeof vi.fn>;
    releasePointerCapture: ReturnType<typeof vi.fn>;
  };
}

/**
 * A controllable `requestAnimationFrame` double: frames are queued, not run
 * synchronously, so a test can assert coalescing behavior (multiple moves
 * queued before a single manual `flush()`) instead of the `beforeEach`
 * default (which runs callbacks immediately and would hide coalescing bugs).
 */
function installControllableRaf() {
  const pending = new Map<number, FrameRequestCallback>();
  let nextId = 1;
  const cancelAnimationFrame = vi.fn((id: number) => {
    pending.delete(id);
  });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = nextId++;
    pending.set(id, callback);
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', cancelAnimationFrame);
  return {
    cancelAnimationFrame,
    pendingFrameCount: () => pending.size,
    flush: () => {
      const callbacks = [...pending.values()];
      pending.clear();
      for (const callback of callbacks) callback(0);
    },
  };
}

interface HarnessProps {
  setIsDragging: (v: boolean) => void;
  setHeight: (v: number) => void;
  setWidth?: (v: number) => void;
  direction?: 'vertical' | 'horizontal';
  fromLeft?: boolean;
  onDragStart?: () => void;
}

function Harness(props: HarnessProps) {
  const { onPointerDown } = useDragResize(props);
  return (
    // biome-ignore lint/a11y/useSemanticElements: an <hr> cannot be a focusable, operable splitter (same rationale as SplitPaneLayout's divider).
    <div
      data-testid="side-panel-handle"
      role="separator"
      aria-valuenow={0}
      tabIndex={0}
      onPointerDown={onPointerDown}
    />
  );
}

describe('useDragResize (side-panel handle)', () => {
  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});
    Object.defineProperty(window, 'innerWidth', {
      value: 1200,
      configurable: true,
    });
  });

  function renderHarness(overrides: Partial<HarnessProps> = {}) {
    const setIsDragging = vi.fn();
    const setHeight = vi.fn();
    const setWidth = vi.fn();
    const onDragStart = vi.fn();
    render(
      <Harness
        setIsDragging={setIsDragging}
        setHeight={setHeight}
        setWidth={setWidth}
        direction="horizontal"
        onDragStart={onDragStart}
        {...overrides}
      />,
    );
    const handle = withPointerCapture(screen.getByTestId('side-panel-handle'));
    return { handle, setIsDragging, setHeight, setWidth, onDragStart };
  }

  test('opening a drag from the collapsed state calls onDragStart before dragging starts, and applies the first width immediately', () => {
    const { handle, onDragStart, setIsDragging, setWidth } = renderHarness();
    const calls: string[] = [];
    onDragStart.mockImplementation(() => calls.push('open'));
    setIsDragging.mockImplementation(() => calls.push('dragging'));

    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 900 });

    expect(calls).toEqual(['open', 'dragging']);
    expect(setIsDragging).toHaveBeenCalledWith(true);
    // Width is derived from the initial pointer position on the very first
    // frame — no jump before the drag starts growing.
    expect(setWidth).toHaveBeenCalledWith(1200 - 900);
  });

  test('a left-side panel measures width from the viewport left edge', () => {
    const { handle, setWidth } = renderHarness({ fromLeft: true });

    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 320 });

    expect(setWidth).toHaveBeenCalledWith(320);
  });

  test('pointer capture: setPointerCapture is acquired on down and released on up', () => {
    const { handle, setIsDragging } = renderHarness();

    fireEvent.pointerDown(handle, { pointerId: 7, clientX: 900 });
    expect(handle.setPointerCapture).toHaveBeenCalledWith(7);

    fireEvent.pointerMove(window, { pointerId: 7, clientX: 800 });
    fireEvent.pointerUp(window, { pointerId: 7, clientX: 800 });

    expect(handle.releasePointerCapture).toHaveBeenCalledWith(7);
    expect(setIsDragging).toHaveBeenLastCalledWith(false);
  });

  test('losing pointer capture without a pointerup (pointer left the window/an iframe) still clears dragging', () => {
    const { handle, setIsDragging } = renderHarness();

    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 900 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 800 });
    expect(setIsDragging).toHaveBeenLastCalledWith(true);

    // Simulate the browser reclaiming capture without ever delivering a
    // pointerup/pointercancel.
    fireEvent(handle, new Event('lostpointercapture'));

    expect(setIsDragging).toHaveBeenLastCalledWith(false);
  });

  test('pointercancel removes all listeners deterministically', () => {
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    const { handle, setIsDragging } = renderHarness();

    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 900 });
    fireEvent.pointerCancel(window, { pointerId: 1, clientX: 850 });

    expect(setIsDragging).toHaveBeenLastCalledWith(false);
    expect(removeSpy).toHaveBeenCalledWith('pointermove', expect.any(Function));
    expect(removeSpy).toHaveBeenCalledWith('pointerup', expect.any(Function));
    expect(removeSpy).toHaveBeenCalledWith(
      'pointercancel',
      expect.any(Function),
    );
    removeSpy.mockRestore();
  });

  test('ignores move/up events from a different pointer', () => {
    const { handle, setWidth } = renderHarness();

    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 900 });
    setWidth.mockClear();

    fireEvent.pointerMove(window, { pointerId: 2, clientX: 200 });
    expect(setWidth).not.toHaveBeenCalled();

    fireEvent.pointerMove(window, { pointerId: 1, clientX: 700 });
    expect(setWidth).toHaveBeenCalledWith(1200 - 700);
  });

  test('a fresh pointerdown cleans up a stale in-flight drag first', () => {
    const { handle, setIsDragging } = renderHarness();

    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 900 });
    expect(setIsDragging).toHaveBeenLastCalledWith(true);

    // A second pointerdown without a release in between (defensive case).
    fireEvent.pointerDown(handle, { pointerId: 2, clientX: 850 });
    // Net effect: still dragging (the stale drag's false is followed by the
    // new drag's true).
    expect(setIsDragging).toHaveBeenLastCalledWith(true);
  });

  test('coalesces multiple pointermoves before a frame flush into a single width update', () => {
    const raf = installControllableRaf();
    const { handle, setWidth } = renderHarness();

    // The very first frame is aligned synchronously at pointerdown (no rAF
    // involved yet) so a collapsed-state drag doesn't jump before growing.
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 900 });
    expect(setWidth).toHaveBeenCalledTimes(1);
    setWidth.mockClear();

    fireEvent.pointerMove(window, { pointerId: 1, clientX: 890 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 850 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 800 });

    // Three moves scheduled only one pending frame — the second and third
    // were coalesced into it rather than each scheduling their own.
    expect(raf.pendingFrameCount()).toBe(1);
    expect(setWidth).not.toHaveBeenCalled();

    raf.flush();

    // Only the last pending position was applied.
    expect(setWidth).toHaveBeenCalledTimes(1);
    expect(setWidth).toHaveBeenCalledWith(1200 - 800);
  });

  test('cancels the pending animation frame if the drag ends before it flushes', () => {
    const raf = installControllableRaf();
    const { handle, setIsDragging } = renderHarness();

    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 900 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 800 });
    expect(raf.pendingFrameCount()).toBe(1);

    fireEvent.pointerUp(window, { pointerId: 1, clientX: 800 });

    expect(raf.cancelAnimationFrame).toHaveBeenCalledWith(1);
    expect(raf.pendingFrameCount()).toBe(0);
    expect(setIsDragging).toHaveBeenLastCalledWith(false);
  });

  test('removes listeners on unmount mid-drag', () => {
    const setIsDragging = vi.fn();
    const setHeight = vi.fn();
    const setWidth = vi.fn();
    const { unmount } = render(
      <Harness
        setIsDragging={setIsDragging}
        setHeight={setHeight}
        setWidth={setWidth}
        direction="horizontal"
      />,
    );
    const handle = withPointerCapture(screen.getByTestId('side-panel-handle'));
    const removeSpy = vi.spyOn(window, 'removeEventListener');

    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 900 });
    unmount();

    expect(removeSpy).toHaveBeenCalledWith('pointermove', expect.any(Function));
    expect(removeSpy).toHaveBeenCalledWith('pointerup', expect.any(Function));
    expect(setIsDragging).toHaveBeenLastCalledWith(false);
    removeSpy.mockRestore();
  });
});
