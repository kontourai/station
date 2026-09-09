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
import { createPortal } from 'react-dom';
import { useIsMobile } from '../hooks/useIsMobile';
import { useMobileVisualViewport } from '../hooks/useMobileVisualViewport';
import { registerDialogHistory } from './dialog-history';

const FOCUSABLE =
  'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex="-1"])';

type InitialFocusPolicy = 'always' | 'desktop' | 'panel';
/**
 * #1638/#1662: which layer this surface owns, and every consumer states it —
 * there is no default. A default was wrong for some consumer three times on
 * this branch (an anchored-popover proxy, a scrim proxy, and `'dialog'` for
 * surfaces that are not dialogs), and an omission is now a type error at the
 * call site rather than a click the wrong surface swallows at runtime.
 *
 * - `dialog`   — owns the viewport until dismissed; supersedes notifications.
 * - `popover`  — belongs to its trigger. Escapes the dock (every surface
 *                portals now, so the dock cannot clamp it) and outranks it,
 *                but stays below the chrome a user needs in order to act:
 *                `NotificationContainer.css` states that only dialogs and
 *                system blockers supersede a notification.
 * - `system`   — an explicit system blocker; supersedes everything.
 *
 * THE BOUNDARY OF THAT GUARANTEE, because a required prop can only bind the
 * callers that pass props. It covers consumers of THIS component. SIX
 * components apply `responsive-surface-overlay` as a literal class string
 * instead, so they take `--layer-dialog` from the bare rule in `index.css`
 * without declaring anything, and no compile-time check could ever have
 * reached them. (An earlier draft of this comment said four. The set was
 * never re-derived after the two portaling ones were identified, which is a
 * different mistake from the one it was correcting.) Five are in the dock,
 * where the layer they take is clamped:
 *
 * - `DelegationLauncher` (#1180) and `MobileTaskSwitcher` portal themselves,
 *   so they already escape the dock and the free dialog layer is true for
 *   them.
 * - `ShareTargetPickerModal` reaches the dock through `ShareIntakeController`,
 *   which `ChatDock` mounts, and does NOT portal. It is inert today — the
 *   controller returns null unless the `share-intake` capability reports
 *   `enabled` — so it is a latent third instance rather than a live defect,
 *   and it is why "portal the two" is not the whole remedy.
 *
 * The sixth, `ProjectKnowledgeViewerModal`, is not in the dock at all, so
 * nothing clamps it; it still takes the dialog layer without declaring one.
 * - `CommandLauncher` and `ActiveWorkContextFrame` do NOT portal. They mount
 *   inside the dock, so the dialog layer they take is clamped by the dock's
 *   stacking context exactly as #1638 describes, and a notice covers them.
 *   The mount point is established as the CAUSE rather than assumed: all four
 *   were measured with identical markup, identical CSS and a marker at the
 *   notice layer, varying only where the overlay mounts — the two inside the
 *   dock hit the marker, the two outside hit their own control. Varying one
 *   thing in both directions is what rules out the alternative that they are
 *   covered for some reason of their own. Pre-existing and untouched by this
 *   change — filed as #1684 rather than folded in here.
 *
 * #1686 proposes closing the boundary structurally, with a static gate that
 * only the shared surface may apply this class in markup and these four as
 * dated exceptions, so the next borrowed class is a build failure.
 */
type ResponsiveSurfaceLayer = 'dialog' | 'popover' | 'system';
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
  layer,
  historyMode = 'entry',
  anchorRef,
}: ResponsiveDialogSurfaceProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement[]>([]);
  const capturedReturnFocus = useRef(false);
  const restoreFrame = useRef<number | null>(null);
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
  const [anchorSide, setAnchorSide] = useState<'above' | 'below'>('above');
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
  }, [initialFocusPolicy, initialFocusRef, isMobile, returnFocusTarget]);

  // Focus restoration, with a fallback for the case the trigger did not
  // survive (archive#1126). The behaviour lives in
  // `@kontourai/station-shared/return-focus` so the surfaces that do not render
  // this frame share one implementation — including the ones in other packages
  // (archive#1206, #1245). The panel node is read at mount, not in the cleanup:
  // React nulls refs as it tears the tree down.
  useEffect(() => {
    // StrictMode replays effect cleanup while the dialog remains mounted.
    // Cancel that provisional restore before it can pull focus out of the
    // live dialog. A real unmount still schedules the normal return path.
    if (restoreFrame.current !== null)
      cancelAnimationFrame(restoreFrame.current);
    const panel = panelRef.current;
    return () => {
      restoreFrame.current = restoreReturnFocus(returnFocusRef.current, panel);
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
      className={`${overlayClassName} responsive-surface-overlay`.trim()}
      style={{ ...visualViewport.style, ...anchorVars, ...overlayStyle }}
      data-responsive-layer={layer}
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
      data-anchored={anchorVars ? '' : undefined}
      data-anchor-side={anchorVars ? anchorSide : undefined}
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
    </div>,
    document.body,
  );
}
