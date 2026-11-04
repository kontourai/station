import { type ReactNode, useEffect, useRef } from 'react';
import { Button } from '../components/Button';
import { ExpandGlyph, glyph, RestoreGlyph } from '../components/icons/Glyph';
import type { LiveSurfaceControllerTone } from './LiveSurfaceCanvas';

/**
 * The one viewer chrome for a live surface: who is in control, Take control
 * or Release control, the on-screen keyboard, and Full screen / Exit full
 * screen, with host slots before and after. The float-over-chat's pill and
 * the immersive (full-screen) bar are both this component; each host adds
 * only what is its own (the float: Move, Minimize, Close; a browser: its
 * navigation).
 *
 * Every control is a labelled button (`aria-label` and a `title` tooltip),
 * so an icon-only control still says what it does.
 */

/** Who is in control, in the fewest words (a badge, not a sentence). */
export const DRIVER_TEXT: Record<LiveSurfaceControllerTone, string> = {
  agent: 'An agent is driving',
  you: 'You are in control',
  other: 'Someone else is in control',
  none: 'No one is in control',
};

const KeyboardGlyph = /* @__PURE__ */ glyph(
  'M2 4.5h12v7H2v-7ZM4.5 7h.01M7 7h.01M9 7h.01M11.5 7h.01M5.5 9.5h5',
);

export interface LiveSurfaceViewerControlsProps {
  id?: string;
  /** The toolbar's accessible name, e.g. "Floating browser". */
  label: string;
  className?: string;
  /** Added to every button this component draws (a host's size floor). */
  actionClassName?: string;
  /** The status line, shown as a badge; null hides it (e.g. Take control says it). */
  status: string | null;
  tone: LiveSurfaceControllerTone;
  /** Offered when this viewer may take control; the status is its tooltip. */
  onClaim?: (() => void) | null;
  /** Offered while this viewer holds control. */
  onRelease?: (() => void) | null;
  keyboard?: { open: boolean; onToggle: () => void } | null;
  /** Full screen (or Exit full screen while `immersive`); absent hides it. */
  onToggleImmersive?: (() => void) | null;
  immersive?: boolean;
  leading?: ReactNode;
  trailing?: ReactNode;
}

export function LiveSurfaceViewerControls({
  id,
  label,
  className,
  actionClassName,
  status,
  tone,
  onClaim,
  onRelease,
  keyboard,
  onToggleImmersive,
  immersive = false,
  leading,
  trailing,
}: LiveSurfaceViewerControlsProps) {
  const action = ['live-surface-controls__action', actionClassName]
    .filter(Boolean)
    .join(' ');
  const icon = `${action} live-surface-controls__icon`;
  return (
    <div
      id={id}
      className={['live-surface-controls', className].filter(Boolean).join(' ')}
      role="toolbar"
      aria-label={label}
      data-tone={tone}
    >
      {leading}
      {status ? (
        <p
          className="live-surface-controls__status"
          data-tone={tone}
          aria-hidden="true"
        >
          {status}
        </p>
      ) : null}
      {onClaim ? (
        <Button
          size="sm"
          className={action}
          title={DRIVER_TEXT[tone]}
          onClick={onClaim}
        >
          Take control
        </Button>
      ) : null}
      {onRelease ? (
        <Button
          size="sm"
          variant="ghost"
          className={action}
          title="Give control back"
          onClick={onRelease}
        >
          Release control
        </Button>
      ) : null}
      {keyboard ? (
        <Button
          size="sm"
          variant="ghost"
          className={icon}
          aria-label={keyboard.open ? 'Hide keyboard' : 'Show keyboard'}
          aria-pressed={keyboard.open}
          title={keyboard.open ? 'Hide keyboard' : 'Show keyboard'}
          onClick={keyboard.onToggle}
        >
          <KeyboardGlyph />
        </Button>
      ) : null}
      {onToggleImmersive ? (
        <Button
          size="sm"
          variant="ghost"
          className={icon}
          aria-label={immersive ? 'Exit full screen' : 'Full screen'}
          title={immersive ? 'Exit full screen' : 'Full screen'}
          onClick={onToggleImmersive}
        >
          {immersive ? <RestoreGlyph /> : <ExpandGlyph />}
        </Button>
      ) : null}
      {trailing}
    </div>
  );
}

/**
 * Hides revealed controls after `delayMs` while `active`, restarting
 * whenever `restartKey` changes (an interaction with them). The caller
 * decides what keeps them up: a mouse over them, keyboard focus in them.
 */
export function useAutoHide(
  active: boolean,
  onHide: () => void,
  delayMs: number,
  restartKey: unknown,
): void {
  const hideRef = useRef(onHide);
  hideRef.current = onHide;
  // biome-ignore lint/correctness/useExhaustiveDependencies: restartKey restarts the timer by design.
  useEffect(() => {
    if (!active) return;
    const timer = setTimeout(() => hideRef.current(), delayMs);
    return () => clearTimeout(timer);
  }, [active, delayMs, restartKey]);
}

/** Focus that arrived from the keyboard (not a tap that focused a button). */
export function isKeyboardFocus(target: EventTarget): boolean {
  try {
    return target instanceof Element && target.matches(':focus-visible');
  } catch {
    return false;
  }
}

/** How long revealed controls stay up without an interaction. */
export const CONTROLS_AUTO_HIDE_MS = 4_000;
