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
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { useIsMobile } from '../hooks/useIsMobile';
import { useMobileVisualViewport } from '../hooks/useMobileVisualViewport';
import { FOCUSABLE_SELECTOR, wrapTabFocus } from '../utils/focusable';
import { useDialogHistoryHost } from './DialogHistoryHost';
import { registerDialogHistory } from './dialog-history';
import { type OverlayLayer, OverlayLayerContext } from './overlay-layer';
import {
  useResponsiveSheetGesture,
  useSheetGesturesPreview,
} from './useResponsiveSheetGesture';

type InitialFocusPolicy = 'always' | 'desktop' | 'panel';
/**
 * Each caller chooses its layer. An anchored popover uses the dialog layer
 * when it becomes a phone sheet (#1696). Desktop popovers stay below
 * notifications, and a system blocker keeps its explicit layer.
 */
type ResponsiveSurfaceLayer = 'dialog' | 'popover' | 'system';
type DialogHistoryMode = 'entry' | 'route' | 'none';

export interface ResponsiveDialogSurfaceProps {
  children: ReactNode;
  /** Keep content mounted while releasing modal history and focus when closed. */
  open?: boolean;
  onClose: () => void;
  ariaLabel?: string;
  ariaLabelledBy?: string;
  /**
   * `alertdialog` for a prompt that INTERRUPTS with something the user must
   * act on — an unsaved-changes confirmation, a destructive action. ARIA
   * distinguishes the two, and assistive tech announces them differently.
   * Defaults to `dialog` (archive#3157).
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
  /** Required: see {@link ResponsiveSurfaceLayer}. There is no default. */
  layer: ResponsiveSurfaceLayer;
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
  /**
   * The shared phone-sheet drag handle (Sheet gestures device preview). On by
   * default; `false` for a consumer that owns its own grab gesture, so the
   * sheet never carries two.
   */
  sheetGesture?: boolean;
  /**
   * Desktop only: while a `popover` opened from inside this surface is open,
   * this panel hides and the child takes its place at this surface's anchor,
   * so the two never show stacked (Run setup and its pickers). A click
   * outside the child closes both; Escape returns to this surface.
   */
  yieldToChildPopover?: boolean;
}

interface ResponsiveSurfaceActionsProps {
  children: ReactNode;
  className?: string;
}

interface ResponsiveDialogHeaderProps {
  /** Rendered in a `<strong>` — the sheet/dialog's own title. */
  title: ReactNode;
  /** Optional second line, rendered muted and small (e.g. "For this chat"). */
  subtitle?: ReactNode;
  /** Passed straight through to `ResponsiveDialogCloseButton`'s `label`. */
  closeLabel: string;
  onClose: () => void;
  /** Id for the title, so the dialog around it can be named by it. */
  titleId?: string;
}

/**
 * Canonical title-row + close-button header for `ResponsiveDialogSurface`
 * consumers (archive#1825). Previously every sheet hand-rolled this same
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
  titleId,
}: ResponsiveDialogHeaderProps) {
  return (
    <div className="responsive-dialog-header">
      <div>
        <strong id={titleId}>{title}</strong>
        {subtitle && <span>{subtitle}</span>}
      </div>
      <ResponsiveDialogCloseButton label={closeLabel} onClick={onClose} />
    </div>
  );
}

interface ResponsiveDialogCloseButtonProps
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
  open = true,
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
  layer,
  historyMode = 'entry',
  anchorRef,
  sheetGesture = true,
  yieldToChildPopover = false,
}: ResponsiveDialogSurfaceProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const isMobile = useIsMobile();
  const resolvedLayer =
    isMobile && anchorRef && layer === 'popover' ? 'dialog' : layer;
  // What this surface is to anything floating inside it — see overlay-layer.
  // Linked to the overlay this one was opened from, which a body portal hides
  // from the DOM but not from React.
  const parentOverlay = useContext(OverlayLayerContext);
  // How many child popovers this surface is currently giving way to.
  const [yieldedTo, setYieldedTo] = useState(0);
  const overlayLayer = useMemo<OverlayLayer>(
    () => ({
      element: () => panelRef.current,
      parent: parentOverlay,
      ...(yieldToChildPopover && !isMobile
        ? {
            yieldTo: {
              hide: () => {
                setYieldedTo((count) => count + 1);
                return () => setYieldedTo((count) => count - 1);
              },
              anchor: () => anchorRef?.current ?? null,
              dismiss: () => onCloseRef.current(),
            },
          }
        : {}),
    }),
    [parentOverlay, yieldToChildPopover, isMobile, anchorRef],
  );
  // The surface this one stands in for while it is open, if any.
  const yieldingParent =
    layer === 'popover' && !isMobile ? parentOverlay?.yieldTo : undefined;
  useLayoutEffect(() => {
    if (!open || !yieldingParent) return;
    return yieldingParent.hide();
  }, [open, yieldingParent]);
  const returnFocusRef = useRef<HTMLElement[]>([]);
  const capturedReturnFocus = useRef(false);
  const restoreFrame = useRef<number | null>(null);
  const dialogHistoryId = useId();
  const dialogHistoryHost = useDialogHistoryHost();
  const visualViewport = useMobileVisualViewport();

  onCloseRef.current = onClose;

  // Drag the sheet up to expand it, down to close it (Sheet gestures device
  // preview). Only a dismissible, ordinary dialog on a phone: an alertdialog
  // asks for a decision a stray swipe must not make for the user. A consumer
  // with its own grab gesture opts out.
  const sheetGestures = useSheetGesturesPreview();
  const sheetHandle = useResponsiveSheetGesture({
    enabled:
      sheetGesture &&
      sheetGestures &&
      isMobile &&
      open &&
      dismissible &&
      role === 'dialog',
    overlayRef,
    panelRef,
    onDismiss: () => onCloseRef.current(),
  });

  useEffect(() => {
    if (
      !open ||
      !dismissible ||
      historyMode !== 'entry' ||
      typeof window === 'undefined'
    ) {
      return;
    }
    return registerDialogHistory(
      dialogHistoryId,
      () => onCloseRef.current(),
      dialogHistoryHost,
    );
  }, [dialogHistoryHost, dialogHistoryId, dismissible, historyMode, open]);

  // Anchored desktop-popover measurement. Raw trigger geometry only — how the
  // panel uses it (side, offsets, clamping) belongs to the feature's CSS.
  // Re-reads `anchorRef.current` on every measurement (never a captured node,
  // so a swapped/unmounted trigger clears the anchor instead of measuring a
  // detached element's all-zero rect), and observes the anchor itself — the
  // trigger can move without a window resize (sidebar collapse, content
  // reflow), matching the repo's ResizeObserver precedent.
  const [anchorSide, setAnchorSide] = useState<'above' | 'below'>('above');
  const [anchorVars, setAnchorVars] = useState<CSSProperties | null>(null);
  useLayoutEffect(() => {
    // A child standing in for its parent opens where the parent did.
    const resolveAnchor = () =>
      yieldingParent ? yieldingParent.anchor() : (anchorRef?.current ?? null);
    const initial = resolveAnchor();
    if (!open || isMobile || !initial) {
      setAnchorVars(null);
      return;
    }
    const update = () => {
      const anchor = resolveAnchor();
      if (!anchor?.isConnected) {
        setAnchorVars(null);
        return;
      }
      const rect = anchor.getBoundingClientRect();
      // The column the trigger sits in (a composer marks itself), so a
      // feature's CSS can keep the panel inside it rather than over the
      // panes beside it.
      const boundary = anchor
        .closest('[data-popover-boundary]')
        ?.getBoundingClientRect();
      setAnchorSide(
        rect.top < window.innerHeight - rect.bottom ? 'below' : 'above',
      );
      setAnchorVars({
        '--responsive-anchor-top': `${Math.round(rect.top)}px`,
        '--responsive-anchor-left': `${Math.round(rect.left)}px`,
        '--responsive-anchor-right': `${Math.round(window.innerWidth - rect.right)}px`,
        // The anchor's OWN bottom edge, distance from the viewport top —
        // for a popover that opens DOWNWARD from a top-of-screen trigger
        // (archive#4521), which cannot reuse `--responsive-anchor-top` (the
        // trigger's top edge would overlap it) without a magic per-trigger
        // height offset going stale the moment that trigger's own size
        // changes.
        '--responsive-anchor-bottom': `${Math.round(rect.bottom)}px`,
        ...(boundary
          ? {
              '--responsive-boundary-left': `${Math.round(boundary.left)}px`,
              '--responsive-boundary-right': `${Math.round(boundary.right)}px`,
            }
          : {}),
      } as CSSProperties);
    };
    update();
    window.addEventListener('resize', update);
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(initial);
    return () => {
      window.removeEventListener('resize', update);
      observer?.disconnect();
    };
  }, [anchorRef, isMobile, open, yieldingParent]);

  useLayoutEffect(() => {
    if (!open) {
      capturedReturnFocus.current = false;
      return;
    }
    if (!capturedReturnFocus.current) {
      returnFocusRef.current = captureReturnFocus(returnFocusTarget);
      capturedReturnFocus.current = true;
    }
    const focusInitial =
      initialFocusPolicy === 'always' ||
      (initialFocusPolicy === 'desktop' && !isMobile);
    const focusTarget = focusInitial
      ? (initialFocusRef?.current ?? panelRef.current)
      : panelRef.current;
    focusTarget?.focus();
  }, [initialFocusPolicy, initialFocusRef, isMobile, returnFocusTarget, open]);

  // Focus restoration, with a fallback for the case the trigger did not
  // survive (archive#1126). The behaviour lives in
  // `@kontourai/station-shared/return-focus` so the surfaces that do not render
  // this frame share one implementation — including the ones in other packages
  // (archive#1206, #1245). The panel node is read at mount, not in the cleanup:
  // React nulls refs as it tears the tree down.
  useEffect(() => {
    if (!open) return;
    // StrictMode replays effect cleanup while the dialog remains mounted.
    // Cancel that provisional restore before it can pull focus out of the
    // live dialog. A real unmount still schedules the normal return path.
    if (restoreFrame.current !== null)
      cancelAnimationFrame(restoreFrame.current);
    const panel = panelRef.current;
    return () => {
      restoreFrame.current = restoreReturnFocus(returnFocusRef.current, panel);
    };
  }, [open]);

  const containFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented) return;
    if (event.key === 'Escape' && dismissible) {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const panel = panelRef.current;
    // React portal events bubble through owners outside their DOM subtree;
    // Tab order there belongs to the portaled content, not this panel.
    // Escape above still dismisses from a portaled child that leaves it
    // unhandled, as it did before Tab containment learned about portals.
    if (!panel?.contains(event.target as Node)) return;
    const controls = Array.from(
      panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
    ).filter((element) => !element.hasAttribute('disabled'));
    if (!controls.length) {
      event.preventDefault();
      panel.focus();
    } else if (
      document.activeElement === panel ||
      !panel.contains(document.activeElement)
    ) {
      event.preventDefault();
      (event.shiftKey ? controls.at(-1) : controls[0])?.focus();
    } else {
      wrapTabFocus(event, controls);
    }
  };

  const panelProps = {
    ref: panelRef,
    // A stable custom-appearance hook (APPEARANCE_HOOKS).
    'data-surface': 'dialog',
    className: `${panelClassName} responsive-surface-panel`.trim(),
    style: panelStyle,
    'aria-modal': true,
    'aria-label': ariaLabel,
    'aria-labelledby': ariaLabelledBy,
    tabIndex: -1,
    onKeyDown: containFocus,
  };

  // #1638/#1662: rendered at `document.body`, never where the consumer sits.
  //
  // A dock is a stacking context in both its forms — `position: fixed` with
  // `z-index: var(--layer-dock)` on mobile, `position: relative` in the
  // desktop region grid keeping the same z-index — and `ChatDock` renders its
  // modal stack INSIDE it, so a surface mounted there could never honour the
  // `--layer-dialog` its own overlay declares; it painted at whatever the
  // dock's z-index happened to be, under the notice host and under a toast.
  // #1638 was one instance of that (a notice's collapsed-stack cap taking the
  // click meant for the New Chat sheet's agent card). Portalling removes the
  // trap instead of compensating for it with a z-index rule, which is what
  // `ConfirmModal`, `PluginModalStack`, `MobileTaskSwitcher` and
  // `DelegationLauncher` (#1180 — a hand-rolled overlay, not a consumer of
  // this component) already do; this is the same escape at the shared seam,
  // so a surface written later is correct without knowing any of this.
  //
  // Nothing about geometry changes: no ancestor between these overlays and
  // the viewport sets `transform`, `filter`, `backdrop-filter`, `perspective`,
  // `will-change`, `contain` or `content-visibility`, so `position: fixed` was
  // already resolving against the viewport (measured at 1440x900 and 390x844:
  // the in-dock overlay's rect was exactly the viewport rect). The viewport
  // and anchor custom properties are written inline on the overlay below, and
  // every other value the panels read is root- or theme-scoped, so none of it
  // depends on where the node sits. React events still bubble through the
  // component tree, and no listener in the dock is bound to a dock ELEMENT.
  return createPortal(
    <div
      ref={overlayRef}
      className={`${overlayClassName} responsive-surface-overlay`.trim()}
      style={{
        ...visualViewport.style,
        ...anchorVars,
        ...overlayStyle,
        ...(!open ? { display: 'none' } : {}),
      }}
      aria-hidden={!open || undefined}
      data-responsive-layer={resolvedLayer}
      /**
       * #1638: a modal or popover surface is not part of the dock's resize
       * gesture, whether or not it happens to be a DOM descendant of it. This
       * is the opt-out `useChatDockVerticalDrag` already honours (its
       * `NO_DOCK_DRAG` bail, which `ChatDockMobileHeader` uses in three
       * places), so nothing new is invented here.
       *
       * WITHOUT IT, PORTALLING BREAKS EVERY CONTROL IN A DOCK-MOUNTED SURFACE.
       * `ChatDockMobileHeader` is the drag surface and renders its sheets
       * inside itself, so a press on a sheet control reaches the hook's
       * `onPointerDown`. That hook captures the pointer immediately and says
       * why: "capture retargets the native click at the surface, where it
       * activates nothing" — so it compensates by REPLAYING the click on the
       * pressed control. The replay is gated on
       * `target.contains(pressedControl)`, DOM containment against the drag
       * surface. A portaled panel is not a DOM descendant, so the capture
       * still fires and the compensation is switched off: the click is
       * consumed and never replayed, and the control's handler never runs.
       * Measured live — the mobile project switcher stopped switching
       * projects at every phone width, with no pointer-interception error
       * because there was no click to intercept.
       *
       * WHY A LISTENER SWEEP DOES NOT FIND THIS. The handler is neither on the
       * document nor the window: it is a React prop on the drag surface, and
       * React events cross a portal through the COMPONENT tree. So an audit
       * that concludes "every listener is on the document or the window" is
       * true and irrelevant twice over — the attachment point is a third
       * thing, and the attachment point was never what breaks. What breaks
       * under a portal is what a predicate TESTS.
       *
       * It also closes a defect that predates the portal: a press inside an
       * open dialog was captured as a potential dock drag and replayed, so
       * the dock could be resized by dragging from inside a dialog. Nothing
       * intended that, but someone may have built a habit on it.
       */
      data-no-dock-drag=""
      // What this surface decided it is on this viewport, so a consumer
      // styles its sheet without restating the mobile media query.
      data-sheet={isMobile ? '' : undefined}
      data-anchored={anchorVars ? '' : undefined}
      data-anchor-side={anchorVars ? anchorSide : undefined}
      role="presentation"
      data-yielded={yieldedTo > 0 && open ? '' : undefined}
      onPointerDown={(event) => {
        if (dismissible && event.target === event.currentTarget) {
          onClose();
          // Outside both: the hidden parent closes too.
          yieldingParent?.dismiss();
        }
      }}
    >
      <OverlayLayerContext.Provider value={overlayLayer}>
        {/* A closed surface stays mounted to keep its state, but it is not
            a dialog: no role, no modal claim, and nothing in it reachable
            (#4403 — the closed Coding tool sheet still read as one). */}
        {!open ? (
          <div
            ref={panelRef}
            className={panelProps.className}
            style={panelStyle}
            inert
          >
            {children}
          </div>
        ) : (
          <div {...panelProps} role={role}>
            {children}
          </div>
        )}
        {sheetHandle.showHandle && (
          <div {...sheetHandle.handleProps}>
            <span className="responsive-sheet-handle__grip" />
          </div>
        )}
      </OverlayLayerContext.Provider>
    </div>,
    document.body,
  );
}
