import {
  type PointerEvent,
  type ReactNode,
  type Ref,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { Button } from '../Button';
import {
  MOBILE_DOCK_COLLAPSE_FLING_VELOCITY,
  TAP_MOVE_THRESHOLD,
} from '../chat-dock/dockSnap';
import {
  ResponsiveDialogHeader,
  ResponsiveDialogSurface,
  ResponsiveSurfaceActions,
} from '../ResponsiveDialogSurface';
import './RequestSheet.css';

/**
 * #3331: the phone surface for every request that needs the person — a tool
 * server's form (#3284) and a tool approval today. Desktop keeps each
 * feature's inline card; a phone gets the feature's compact card in the
 * transcript plus this one sheet, so there is no per-feature mobile variant.
 *
 * The sheet has exactly one way to answer: the feature's own actions, which
 * it pins to the bottom edge. Every other way out — the backdrop, a swipe
 * down, Escape, Android back, the close control — only HIDES it. The request
 * stays open and the card's Answer reopens it.
 */

/** What the card says about the request. Derived by the caller, never stored here. */
export type RequestCardState =
  | 'pending'
  | 'answered'
  | 'declined'
  | 'cancelled';

const STATE_LABEL: Record<RequestCardState, string> = {
  pending: 'Waiting for you',
  answered: 'Answered',
  declined: 'Declined',
  cancelled: 'Cancelled',
};

/**
 * Open/closed state for one request's sheet. `pending` covers the answer
 * given HERE: once the caller's own action settles the request, the sheet
 * closes in that same render rather than an effect later. A request resolved
 * ELSEWHERE (another device, a timeout, a stopped turn) does not pass through
 * this flag today: it leaves the pending list, which unmounts the card and
 * its sheet with it (R7).
 */
export function useRequestSheet(pending: boolean) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!pending) setOpen(false);
  }, [pending]);
  return {
    open: open && pending,
    show: () => setOpen(true),
    dismiss: () => setOpen(false),
    triggerRef,
  };
}

/** The Answer control that opens a request's sheet; focus returns here. */
export function RequestSheetTrigger({
  onClick,
  ref,
  compact = false,
}: {
  onClick: () => void;
  ref: Ref<HTMLButtonElement>;
  /**
   * For a trigger beside a one-line transcript row: drawn small and
   * secondary, with a hit area that is still at least 44px.
   */
  compact?: boolean;
}) {
  return (
    <Button
      ref={ref}
      variant={compact ? 'secondary' : 'primary'}
      size={compact ? 'sm' : 'md'}
      className={
        compact
          ? 'request-sheet-trigger request-sheet-trigger--compact'
          : 'request-sheet-trigger'
      }
      aria-haspopup="dialog"
      onClick={onClick}
    >
      Answer
    </Button>
  );
}

/**
 * The compact, persistent transcript card (R1): who is asking, the question,
 * its state, and — while it is still waiting — the Answer control.
 */
export function RequestCard({
  asker,
  question,
  state,
  onAnswer,
  triggerRef,
  notice,
}: {
  asker: ReactNode;
  question: ReactNode;
  state: RequestCardState;
  onAnswer: () => void;
  triggerRef: Ref<HTMLButtonElement>;
  /**
   * Something the person must see while the sheet is closed — a failure
   * that landed after they dismissed it.
   */
  notice?: ReactNode;
}) {
  const headingId = useId();
  return (
    <section
      className="request-card"
      aria-labelledby={headingId}
      data-state={state}
    >
      <div className="request-card__heading">
        <strong id={headingId}>{asker}</strong>
        {/* A live region, so an answer from anywhere is heard here. */}
        <span className="request-card__state" role="status">
          {STATE_LABEL[state]}
        </span>
      </div>
      <p className="request-card__question">{question}</p>
      {notice}
      {state === 'pending' && (
        <RequestSheetTrigger ref={triggerRef} onClick={onAnswer} />
      )}
    </section>
  );
}

/** A release this far down, or a downward flick, dismisses. */
const DISMISS_FRACTION = 0.25;
const DISMISS_MAX_PX = 120;

interface DragGesture {
  pointerId: number;
  startY: number;
  lastY: number;
  lastTime: number;
  velocity: number;
}

/**
 * The bottom sheet. Height follows content (R2): the panel grows with its
 * body up to the visual viewport, then the body scrolls while the header and
 * `actions` stay put (R3). `ResponsiveDialogSurface` supplies dialog
 * semantics, focus containment and return, Escape, back-gesture history and
 * visual-viewport containment, so the sheet rides above the keyboard (R5/R6).
 */
export function RequestSheet({
  title,
  subtitle,
  onDismiss,
  returnFocusTarget,
  children,
  actions,
}: {
  /** Also the dialog's accessible name. */
  title: string;
  subtitle?: ReactNode;
  /** Hides the sheet. Never answers the request. */
  onDismiss: () => void;
  returnFocusTarget: HTMLElement | null;
  /** The scrolling body. */
  children: ReactNode;
  /** The feature's own answer actions, pinned to the bottom edge. */
  actions: ReactNode;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const gesture = useRef<DragGesture | null>(null);
  const [offset, setOffset] = useState(0);

  // R5: when the keyboard opens, the sheet shrinks with the visual viewport
  // (a frame after the viewport reports it), which can bury the field that
  // summoned the keyboard. Watching the body's own size catches the moment
  // the shrink actually lands.
  useEffect(() => {
    const body = bodyRef.current;
    if (!body || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      const active = document.activeElement;
      if (active instanceof HTMLElement && body.contains(active))
        active.scrollIntoView({ block: 'nearest' });
    });
    observer.observe(body);
    return () => observer.disconnect();
  }, []);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    // The close control is a button, not a grab point.
    if ((event.target as Element).closest('button')) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      lastY: event.clientY,
      lastTime: event.timeStamp,
      velocity: 0,
    };
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = gesture.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const elapsed = event.timeStamp - drag.lastTime;
    if (elapsed > 0) drag.velocity = (event.clientY - drag.lastY) / elapsed;
    drag.lastY = event.clientY;
    drag.lastTime = event.timeStamp;
    const distance = Math.max(0, event.clientY - drag.startY);
    setOffset(distance > TAP_MOVE_THRESHOLD ? distance : 0);
  };

  const endDrag = (event: PointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const drag = gesture.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    gesture.current = null;
    const distance = Math.max(0, event.clientY - drag.startY);
    const panelHeight =
      event.currentTarget.closest('.request-sheet')?.getBoundingClientRect()
        .height ?? 0;
    const threshold = Math.min(
      DISMISS_MAX_PX,
      Math.max(TAP_MOVE_THRESHOLD, panelHeight * DISMISS_FRACTION),
    );
    const dismiss =
      !cancelled &&
      distance > TAP_MOVE_THRESHOLD &&
      (distance >= threshold ||
        drag.velocity >= MOBILE_DOCK_COLLAPSE_FLING_VELOCITY);
    setOffset(0);
    if (dismiss) onDismiss();
  };

  return (
    <ResponsiveDialogSurface
      layer="dialog"
      onClose={onDismiss}
      ariaLabel={title}
      historyMode="entry"
      returnFocusTarget={returnFocusTarget}
      overlayClassName="request-sheet__overlay"
      panelClassName={
        offset > 0 ? 'request-sheet request-sheet--dragging' : 'request-sheet'
      }
      panelStyle={
        offset > 0 ? { transform: `translateY(${offset}px)` } : undefined
      }
    >
      <div
        className="request-sheet__grab"
        data-testid="request-sheet-grab"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(event) => endDrag(event, false)}
        onPointerCancel={(event) => endDrag(event, true)}
      >
        <span className="request-sheet__handle" aria-hidden="true" />
        <ResponsiveDialogHeader
          title={title}
          subtitle={subtitle}
          closeLabel="Close and answer later"
          onClose={onDismiss}
        />
      </div>
      <div ref={bodyRef} className="request-sheet__body">
        {children}
      </div>
      <ResponsiveSurfaceActions className="request-sheet__actions">
        {actions}
      </ResponsiveSurfaceActions>
    </ResponsiveDialogSurface>
  );
}
