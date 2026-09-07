import { DEVICE_SETTINGS_REGISTRY } from '@kontourai/station-contracts/device-settings';
import { useChatDockVerticalDrag } from '../../hooks/useChatDockVerticalDrag';
import {
  DOCK_MIN_HEIGHT,
  type DockSnap,
  growDockSnap,
  nextDockSnap,
  shrinkDockSnap,
} from './dockSnap';

const DESKTOP_DOCK_KEYBOARD_STEP = 32;

/**
 * The registry default is the one authority on what "reset" means — the same
 * value a fresh device gets, so double-click and first-run agree by
 * construction rather than by a second constant drifting from the first.
 */
const DEFAULT_DOCK_HEIGHT = DEVICE_SETTINGS_REGISTRY.find(
  (setting) => setting.key === 'chatDockHeight',
)?.defaultValue as number;

interface ChatDockResizeHandleProps {
  ariaLabel?: string;
  mode: 'desktop-free' | 'mobile-snap';
  /** Current snap state (for keyboard cycling + ARIA). */
  snap: DockSnap;
  /** Current committed height for continuous desktop separator semantics. */
  currentHeight: number;
  /** App toolbar height (px) so Full never overlaps the toolbar. */
  toolbarHeight: number;
  /**
   * Live collapsed-bar height (px), resolved from `--chat-dock-header-height`.
   * Mobile bumps that variable, so the Collapsed snap/clamp must track the real
   * bar height rather than the desktop 38px literal.
   */
  collapsedHeight: number;
  /** Commit a discrete snap state (mobile drag-release or keyboard). */
  onSnap: (snap: DockSnap) => void;
  /** Commit an exact height for continuously-resizable desktop bottom docks. */
  onCommitHeight: (px: number) => void;
  /** Report a live pixel height while dragging (null clears the override). */
  onLiveHeight: (px: number | null) => void;
  /** Marks drag start/end so the dock can suspend its height transition. */
  onDragStateChange: (dragging: boolean) => void;
}

/**
 * The top-edge handle of the bottom chat dock. Pointer-Events aware (mouse,
 * touch, and pen all go through the same path) and uses `setPointerCapture`
 * so a drag keeps receiving move/up events even if the pointer leaves the
 * window or crosses an iframe (e.g. the MCP-UI host) — `pointerup` /
 * `pointercancel` / the browser's own `lostpointercapture` event all release
 * the drag deterministically, so it can never strand in a dragging state.
 * Live height updates are coalesced to one `requestAnimationFrame` per
 * pointer move. Mobile releases resolve to Collapsed / Half / Full (a clear
 * downward release or flick puts the dock away); desktop releases
 * preserve the exact clamped height. A tap is a no-op; keyboard arrows
 * grow/shrink and Enter/Space retain explicit snap cycling for accessibility.
 *
 * The dock grows as the handle moves *up*, so the live body height is measured
 * from the bottom of the viewport: `innerHeight - clientY`.
 */
export function ChatDockResizeHandle({
  ariaLabel = 'Resize chat dock',
  mode,
  snap,
  currentHeight,
  toolbarHeight,
  collapsedHeight,
  onSnap,
  onCommitHeight,
  onLiveHeight,
  onDragStateChange,
}: ChatDockResizeHandleProps) {
  const { onPointerDown } = useChatDockVerticalDrag({
    mode,
    toolbarHeight,
    collapsedHeight,
    onSnap,
    onCommitHeight,
    onLiveHeight,
    onDragStateChange,
  });

  const viewportHeight =
    typeof window === 'undefined'
      ? currentHeight + toolbarHeight
      : (window.visualViewport?.height ?? window.innerHeight);
  const desktopMaxHeight = Math.max(
    DOCK_MIN_HEIGHT,
    viewportHeight - toolbarHeight,
  );
  const commitDesktopKeyboardHeight = (height: number) =>
    onCommitHeight(
      Math.min(desktopMaxHeight, Math.max(DOCK_MIN_HEIGHT, height)),
    );

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (mode === 'desktop-free') {
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        commitDesktopKeyboardHeight(currentHeight + DESKTOP_DOCK_KEYBOARD_STEP);
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        commitDesktopKeyboardHeight(currentHeight - DESKTOP_DOCK_KEYBOARD_STEP);
      } else if (e.key === 'Home') {
        e.preventDefault();
        commitDesktopKeyboardHeight(DOCK_MIN_HEIGHT);
      } else if (e.key === 'End') {
        e.preventDefault();
        commitDesktopKeyboardHeight(desktopMaxHeight);
      }
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      onSnap(growDockSnap(snap));
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      onSnap(shrinkDockSnap(snap));
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSnap(nextDockSnap(snap));
    }
  };
  return (
    <hr
      className="chat-dock__resize-handle"
      aria-orientation="horizontal"
      aria-label={ariaLabel}
      aria-valuetext={mode === 'desktop-free' ? `${currentHeight}px` : snap}
      aria-valuemin={mode === 'desktop-free' ? DOCK_MIN_HEIGHT : 0}
      aria-valuemax={mode === 'desktop-free' ? desktopMaxHeight : 2}
      aria-valuenow={
        mode === 'desktop-free'
          ? currentHeight
          : snap === 'collapsed'
            ? 0
            : snap === 'half'
              ? 1
              : 2
      }
      tabIndex={0}
      title="Drag to resize · double-click to reset"
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={
        mode === 'desktop-free'
          ? () => commitDesktopKeyboardHeight(DEFAULT_DOCK_HEIGHT)
          : undefined
      }
      // M5 (station#4460 review): this handle sits OUTSIDE any occupant's
      // file-drop boundary (Chat's, when Chat is docked; Home/Activity have
      // none at all). Without this, dropping a file on the strip hits the
      // browser's default "navigate to this file" behavior instead of
      // either being ignored or handled — discarding whatever the app was
      // doing.
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => event.preventDefault()}
    />
  );
}
