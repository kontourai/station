import type { ChildWorkItem } from '@kontourai/station-contracts/child-work';
import {
  type ContextType,
  memo,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { useAnchoredPopup } from '../../hooks/useAnchoredPopup';
import { useElapsedClock } from '../../hooks/useElapsedClock';
import { motionTokenMs, prefersReducedMotion } from '../../lib/reduced-motion';
import { formatDuration } from '../../utils/relativeTime';
import {
  ChatActivityChildren,
  ChatActivityMarks,
} from './ChatActivityChildren';
import type { ChatStatus } from './chatStatus';
import {
  LiveStatusGlyph,
  trackPageVisibilityForStatusMotion,
} from './LiveStatusGlyph';
import type { ScheduledCheckBackContext } from './ScheduledCheckBackContext';

/** How long a one-shot confirmation ("Resumed") stays before the pill moves on. */
export const CHAT_STATUS_CELEBRATE_MS = 1_100;
/** The float-out (`--motion-fast`); the pill unmounts after it. */
const LEAVE_MS = 150;

/**
 * The turn clock, the pill's only ticking part: it re-renders this one text
 * node off the shared elapsed clock, which stops while the page is hidden.
 * Uses the same duration words as rows and other live clocks.
 */
const PillClock = memo(function PillClock({ from }: { from: number }) {
  const now = useElapsedClock();
  return (
    <span className="chat-status-pill__clock" aria-hidden="true">
      {formatDuration(now - from)}
    </span>
  );
});

function PillDetails({
  id,
  lines,
  children,
  host,
  onDismiss,
}: {
  id: string;
  lines: ChatStatus['details'];
  children?: ReactNode;
  host: RefObject<HTMLElement | null>;
  onDismiss(): void;
}) {
  const now = useElapsedClock();
  const panel = useRef<HTMLDivElement>(null);
  const anchor = useRef(
    host.current?.closest<HTMLElement>('.chat-input') ?? null,
  );
  const { popupStyle, renderPopup } = useAnchoredPopup(
    anchor.current ? anchor : undefined,
  );
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !panel.current?.contains(event.target) &&
        !host.current?.contains(event.target)
      )
        onDismiss();
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      onDismiss();
      host.current?.querySelector('button')?.focus();
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', onEscape, true);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', onEscape, true);
    };
  }, [host, onDismiss]);
  return renderPopup(
    <div
      ref={panel}
      id={id}
      className="chat-status-pill__details"
      style={popupStyle}
    >
      {lines.map((line) => (
        <p key={line.text}>
          {line.since === undefined
            ? line.text
            : `${line.text} · ${formatDuration(now - line.since)}`}
        </p>
      ))}
      {children}
    </div>,
  );
}

/**
 * The chat pane's status beside the composer: approval, connection, or what
 * the turn is doing (see `deriveChatStatus` for the priority).
 *
 * Motion carries meaning and nothing else: it floats in when there is
 * something to say and out when there is not; a change of state re-keys the
 * body so it morphs rather than pops; a decision landing or the connection
 * coming back settles with a one-shot burst. State-driven width changes use
 * the shared motion token; reduced motion swaps states instantly.
 *
 * Accessibility: one polite live region announces the state (kind-level
 * label, never the ticking clock); the pill itself is a button when a tap
 * does something.
 */
export function ChatStatusPill({
  status,
  checkBack,
  runningChildren,
  onRevealApproval,
  onRepair,
  onResync,
  onRecoveryFocus,
}: {
  status: ChatStatus | undefined;
  checkBack?: ContextType<typeof ScheduledCheckBackContext>;
  runningChildren?: readonly ChildWorkItem[];
  onRevealApproval?: () => void;
  onRepair?: () => void;
  /** Re-reads this conversation's status and history from the Station. */
  onResync?: () => void;
  /** Focus the recovered composer without changing its write permission. */
  onRecoveryFocus?: () => boolean;
}) {
  useEffect(trackPageVisibilityForStatusMotion, []);
  const detailsId = useId();
  const hostRef = useRef<HTMLElement>(null);
  const resyncControl = useRef<HTMLButtonElement | null>(null);
  const recoveryPending = useRef(false);
  const [liveAnnouncement, setLiveAnnouncement] = useState('');
  const lastWidth = useRef<number | undefined>(undefined);
  const resizeAnimation = useRef<Animation | undefined>(undefined);
  useEffect(() => () => resizeAnimation.current?.cancel(), []);
  const [expanded, setExpanded] = useState(false);
  const closeDetails = useCallback(() => setExpanded(false), []);

  // A decision the user made lands as a brief "Resumed" before the pill
  // shows whatever comes next — the approval did not just vanish.
  const previousKind = useRef<ChatStatus['kind'] | undefined>(undefined);
  const [celebrating, setCelebrating] = useState(false);
  // Owned by the celebration itself, not by the status that started it: the
  // next change of state (the turn ending, a new one starting) must not
  // cancel the timer that ends it, or the pill would stay "Resumed".
  const celebrationTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(
    () => () => {
      if (celebrationTimer.current) clearTimeout(celebrationTimer.current);
    },
    [],
  );
  useEffect(() => {
    const was = previousKind.current;
    previousKind.current = status?.kind;
    if (
      status?.kind === 'approval' ||
      status?.kind === 'answer' ||
      status?.kind === 'blocked'
    ) {
      if (celebrationTimer.current) clearTimeout(celebrationTimer.current);
      setCelebrating(false);
      return;
    }
    if (was !== 'approval' && was !== 'answer') return;
    setCelebrating(true);
    if (celebrationTimer.current) clearTimeout(celebrationTimer.current);
    celebrationTimer.current = setTimeout(
      () => setCelebrating(false),
      CHAT_STATUS_CELEBRATE_MS,
    );
  }, [status?.kind]);

  const shown: ChatStatus | undefined = celebrating
    ? {
        kind: 'resumed',
        tone: 'active',
        glyph: 'done',
        label: 'Resumed',
        details: [],
        action: undefined,
      }
    : status;

  // Presence: the last status stays on screen for the float-out, then goes.
  const lastShown = useRef<ChatStatus | undefined>(undefined);
  if (shown) lastShown.current = shown;
  const isShown = shown !== undefined;
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    if (isShown) {
      setLeaving(false);
      return;
    }
    if (!lastShown.current) return;
    if (prefersReducedMotion()) {
      lastShown.current = undefined;
      setLeaving(false);
      return;
    }
    setLeaving(true);
    const timer = setTimeout(() => {
      lastShown.current = undefined;
      setLeaving(false);
    }, LEAVE_MS);
    return () => clearTimeout(timer);
  }, [isShown]);

  const hasCheckBack =
    !!checkBack && (shown?.kind === 'waiting' || shown?.kind === 'working');
  const children =
    shown?.kind === 'working' && runningChildren?.length
      ? runningChildren
      : undefined;
  const hasDetails = !!children || hasCheckBack;
  const shownAction = hasDetails ? 'details' : shown?.action;
  useEffect(() => {
    if (shownAction !== 'details') setExpanded(false);
  }, [shownAction]);

  const current = shown ?? (leaving ? lastShown.current : undefined);
  const announcement =
    shown?.action === 'reveal-approval' && shown.count !== undefined
      ? `${shown.label} (${shown.count})`
      : (shown?.label ?? '');
  useEffect(() => {
    if (status?.action === 'resync') recoveryPending.current = true;
    // Blocked repair ends the attempt: a later reconnect is not its completion.
    else if (status?.kind === 'blocked') recoveryPending.current = false;
    const completed =
      recoveryPending.current &&
      status?.action !== 'resync' &&
      status?.kind !== 'blocked' &&
      status?.kind !== 'reconnecting' &&
      status?.kind !== 'catching-up';
    if (completed) {
      recoveryPending.current = false;
      const activeElement = document.activeElement;
      if (
        (!activeElement ||
          activeElement === document.body ||
          activeElement === resyncControl.current) &&
        !document.querySelector(
          '[role="dialog"], [role="alertdialog"], dialog[open]',
        )
      )
        onRecoveryFocus?.();
    }
    setLiveAnnouncement(
      completed
        ? `Conversation resynced.${announcement ? ` ${announcement}` : ''}`
        : announcement,
    );
  }, [status?.action, status?.kind, announcement, onRecoveryFocus]);
  const currentLabel = current?.label;
  const currentCount = current?.count;
  const hasClock = current?.clockFrom !== undefined;
  // biome-ignore lint/correctness/useExhaustiveDependencies: measure when the visible label, badge, or clock column changes; clock ticks stay isolated.
  useLayoutEffect(() => {
    const element = hostRef.current;
    if (!element?.querySelector('[data-chat-status-pill]')) {
      resizeAnimation.current?.cancel();
      lastWidth.current = undefined;
      return;
    }
    const previous =
      resizeAnimation.current?.playState === 'running'
        ? element.offsetWidth
        : lastWidth.current;
    resizeAnimation.current?.cancel();
    const width = element.offsetWidth;
    lastWidth.current = width;
    if (
      previous === undefined ||
      previous === width ||
      prefersReducedMotion() ||
      typeof element.animate !== 'function'
    )
      return;
    const style = getComputedStyle(element);
    resizeAnimation.current = element.animate(
      [{ width: `${previous}px` }, { width: `${width}px` }],
      {
        duration: motionTokenMs(style, '--motion-base'),
        easing: style.getPropertyValue('--ease-standard').trim(),
      },
    );
  }, [currentLabel, currentCount, hasClock]);
  const celebrate = current?.kind === 'resumed' || current?.kind === 'restored';

  const activate = () => {
    if (!current) return;
    if (current.action === 'reveal-approval') onRevealApproval?.();
    else if (current.action === 'repair') onRepair?.();
    else if (current.action === 'resync') onResync?.();
    else if (shownAction === 'details') setExpanded((open) => !open);
  };
  const actionable = Boolean(
    current &&
      !leaving &&
      ((current.action === 'reveal-approval' && onRevealApproval) ||
        (current.action === 'repair' && onRepair) ||
        (current.action === 'resync' && onResync) ||
        (shownAction === 'details' &&
          (current.details.length > 0 || hasDetails))),
  );
  const body = current && (
    <span
      className="chat-status-pill__body"
      // Re-keyed per state: the morph animation replays on a change of kind,
      // never on a label or clock update within one.
      key={current.kind}
    >
      <LiveStatusGlyph kind={current.glyph} />
      <span className="chat-status-pill__label">{current.label}</span>
      {hasCheckBack && current.kind === 'waiting' && (
        <span className="chat-status-pill__clock">{checkBack?.nextTime}</span>
      )}
      {current.count !== undefined && (
        <span className="chat-status-pill__count" aria-hidden="true">
          {current.count}
        </span>
      )}
      {current.clockFrom !== undefined && (
        <PillClock from={current.clockFrom} />
      )}
      {children && <ChatActivityMarks items={children} />}
      {current.action === 'resync' && onResync && (
        <span className="chat-status-pill__action" aria-hidden="true">
          {current.pending ? 'Resyncing…' : 'Resync'}
        </span>
      )}
    </span>
  );
  const common = {
    className: 'chat-status-pill',
    'data-chat-status-pill': current?.kind,
    'data-entering': lastWidth.current === undefined ? 'true' : undefined,
    'data-tone': current?.tone,
    'data-leaving': leaving ? 'true' : undefined,
    'data-celebrate': celebrate ? 'true' : undefined,
  } as const;

  return (
    <>
      {/* The narrow composer hides an empty status rail, including its descendants. */}
      {createPortal(
        <span
          className="sr-only"
          style={{ position: 'fixed', top: 0, left: 0 }}
          role="status"
          aria-live="polite"
        >
          {liveAnnouncement}
        </span>,
        document.body,
      )}
      <section
        className="chat-status-pill-host"
        ref={hostRef}
        tabIndex={-1}
        aria-label="Conversation status"
      >
        {current &&
          (actionable ? (
            <button
              type="button"
              {...common}
              aria-label={
                current.action === 'reveal-approval'
                  ? current.count !== undefined
                    ? `${current.label} (${current.count}) — show the requests`
                    : `${current.label} — show the request`
                  : current.action === 'repair'
                    ? `${current.label} — repair the connection`
                    : current.action === 'resync'
                      ? `${current.label} — resync this conversation`
                      : hasCheckBack && current.kind === 'waiting'
                        ? `Waiting · ${checkBack?.nextTime}`
                        : current.label
              }
              aria-expanded={shownAction === 'details' ? expanded : undefined}
              aria-controls={
                shownAction === 'details' && expanded ? detailsId : undefined
              }
              disabled={current.action === 'resync' && current.pending}
              aria-busy={
                current.action === 'resync' ? current.pending : undefined
              }
              ref={current.action === 'resync' ? resyncControl : undefined}
              onClick={activate}
            >
              {body}
            </button>
          ) : (
            <div {...common} aria-hidden="true">
              {body}
            </div>
          ))}
        {current &&
          expanded &&
          !leaving &&
          shownAction === 'details' &&
          (current.details.length > 0 || hasDetails) && (
            <PillDetails
              id={detailsId}
              lines={current.details}
              host={hostRef}
              onDismiss={closeDetails}
            >
              {children && (
                <ChatActivityChildren items={children} onOpen={closeDetails} />
              )}
              {hasCheckBack && checkBack?.notes}
            </PillDetails>
          )}
      </section>
    </>
  );
}
