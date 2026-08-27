/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { ChatDockResizeHandle } from '../components/chat-dock/ChatDockResizeHandle';
import { TAP_MOVE_THRESHOLD } from '../components/chat-dock/dockSnap';

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

describe('ChatDockResizeHandle', () => {
  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});
  });

  function renderHandle(
    overrides: Partial<Parameters<typeof ChatDockResizeHandle>[0]> = {},
  ) {
    const onSnap = vi.fn();
    const onCommitHeight = vi.fn();
    const onLiveHeight = vi.fn();
    const onDragStateChange = vi.fn();
    render(
      <ChatDockResizeHandle
        mode="mobile-snap"
        currentHeight={320}
        snap="collapsed"
        toolbarHeight={0}
        collapsedHeight={38}
        onSnap={onSnap}
        onCommitHeight={onCommitHeight}
        onLiveHeight={onLiveHeight}
        onDragStateChange={onDragStateChange}
        {...overrides}
      />,
    );
    const handle = withPointerCapture(
      screen.getByRole('separator', {
        name: 'Resize chat dock',
      }),
    );
    return {
      handle,
      onSnap,
      onCommitHeight,
      onLiveHeight,
      onDragStateChange,
    };
  }

  test('a drag from Collapsed reports live height without committing a snap before release', () => {
    const { handle, onSnap, onLiveHeight, onDragStateChange } = renderHandle({
      snap: 'collapsed',
    });

    fireEvent.pointerDown(handle, { pointerId: 1, clientY: 700 });
    expect(onDragStateChange).toHaveBeenCalledWith(true);
    expect(onSnap).not.toHaveBeenCalled();

    // Move past the tap threshold (dock grows as the handle moves up).
    fireEvent.pointerMove(window, {
      pointerId: 1,
      clientY: 700 - TAP_MOVE_THRESHOLD - 20,
    });

    expect(onLiveHeight).toHaveBeenCalledWith(expect.any(Number));
    expect(onSnap).not.toHaveBeenCalled();

    // Further moves continue the live drag without committing Half early.
    fireEvent.pointerMove(window, { pointerId: 1, clientY: 600 });
    expect(onSnap).not.toHaveBeenCalled();
  });

  test('a tap (move under the threshold) does not open or resize the dock', () => {
    const { handle, onSnap, onLiveHeight } = renderHandle({
      snap: 'collapsed',
    });

    fireEvent.pointerDown(handle, { pointerId: 1, clientY: 700 });
    fireEvent.pointerMove(window, { pointerId: 1, clientY: 700 - 2 });

    fireEvent.pointerUp(window, { pointerId: 1, clientY: 700 - 2 });
    expect(onLiveHeight).toHaveBeenLastCalledWith(null);
    expect(onSnap).not.toHaveBeenCalled();
  });

  test('desktop drag commits the exact clamped height instead of snapping', () => {
    const { handle, onSnap, onCommitHeight } = renderHandle({
      mode: 'desktop-free',
      snap: 'half',
    });

    fireEvent.pointerDown(handle, { pointerId: 1, clientY: 700 });
    fireEvent.pointerMove(window, { pointerId: 1, clientY: 500 });
    fireEvent.pointerUp(window, { pointerId: 1, clientY: 500 });

    expect(onCommitHeight).toHaveBeenCalledWith(268);
    expect(onSnap).not.toHaveBeenCalled();
  });

  test('desktop drag never commits an open dock below its content minimum', () => {
    const { handle, onCommitHeight } = renderHandle({
      mode: 'desktop-free',
      snap: 'half',
    });

    fireEvent.pointerDown(handle, { pointerId: 1, clientY: 500 });
    fireEvent.pointerMove(window, { pointerId: 1, clientY: 760 });
    fireEvent.pointerUp(window, { pointerId: 1, clientY: 760 });

    expect(onCommitHeight).toHaveBeenCalledWith(200);
  });

  test('pointerup releases pointer capture and clears dragging state', () => {
    const { handle, onDragStateChange } = renderHandle({ snap: 'half' });

    fireEvent.pointerDown(handle, { pointerId: 1, clientY: 700 });
    fireEvent.pointerMove(window, { pointerId: 1, clientY: 600 });
    fireEvent.pointerUp(window, { pointerId: 1, clientY: 600 });

    expect(onDragStateChange).toHaveBeenLastCalledWith(false);
    expect(
      (handle as unknown as { releasePointerCapture: ReturnType<typeof vi.fn> })
        .releasePointerCapture,
    ).toHaveBeenCalledWith(1);
  });

  test('losing pointer capture without a pointerup (pointer left the window/an iframe) clears dragging without stranding it', () => {
    const { handle, onDragStateChange, onLiveHeight, onSnap } = renderHandle({
      snap: 'half',
    });

    fireEvent.pointerDown(handle, { pointerId: 1, clientY: 700 });
    fireEvent.pointerMove(window, { pointerId: 1, clientY: 600 });

    // Simulate the browser reclaiming capture without ever delivering a
    // pointerup/pointercancel (e.g. the pointer crossed into the MCP-UI
    // iframe and never returned).
    fireEvent(handle, new Event('lostpointercapture'));

    expect(onDragStateChange).toHaveBeenLastCalledWith(false);
    expect(onLiveHeight).toHaveBeenLastCalledWith(null);
    // No snap commit is guessed for an involuntary capture loss.
    expect(onSnap).not.toHaveBeenCalled();

    // A stray move after capture is lost must not resurrect the drag.
    fireEvent.pointerMove(window, { pointerId: 1, clientY: 200 });
    expect(onLiveHeight).toHaveBeenCalledTimes(2);
  });

  test('pointercancel releases the drag deterministically', () => {
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    const { handle, onDragStateChange } = renderHandle({ snap: 'half' });

    fireEvent.pointerDown(handle, { pointerId: 1, clientY: 700 });
    fireEvent.pointerCancel(window, { pointerId: 1, clientY: 650 });

    expect(onDragStateChange).toHaveBeenLastCalledWith(false);
    expect(removeSpy).toHaveBeenCalledWith('pointermove', expect.any(Function));
    expect(removeSpy).toHaveBeenCalledWith('pointerup', expect.any(Function));
    expect(removeSpy).toHaveBeenCalledWith(
      'pointercancel',
      expect.any(Function),
    );
    removeSpy.mockRestore();
  });

  test('ignores move/up events from a different pointer', () => {
    const { handle, onLiveHeight } = renderHandle({ snap: 'half' });

    fireEvent.pointerDown(handle, { pointerId: 1, clientY: 700 });
    fireEvent.pointerMove(window, { pointerId: 2, clientY: 200 });
    fireEvent.pointerUp(window, { pointerId: 2, clientY: 200 });

    expect(onLiveHeight).not.toHaveBeenCalled();

    fireEvent.pointerMove(window, { pointerId: 1, clientY: 600 });
    expect(onLiveHeight).toHaveBeenCalledWith(expect.any(Number));
  });

  test('keyboard cycling is unaffected: ArrowUp grows one snap', () => {
    const { handle, onSnap } = renderHandle({ snap: 'half' });
    fireEvent.keyDown(handle, { key: 'ArrowUp' });
    expect(onSnap).toHaveBeenCalledWith('full');
  });

  test('desktop keyboard arrows adjust the continuous pixel height', () => {
    const { handle, onSnap, onCommitHeight } = renderHandle({
      mode: 'desktop-free',
      currentHeight: 320,
      snap: 'half',
    });

    expect(handle.tagName).toBe('HR');
    expect(handle.getAttribute('aria-valuemin')).toBe('200');
    expect(handle.getAttribute('aria-valuemax')).toBe('768');
    expect(handle.getAttribute('aria-valuenow')).toBe('320');
    expect(handle.getAttribute('aria-valuetext')).toBe('320px');
    fireEvent.keyDown(handle, { key: 'ArrowUp' });
    fireEvent.keyDown(handle, { key: 'ArrowDown' });
    fireEvent.keyDown(handle, { key: 'Home' });
    fireEvent.keyDown(handle, { key: 'End' });

    expect(onCommitHeight).toHaveBeenNthCalledWith(1, 352);
    expect(onCommitHeight).toHaveBeenNthCalledWith(2, 288);
    expect(onCommitHeight).toHaveBeenNthCalledWith(3, 200);
    expect(onCommitHeight).toHaveBeenNthCalledWith(4, 768);
    expect(onSnap).not.toHaveBeenCalled();
  });

  test('coalesces multiple pointermoves before a frame flush into a single live-height update', () => {
    const raf = installControllableRaf();
    const { handle, onLiveHeight } = renderHandle({ snap: 'half' });

    fireEvent.pointerDown(handle, { pointerId: 1, clientY: 700 });
    fireEvent.pointerMove(window, { pointerId: 1, clientY: 690 });
    fireEvent.pointerMove(window, { pointerId: 1, clientY: 650 });
    fireEvent.pointerMove(window, { pointerId: 1, clientY: 600 });

    // Three moves scheduled only one frame (the second and third moves were
    // coalesced into the same pending frame rather than each scheduling
    // their own).
    expect(raf.pendingFrameCount()).toBe(1);
    expect(onLiveHeight).not.toHaveBeenCalled();

    raf.flush();

    // Only the last pending position was applied.
    expect(onLiveHeight).toHaveBeenCalledTimes(1);
    expect(onLiveHeight).toHaveBeenCalledWith(768 - 600);
  });

  test('cancels the pending animation frame if the drag ends before it flushes', () => {
    const raf = installControllableRaf();
    const { handle, onDragStateChange } = renderHandle({ snap: 'half' });

    fireEvent.pointerDown(handle, { pointerId: 1, clientY: 700 });
    fireEvent.pointerMove(window, { pointerId: 1, clientY: 600 });
    expect(raf.pendingFrameCount()).toBe(1);

    fireEvent.pointerUp(window, { pointerId: 1, clientY: 600 });

    expect(raf.cancelAnimationFrame).toHaveBeenCalledWith(1);
    expect(raf.pendingFrameCount()).toBe(0);
    expect(onDragStateChange).toHaveBeenLastCalledWith(false);
  });

  test('double-click resets the desktop dock to the registry default height', () => {
    // The reset target is the registry default — the same value a fresh
    // device gets — so "reset" and "first run" cannot drift apart. Clamped
    // through the same path as keyboard resizes.
    const onCommitHeight = vi.fn();
    renderHandle({ mode: 'desktop-free', currentHeight: 612, onCommitHeight });
    fireEvent.doubleClick(screen.getByRole('separator'));
    expect(onCommitHeight).toHaveBeenCalledWith(320);
  });

  test('mobile snap mode ignores double-click', () => {
    // Mobile has no free height to reset; a double tap must not fight the
    // snap gesture grammar.
    const onCommitHeight = vi.fn();
    const onSnap = vi.fn();
    renderHandle({ mode: 'mobile-snap', onCommitHeight, onSnap });
    fireEvent.doubleClick(screen.getByRole('separator'));
    expect(onCommitHeight).not.toHaveBeenCalled();
    expect(onSnap).not.toHaveBeenCalled();
  });
});
