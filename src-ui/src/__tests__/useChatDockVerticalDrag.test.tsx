/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { DockSnap } from '../components/chat-dock/dockSnap';
import { useChatDockVerticalDrag } from '../hooks/useChatDockVerticalDrag';

/**
 * The click a pointer gesture produces. `detail` is the click count, so the
 * browser's own (including a touch compatibility) click always carries at
 * least 1 — jsdom's `fireEvent.click` default of 0 is the shape a KEYBOARD
 * activation has, which the hook must never suppress (archive#3345).
 */
function pointerClick(element: Element) {
  fireEvent.click(element, { detail: 1 });
}

function MobileDockBar({
  snap = 'half',
  onSnap = vi.fn<(snap: DockSnap) => void>(),
  onLiveHeight = vi.fn<(height: number | null) => void>(),
  onDragStateChange = vi.fn<(dragging: boolean) => void>(),
}: {
  snap?: 'collapsed' | 'half' | 'full';
  onSnap?: ReturnType<typeof vi.fn<(snap: DockSnap) => void>>;
  onLiveHeight?: ReturnType<typeof vi.fn<(height: number | null) => void>>;
  onDragStateChange?: ReturnType<typeof vi.fn<(dragging: boolean) => void>>;
}) {
  const { onPointerDown } = useChatDockVerticalDrag({
    mode: 'mobile-snap',
    toolbarHeight: 0,
    collapsedHeight: 52,
    ignoreInteractiveTargets: true,
    onSnap,
    onCommitHeight: vi.fn(),
    onLiveHeight,
    onDragStateChange,
  });
  return (
    <div data-testid="bar" data-snap={snap} onPointerDown={onPointerDown}>
      <span data-testid="drag-space">Conversation title</span>
      <button type="button">Minimize</button>
    </div>
  );
}

function withPointerCapture(el: Element) {
  Object.assign(el, {
    setPointerCapture: vi.fn(),
    hasPointerCapture: vi.fn(() => true),
    releasePointerCapture: vi.fn(),
  });
  return el;
}

describe('useChatDockVerticalDrag mobile bar', () => {
  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: { height: 844 },
    });
  });

  test('interactive descendants remain controls instead of drag handles', () => {
    const onSnap = vi.fn<(snap: DockSnap) => void>();
    const onDragStateChange = vi.fn<(dragging: boolean) => void>();
    render(
      <MobileDockBar onSnap={onSnap} onDragStateChange={onDragStateChange} />,
    );

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Minimize' }), {
      pointerId: 1,
      clientY: 400,
    });
    fireEvent.pointerMove(window, { pointerId: 1, clientY: 200 });
    fireEvent.pointerUp(window, { pointerId: 1, clientY: 200 });

    expect(onDragStateChange).not.toHaveBeenCalled();
    expect(onSnap).not.toHaveBeenCalled();
  });

  test('a tap on non-interactive bar space is a no-op', () => {
    const onSnap = vi.fn<(snap: DockSnap) => void>();
    render(<MobileDockBar onSnap={onSnap} />);
    const bar = screen.getByTestId('bar');
    Object.assign(bar, {
      setPointerCapture: vi.fn(),
      hasPointerCapture: vi.fn(() => true),
      releasePointerCapture: vi.fn(),
    });

    fireEvent.pointerDown(screen.getByTestId('drag-space'), {
      pointerId: 1,
      clientY: 400,
    });
    fireEvent.pointerUp(window, { pointerId: 1, clientY: 400 });

    expect(onSnap).not.toHaveBeenCalled();
  });

 // archive#795: the original input released at clientY 260 — a 584px body,
// which is *exactly* the Half/Full midpoint. Keeping that input and
// asserting the corrected outcome is the honest regression guard, so it has
// its own test below; this one keeps the same gesture but releases somewhere
// unambiguous, because its actual subject is that non-interactive bar space
// starts a drag at all.
  test('non-interactive bar space drags upward to full', () => {
    const onSnap = vi.fn<(snap: DockSnap) => void>();
    render(<MobileDockBar onSnap={onSnap} />);
    const bar = screen.getByTestId('bar');
    Object.assign(bar, {
      setPointerCapture: vi.fn(),
      hasPointerCapture: vi.fn(() => true),
      releasePointerCapture: vi.fn(),
    });

    fireEvent.pointerDown(screen.getByTestId('drag-space'), {
      pointerId: 1,
      clientY: 400,
    });
    fireEvent.pointerMove(window, { pointerId: 1, clientY: 150 });
    fireEvent.pointerUp(window, { pointerId: 1, clientY: 150 });

    expect(onSnap).toHaveBeenCalledWith('full');
  });

 // archive#795: the exact-midpoint release the original assertion used. A tie
// in `nearestDockSnap` favours the smaller state, so this is Half — the
// behaviour that replaced "any upward drag means Full".
  test('a release exactly on the Half/Full midpoint resolves to Half, not Full', () => {
    const onSnap = vi.fn<(snap: DockSnap) => void>();
    render(<MobileDockBar onSnap={onSnap} />);
    const bar = screen.getByTestId('bar');
    Object.assign(bar, {
      setPointerCapture: vi.fn(),
      hasPointerCapture: vi.fn(() => true),
      releasePointerCapture: vi.fn(),
    });

    fireEvent.pointerDown(screen.getByTestId('drag-space'), {
      pointerId: 1,
      clientY: 400,
    });
    fireEvent.pointerMove(window, { pointerId: 1, clientY: 260 });
    fireEvent.pointerUp(window, { pointerId: 1, clientY: 260 });

    expect(onSnap).toHaveBeenCalledWith('half');
  });

 // archive#751: the gesture that opens the dock must also be able to put it away —
// dragging the header down clearly past Half no longer dead-ends there.
  test('dragging the header down clearly below the Half band collapses the dock', () => {
    const onSnap = vi.fn<(snap: DockSnap) => void>();
    render(<MobileDockBar snap="half" onSnap={onSnap} />);
    const bar = withPointerCapture(screen.getByTestId('bar'));

// visualViewport.height is 844, collapsedHeight is 52: Half is ~380px, so
// the Collapsed/Half midpoint is ~216px — a release at clientY 700 (a
// ~144px body) sits well below it.
    fireEvent.pointerDown(screen.getByTestId('drag-space'), {
      pointerId: 1,
      clientY: 400,
    });
    fireEvent.pointerMove(window, { pointerId: 1, clientY: 700 });
    fireEvent.pointerUp(window, { pointerId: 1, clientY: 700 });

    expect(onSnap).toHaveBeenCalledWith('collapsed');
    expect(bar).toBeTruthy();
  });

  test('dragging the header down from Full clearly below the Half band still collapses', () => {
    const onSnap = vi.fn<(snap: DockSnap) => void>();
    render(<MobileDockBar snap="full" onSnap={onSnap} />);
    withPointerCapture(screen.getByTestId('bar'));

    fireEvent.pointerDown(screen.getByTestId('drag-space'), {
      pointerId: 1,
      clientY: 60,
    });
    fireEvent.pointerMove(window, { pointerId: 1, clientY: 700 });
    fireEvent.pointerUp(window, { pointerId: 1, clientY: 700 });

    expect(onSnap).toHaveBeenCalledWith('collapsed');
  });

  test('reopen-from-collapsed follows the pointer before the release snap opens it', () => {
    const onSnap = vi.fn<(snap: DockSnap) => void>();
    const onLiveHeight = vi.fn<(height: number | null) => void>();
    render(
      <MobileDockBar
        snap="collapsed"
        onSnap={onSnap}
        onLiveHeight={onLiveHeight}
      />,
    );
    withPointerCapture(screen.getByTestId('bar'));

// visualViewport.height is 844, collapsedHeight is 52: Half is ~380px, so
// the Collapsed/Half midpoint is ~216px. Adversarial-review regression:
// reopening from Collapsed necessarily *starts* the drag near the
// Collapsed pixel height, so even a realistic, modest thumb swipe up
// (~120px total, well short of the Half band) must still OPEN — it must
// never be reinterpreted as "collapse" just because the final height is
 // numerically below that midpoint. Since archive#795 it opens to Half rather
// than jumping to Full: a modest drag gets a modest result, and the
// never-collapse invariant this test exists for is unchanged.
    fireEvent.pointerDown(screen.getByTestId('drag-space'), {
      pointerId: 1,
      clientY: 800,
    });
    expect(onSnap).not.toHaveBeenCalled();

// Crossing the tap threshold starts a live preview. It must not commit the
// Half snap while the pointer is still down — that state change races the
// live height and makes the sheet animate away from the user's finger.
    fireEvent.pointerMove(window, { pointerId: 1, clientY: 780 });
    expect(onSnap).not.toHaveBeenCalled();
    expect(onLiveHeight).toHaveBeenLastCalledWith(64);

// A modest ~120px upward drag (800 → 680), released well below the
// Collapsed/Half midpoint (~216px) but heading up, not down.
    fireEvent.pointerMove(window, { pointerId: 1, clientY: 680 });
    fireEvent.pointerUp(window, { pointerId: 1, clientY: 680 });

    expect(onSnap).toHaveBeenCalledWith('half');
    expect(onSnap).not.toHaveBeenCalledWith('collapsed');
  });
});

describe('drag passthrough (data-dock-drag-passthrough)', () => {
/**
* The mobile dock header is almost entirely covered by one large identity
* button. Marking it a passthrough lets the bar be dragged from it, but a
* stationary tap must still reach the button's own click — that is the whole
* reason capture and drag-state are deferred for these targets.
*/
  function renderPassthroughSurface() {
    const onDragStateChange = vi.fn();
    const onSnap = vi.fn();
    const onLiveHeight = vi.fn();
    const onClick = vi.fn();

    function Surface() {
      const { onPointerDown, onClickCapture } = useChatDockVerticalDrag({
        mode: 'mobile-snap',
        toolbarHeight: 0,
        collapsedHeight: 38,
        ignoreInteractiveTargets: true,
        onSnap,
        onCommitHeight: vi.fn(),
        onLiveHeight,
        onDragStateChange,
      });
      return (
        <div
          data-testid="bar"
          onPointerDown={onPointerDown}
          onClickCapture={onClickCapture}
        >
          <button
            type="button"
            data-dock-drag-passthrough=""
            data-testid="identity"
            onClick={onClick}
          >
            identity
          </button>
          <button type="button" data-testid="plain" onClick={onClick}>
            plain
          </button>
        </div>
      );
    }

    render(<Surface />);
    return { onDragStateChange, onSnap, onLiveHeight, onClick };
  }

  test('a press on a passthrough control captures the pointer immediately (#1052 device follow-up)', () => {
    renderPassthroughSurface();
    const bar = withPointerCapture(screen.getByTestId('bar')) as HTMLElement & {
      setPointerCapture: ReturnType<typeof vi.fn>;
    };

    fireEvent.pointerDown(screen.getByTestId('identity'), {
      pointerId: 7,
      clientY: 500,
    });
// Captured before ANY movement: the deferred-capture shape left the
// WebView owning the gesture between press and threshold, which is where
// real-device drags starting on header controls died.
    expect(bar.setPointerCapture).toHaveBeenCalledWith(7);

    fireEvent.pointerUp(window, { pointerId: 7, clientY: 500 });
  });

  test('a right-button press never captures, drags, or replays a click', () => {
    const { onClick, onDragStateChange, onSnap } = renderPassthroughSurface();
    const identity = screen.getByTestId('identity');

    fireEvent.pointerDown(identity, { pointerId: 1, clientY: 500, button: 2 });
    fireEvent.pointerMove(window, { pointerId: 1, clientY: 300 });
    fireEvent.pointerUp(window, { pointerId: 1, clientY: 300 });

// Native context-menu behavior stays the browser's; the hook synthesizes
// nothing from a non-primary button.
    expect(onClick).not.toHaveBeenCalled();
    expect(onDragStateChange).not.toHaveBeenCalled();
    expect(onSnap).not.toHaveBeenCalled();
  });

  test('a stationary tap activates its control through the replay path alone', () => {
    const { onClick, onDragStateChange } = renderPassthroughSurface();
    const identity = screen.getByTestId('identity');

    fireEvent.pointerDown(identity, { pointerId: 1, clientY: 500 });
    fireEvent.pointerUp(window, { pointerId: 1, clientY: 500 });

// No browser click was simulated: with capture retargeting the native
// click away from the control, the hook's own replay is the only path —
// and it must fire exactly once.
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onDragStateChange).not.toHaveBeenCalled();
  });

  test('a stationary tap on a passthrough control still fires its click and never announces a drag', () => {
    const { onDragStateChange, onClick, onSnap } = renderPassthroughSurface();
    const identity = screen.getByTestId('identity');

    fireEvent.pointerDown(identity, { pointerId: 1, clientY: 500 });
    fireEvent.pointerUp(window, { pointerId: 1, clientY: 500 });
    pointerClick(identity);

    expect(onClick).toHaveBeenCalledTimes(1);
// Never announced, so never un-announced either.
    expect(onDragStateChange).not.toHaveBeenCalled();
    expect(onSnap).not.toHaveBeenCalled();
  });

  test('a drag that starts on a passthrough control resizes and announces exactly once', () => {
    const { onDragStateChange, onLiveHeight, onSnap } =
      renderPassthroughSurface();
    const identity = screen.getByTestId('identity');

    fireEvent.pointerDown(identity, { pointerId: 1, clientY: 500 });
    expect(onDragStateChange).not.toHaveBeenCalled();

    fireEvent.pointerMove(window, { pointerId: 1, clientY: 400 });
    fireEvent.pointerMove(window, { pointerId: 1, clientY: 300 });

    expect(onDragStateChange).toHaveBeenCalledWith(true);
    expect(
      onDragStateChange.mock.calls.filter(([v]) => v === true),
    ).toHaveLength(1);
    expect(onLiveHeight).toHaveBeenCalled();

    fireEvent.pointerUp(window, { pointerId: 1, clientY: 300 });
    expect(onDragStateChange).toHaveBeenLastCalledWith(false);
    expect(onSnap).toHaveBeenCalled();
  });

  test('a fast touch drag still snaps when release beats the queued animation frame', () => {
    let queuedFrame: FrameRequestCallback | null = null;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      queuedFrame = callback;
      return 17;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const { onDragStateChange, onLiveHeight, onSnap } =
      renderPassthroughSurface();
    const identity = screen.getByTestId('identity');

    fireEvent.pointerDown(identity, { pointerId: 1, clientY: 600 });
    fireEvent.pointerMove(window, { pointerId: 1, clientY: 180 });
    expect(queuedFrame).not.toBeNull();
    fireEvent.pointerUp(window, { pointerId: 1, clientY: 180 });

    expect(onDragStateChange).toHaveBeenCalledWith(true);
    expect(onDragStateChange).toHaveBeenLastCalledWith(false);
    expect(onLiveHeight).toHaveBeenLastCalledWith(null);
    expect(onSnap).toHaveBeenCalledOnce();
  });

  test('a fresh tap clears stale suppression when the prior drag emitted no click', () => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return null as unknown as number;
    });
    const { onClick } = renderPassthroughSurface();
    const identity = screen.getByTestId('identity');

    fireEvent.pointerDown(identity, { pointerId: 1, clientY: 600 });
    fireEvent.pointerMove(window, { pointerId: 1, clientY: 180 });
    fireEvent.pointerUp(window, { pointerId: 1, clientY: 180 });
// Real touch drags commonly do not produce a compatibility click. The next
// independent press must not inherit suppression from that old gesture.
    fireEvent.pointerDown(identity, { pointerId: 2, clientY: 300 });
    fireEvent.pointerUp(window, { pointerId: 2, clientY: 300 });
    pointerClick(identity);

    expect(onClick).toHaveBeenCalledOnce();
  });

  test('an armed suppression never eats a keyboard activation (station#3345)', () => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return null as unknown as number;
    });
    const { onClick } = renderPassthroughSurface();
    const identity = screen.getByTestId('identity');

// Arm suppression with a drag that emits no compatibility click, the same
// way a real touch drag leaves it armed.
    fireEvent.pointerDown(identity, { pointerId: 1, clientY: 600 });
    fireEvent.pointerMove(window, { pointerId: 1, clientY: 180 });
    fireEvent.pointerUp(window, { pointerId: 1, clientY: 180 });

// Enter/Space on a focused control produces a click with `detail: 0` and
// no pointerdown, so it can never be the gesture click the guard exists
// for — and nothing else would retire the flag for a keyboard user.
    fireEvent.click(identity, { detail: 0 });
    expect(onClick).toHaveBeenCalledOnce();

// The pointer click the guard DOES exist for is still swallowed, so the
// fixture binds in both directions.
    pointerClick(identity);
    expect(onClick).toHaveBeenCalledOnce();
  });

  test('a press on a NON-passthrough control is ignored by the drag entirely', () => {
    const { onDragStateChange, onSnap } = renderPassthroughSurface();
    const plain = screen.getByTestId('plain');

    fireEvent.pointerDown(plain, { pointerId: 1, clientY: 500 });
    fireEvent.pointerMove(window, { pointerId: 1, clientY: 300 });
    fireEvent.pointerUp(window, { pointerId: 1, clientY: 300 });

    expect(onDragStateChange).not.toHaveBeenCalled();
    expect(onSnap).not.toHaveBeenCalled();
  });

  test('a cancelled passthrough drag reports false exactly once and never snaps', () => {
    const { onDragStateChange, onSnap } = renderPassthroughSurface();
    const identity = screen.getByTestId('identity');

    fireEvent.pointerDown(identity, { pointerId: 1, clientY: 500 });
    fireEvent.pointerMove(window, { pointerId: 1, clientY: 300 });
    expect(onDragStateChange).toHaveBeenCalledWith(true);

    fireEvent.pointerCancel(window, { pointerId: 1, clientY: 300 });
    expect(onDragStateChange).toHaveBeenLastCalledWith(false);
    expect(
      onDragStateChange.mock.calls.filter(([v]) => v === false),
    ).toHaveLength(1);
    expect(onSnap).not.toHaveBeenCalled();
  });
});

describe('whole-header drag surface', () => {
  test.each(['collapsed', 'half', 'full'] as const)(
    'drags from an unmarked header control while %s and suppresses only that drag click',
    (snap) => {
      const onSnap = vi.fn();
      const onClick = vi.fn();

      function Surface() {
        const { onPointerDown, onClickCapture } = useChatDockVerticalDrag({
          mode: 'mobile-snap',
          toolbarHeight: 0,
          collapsedHeight: 52,
          ignoreInteractiveTargets: true,
          dragInteractiveTargets: true,
          onSnap,
          onCommitHeight: vi.fn(),
          onLiveHeight: vi.fn(),
          onDragStateChange: vi.fn(),
        });
        return (
          <div
            data-testid="whole-header"
            data-snap={snap}
            onPointerDown={onPointerDown}
            onClickCapture={onClickCapture}
          >
            <button type="button" onClick={onClick}>
              Header action
            </button>
          </div>
        );
      }

      render(<Surface />);
      withPointerCapture(screen.getByTestId('whole-header'));
      const action = screen.getByRole('button', { name: 'Header action' });

      fireEvent.pointerDown(action, { pointerId: 1, clientY: 500 });
      fireEvent.pointerMove(window, { pointerId: 1, clientY: 300 });
      fireEvent.pointerUp(window, { pointerId: 1, clientY: 300 });
      pointerClick(action);

      expect(onSnap).toHaveBeenCalledOnce();
      expect(onClick).not.toHaveBeenCalled();

      fireEvent.pointerDown(action, { pointerId: 2, clientY: 300 });
      fireEvent.pointerUp(window, { pointerId: 2, clientY: 300 });
      pointerClick(action);
      expect(onClick).toHaveBeenCalledOnce();
    },
  );

  test('an explicit no-drag control remains a control', () => {
    const onSnap = vi.fn();
    const onClick = vi.fn();

    function Surface() {
      const { onPointerDown, onClickCapture } = useChatDockVerticalDrag({
        mode: 'mobile-snap',
        toolbarHeight: 0,
        collapsedHeight: 52,
        ignoreInteractiveTargets: true,
        dragInteractiveTargets: true,
        onSnap,
        onCommitHeight: vi.fn(),
        onLiveHeight: vi.fn(),
        onDragStateChange: vi.fn(),
      });
      return (
        <div onPointerDown={onPointerDown} onClickCapture={onClickCapture}>
          <button type="button" data-no-dock-drag="" onClick={onClick}>
            No drag
          </button>
        </div>
      );
    }

    render(<Surface />);
    const action = screen.getByRole('button', { name: 'No drag' });
    fireEvent.pointerDown(action, { pointerId: 1, clientY: 500 });
    fireEvent.pointerMove(window, { pointerId: 1, clientY: 300 });
    fireEvent.pointerUp(window, { pointerId: 1, clientY: 300 });
    pointerClick(action);

    expect(onSnap).not.toHaveBeenCalled();
    expect(onClick).toHaveBeenCalledOnce();
  });
});

describe('useChatDockVerticalDrag viewport stability', () => {
  beforeEach(() => {
// Runs the frame synchronously AND reports "no frame pending" (the hook
// guards on `rafId === null`). Returning a real id here would make the
// hook believe a flush was still queued and silently drop every move
// after the first — which is exactly what a live-height assertion needs
// to not be fooled by.
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return null as unknown as number;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: { height: 844, offsetTop: 0 },
    });
  });

  test('live drag height ignores a viewport change mid-gesture (#1052)', () => {
    const onLiveHeight = vi.fn();
    function Bar() {
      const { onPointerDown } = useChatDockVerticalDrag({
        mode: 'mobile-snap',
        toolbarHeight: 0,
        collapsedHeight: 52,
        ignoreInteractiveTargets: true,
        onSnap: vi.fn(),
        onCommitHeight: vi.fn(),
        onLiveHeight,
        onDragStateChange: vi.fn(),
      });
      return (
        <div data-testid="bar" onPointerDown={onPointerDown}>
          <span data-testid="drag-space">Conversation title</span>
        </div>
      );
    }
    render(<Bar />);
    withPointerCapture(screen.getByTestId('bar'));

    fireEvent.pointerDown(screen.getByTestId('drag-space'), {
      pointerId: 1,
      clientY: 600,
    });
    fireEvent.pointerMove(window, { pointerId: 1, clientY: 500 });
    expect(onLiveHeight).toHaveBeenLastCalledWith(344);

// Android collapses its URL bar during exactly this gesture, so
// visualViewport grows mid-drag. Reading it live re-based every subsequent
// measurement and the dock jumped out from under a finger that had not
// moved between the two frames.
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: { height: 950 },
    });

    fireEvent.pointerMove(window, { pointerId: 1, clientY: 400 });
// 844 - 400. Reading the viewport live would report 550 for the same
// finger position: a 106px jump the user never asked for.
    expect(onLiveHeight).toHaveBeenLastCalledWith(444);
    fireEvent.pointerUp(window, { pointerId: 1, clientY: 400 });
  });

  test('measures height from the visual viewport bottom when it is offset', () => {
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: { height: 700, offsetTop: 44 },
    });
    const onLiveHeight = vi.fn();

    function Bar() {
      const { onPointerDown } = useChatDockVerticalDrag({
        mode: 'mobile-snap',
        toolbarHeight: 0,
        collapsedHeight: 52,
        onSnap: vi.fn(),
        onCommitHeight: vi.fn(),
        onLiveHeight,
        onDragStateChange: vi.fn(),
      });
      return <div data-testid="offset-bar" onPointerDown={onPointerDown} />;
    }

    render(<Bar />);
    withPointerCapture(screen.getByTestId('offset-bar'));
    fireEvent.pointerDown(screen.getByTestId('offset-bar'), {
      pointerId: 1,
      clientY: 600,
    });
    fireEvent.pointerMove(window, { pointerId: 1, clientY: 500 });

// Visible bottom is 44 + 700. Height-only math would report 200px.
    expect(onLiveHeight).toHaveBeenLastCalledWith(244);
    fireEvent.pointerUp(window, { pointerId: 1, clientY: 500 });
  });
});
