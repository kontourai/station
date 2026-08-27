import {
  captureReturnFocus,
  restoreReturnFocus,
} from '@kontourai/station-shared/return-focus';
import {
  type ButtonHTMLAttributes,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { useIsMobile } from '../hooks/useIsMobile';
import { useMobileVisualViewport } from '../hooks/useMobileVisualViewport';
import { registerDialogHistory } from './dialog-history';

const FOCUSABLE =
  'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex="-1"])';

type InitialFocusPolicy = 'always' | 'desktop' | 'panel';
type ResponsiveSurfaceLayer = 'dialog' | 'system';
type DialogHistoryMode = 'entry' | 'route' | 'none';

export interface ResponsiveDialogSurfaceProps {
  children: ReactNode;
  onClose: () => void;
  ariaLabel?: string;
  ariaLabelledBy?: string;
  /**
   * `alertdialog` for a prompt that INTERRUPTS with something the user must
   * act on — an unsaved-changes confirmation, a destructive action. ARIA
   * distinguishes the two, and assistive tech announces them differently.
   * Defaults to `dialog` (station#3157).
   */
  role?: 'dialog' | 'alertdialog';
  overlayClassName?: string;
  panelClassName?: string;
  overlayStyle?: CSSProperties;
  panelStyle?: CSSProperties;
  initialFocusRef?: RefObject<HTMLElement | null>;
  initialFocusPolicy?: InitialFocusPolicy;
  returnFocusTarget?: HTMLElement | null;
  dismissible?: boolean;
  layer?: ResponsiveSurfaceLayer;
  historyMode?: DialogHistoryMode;
  /**
   * Desktop-popover anchor. When set and the viewport is not mobile, the
   * overlay carries `data-anchored` plus `--responsive-anchor-top/left/right`
   * CSS vars measured from this element, so feature CSS can position the panel
   * next to its trigger instead of docking it to a viewport edge. Mobile
   * ignores the anchor entirely — sheets keep their edge-docked geometry.
   * The ref must be populated when the dialog opens: a null `current` renders
   * the un-anchored fallback (edge-docked, scrim-less on desktop).
   */
  anchorRef?: RefObject<HTMLElement | null>;
}

export interface ResponsiveSurfaceActionsProps {
  children: ReactNode;
  className?: string;
}

export interface ResponsiveDialogHeaderProps {
  /** Rendered in a `<strong>` — the sheet/dialog's own title. */
  title: ReactNode;
  /** Optional second line, rendered muted and small (e.g. "For this chat"). */
  subtitle?: ReactNode;
  /** Passed straight through to `ResponsiveDialogCloseButton`'s `label`. */
  closeLabel: string;
  onClose: () => void;
}

/**
 * Canonical title-row + close-button header for `ResponsiveDialogSurface`
 * consumers (station#1825). Previously every sheet hand-rolled this same
 * `<div className="session-model-picker__header">` markup, and the flex/gap
 * layout that keeps the title and the close button from colliding lived in
 * `SessionModelPicker.css` — a stylesheet Vite only loads once
 * `SessionModelPicker` itself is lazy-imported. Any *other* consumer opened
 * before the model picker's first open (the common case — the project
 * switcher, the actions menu, the snooze menu) rendered this header with no
 * flex layout at all: `display: block`, title and button butted flush
 * against each other with the button drawn over the tail of the title text.
 * This component's own class lives in the eagerly loaded global stylesheet
 * (`index.css`) instead, and is the one place that markup exists now.
 */
export function ResponsiveDialogHeader({
  title,
  subtitle,
  closeLabel,
  onClose,
}: ResponsiveDialogHeaderProps) {
  return (
    <div className="responsive-dialog-header">
      <div>
        <strong>{title}</strong>
        {subtitle && <span>{subtitle}</span>}
      </div>
      <ResponsiveDialogCloseButton label={closeLabel} onClick={onClose} />
    </div>
  );
}

export interface ResponsiveDialogCloseButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type' | 'children'> {
  label: string;
}

/**
 * Canonical icon close action for Station dialogs and sheets.
 *
 * The SVG avoids platform-dependent multiplication glyphs while the shared
 * class owns its focus, hover, theme, and minimum touch-target treatment.
 */
export function ResponsiveDialogCloseButton({
  label,
  className = '',
  ...buttonProps
}: ResponsiveDialogCloseButtonProps) {
  return (
    <button
      {...buttonProps}
      type="button"
      className={`${className} responsive-dialog-close`.trim()}
      aria-label={label}
    >
      <svg aria-hidden="true" viewBox="0 0 20 20" focusable="false">
        <path d="M5 5l10 10M15 5L5 15" />
      </svg>
    </button>
  );
}

/**
 * Shared action-row marker for dialog and sheet controls.
 *
 * Feature classes retain desktop layout ownership. The shared class only adds
 * phone-safe wrapping, tap targets, and safe-area reachability.
 */
export function ResponsiveSurfaceActions({
  children,
  className = '',
}: ResponsiveSurfaceActionsProps) {
  return (
    <div className={`${className} responsive-surface-actions`.trim()}>
      {children}
    </div>
  );
}

/**
 * Shared keyboard-safe dialog frame for Station-owned surfaces.
 *
 * It owns VisualViewport containment, backdrop dismissal, Escape, focus
 * containment, and focus restoration. Content components keep their own
 * geometry and labels, but no longer reimplement the failure-prone mobile
 * keyboard and modal lifecycle seams.
 */
export function ResponsiveDialogSurface({
  role = 'dialog',
  children,
  onClose,
  ariaLabel,
  ariaLabelledBy,
  overlayClassName = '',
  panelClassName = '',
  overlayStyle,
  panelStyle,
  initialFocusRef,
  initialFocusPolicy = 'panel',
  returnFocusTarget,
  dismissible = true,
  layer = 'dialog',
  historyMode = 'entry',
  anchorRef,
}: ResponsiveDialogSurfaceProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement[]>([]);
  const onCloseRef = useRef(onClose);
  const dialogHistoryId = useId();
  const visualViewport = useMobileVisualViewport();
  const isMobile = useIsMobile();

  onCloseRef.current = onClose;

  useEffect(() => {
    if (
      !dismissible ||
      historyMode !== 'entry' ||
      typeof window === 'undefined'
    ) {
      return;
    }
    return registerDialogHistory(dialogHistoryId, () => onCloseRef.current());
  }, [dialogHistoryId, dismissible, historyMode]);

  // Anchored desktop-popover measurement. Raw trigger geometry only — how the
  // panel uses it (side, offsets, clamping) belongs to the feature's CSS.
  // Re-reads `anchorRef.current` on every measurement (never a captured node,
  // so a swapped/unmounted trigger clears the anchor instead of measuring a
  // detached element's all-zero rect), and observes the anchor itself — the
  // trigger can move without a window resize (sidebar collapse, content
  // reflow), matching the repo's ResizeObserver precedent.
  const [anchorVars, setAnchorVars] = useState<CSSProperties | null>(null);
  useLayoutEffect(() => {
    if (isMobile || !anchorRef?.current) {
      setAnchorVars(null);
      return;
    }
    const update = () => {
      const anchor = anchorRef.current;
      if (!anchor?.isConnected) {
        setAnchorVars(null);
        return;
      }
      const rect = anchor.getBoundingClientRect();
      setAnchorVars({
        '--responsive-anchor-top': `${Math.round(rect.top)}px`,
        '--responsive-anchor-left': `${Math.round(rect.left)}px`,
        '--responsive-anchor-right': `${Math.round(window.innerWidth - rect.right)}px`,
        // The anchor's OWN bottom edge, distance from the viewport top —
        // for a popover that opens DOWNWARD from a top-of-screen trigger
        // (station#4521), which cannot reuse `--responsive-anchor-top` (the
        // trigger's top edge would overlap it) without a magic per-trigger
        // height offset going stale the moment that trigger's own size
        // changes.
        '--responsive-anchor-bottom': `${Math.round(rect.bottom)}px`,
      } as CSSProperties);
    };
    update();
    window.addEventListener('resize', update);
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(anchorRef.current);
    return () => {
      window.removeEventListener('resize', update);
      observer?.disconnect();
    };
  }, [anchorRef, isMobile]);

  useLayoutEffect(() => {
    returnFocusRef.current = captureReturnFocus(returnFocusTarget);
    const focusInitial =
      initialFocusPolicy === 'always' ||
      (initialFocusPolicy === 'desktop' && !isMobile);
    const focusTarget = focusInitial
      ? (initialFocusRef?.current ?? panelRef.current)
      : panelRef.current;
    focusTarget?.focus();
  }, [initialFocusPolicy, initialFocusRef, isMobile, returnFocusTarget]);

  // Focus restoration, with a fallback for the case the trigger did not
  // survive (station#1126). The behaviour lives in
  // `@kontourai/station-shared/return-focus` so the surfaces that do not render
  // this frame share one implementation — including the ones in other packages
  // (station#1206, #1245). The panel node is read at mount, not in the cleanup:
  // React nulls refs as it tears the tree down.
  useEffect(() => {
    const panel = panelRef.current;
    return () => {
      restoreReturnFocus(returnFocusRef.current, panel);
    };
  }, []);

  const containFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented) return;
    if (event.key === 'Escape' && dismissible) {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const controls = Array.from(
      panelRef.current?.querySelectorAll<HTMLElement>('*') ?? [],
    ).filter(
      (element) =>
        element.matches(FOCUSABLE) && !element.hasAttribute('disabled'),
    );
    if (controls.length === 0) {
      event.preventDefault();
      panelRef.current?.focus();
      return;
    }
    const first = controls[0];
    const last = controls.at(-1)!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const panelProps = {
    ref: panelRef,
    className: `${panelClassName} responsive-surface-panel`.trim(),
    style: panelStyle,
    'aria-modal': true,
    'aria-label': ariaLabel,
    'aria-labelledby': ariaLabelledBy,
    tabIndex: -1,
    onKeyDown: containFocus,
  };

  return (
    <div
      className={`${overlayClassName} responsive-surface-overlay`.trim()}
      style={{ ...visualViewport.style, ...anchorVars, ...overlayStyle }}
      data-responsive-layer={layer}
      data-anchored={anchorVars ? '' : undefined}
      role="presentation"
      onPointerDown={(event) => {
        if (dismissible && event.target === event.currentTarget) onClose();
      }}
    >
      {role === 'alertdialog' ? (
        <div {...panelProps} role="alertdialog">
          {children}
        </div>
      ) : (
        <div {...panelProps} role="dialog">
          {children}
        </div>
      )}
    </div>
  );
}
