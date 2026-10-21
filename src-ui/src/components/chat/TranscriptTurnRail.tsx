import {
  memo,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { ArrowDownGlyph, ArrowUpGlyph } from '../icons/Glyph';
import {
  type TranscriptTurnLandmark,
  type TranscriptTurnMarker,
  turnIndexForRow,
} from './transcriptTurnLandmarks';
import './TranscriptTurnRail.css';

/** Below this many user turns the transcript is short enough to scroll. */
export const TRANSCRIPT_TURN_NAVIGATION_MIN_TURNS = 6;
// The gutter needs a column this wide beside it, and a transcript this tall,
// to be a map rather than clutter; below either, the turn actions remain.
const RAIL_MIN_COLUMN_WIDTH_PX = 560;
const RAIL_MIN_TRANSCRIPT_HEIGHT_PX = 200;

const MARKER_TEXT: Record<TranscriptTurnMarker, string> = {
  failed: 'Ended with an error',
  subagent: 'Started a sub-agent',
};

/** Where the reader is, in turns. Changes only when the turn changes. */
export interface TranscriptTurnViewport {
  /** The turn owning the row at the transcript's vertical centre. */
  readonly activeTurn: number;
  /** Whether that turn's own prompt row is on screen. */
  readonly activeStartVisible: boolean;
}

const ROW_SELECTOR =
  ':scope > .chat-message-anchor[data-chat-message-key], [data-transcript-row]';

/**
 * Follows the transcript's scroll position in turns. The in-view marks on the
 * rail and its viewport band are written to the DOM from the scroll handler,
 * once per frame at most; React state changes only when the centre turn does.
 * Only mounted rows can be on screen, so reading their geometry is exact;
 * mapping them to turns goes through the full row model.
 */
export function useTranscriptTurnViewport({
  enabled,
  scrollElement,
  railRef,
  landmarks,
  rowIndexById,
  rowCount,
}: {
  enabled: boolean;
  scrollElement: RefObject<HTMLElement | null>;
  railRef: RefObject<HTMLElement | null>;
  landmarks: readonly TranscriptTurnLandmark[];
  rowIndexById: ReadonlyMap<string, number>;
  rowCount: number;
}): TranscriptTurnViewport {
  const [viewport, setViewport] = useState<TranscriptTurnViewport>({
    activeTurn: Math.max(0, landmarks.length - 1),
    activeStartVisible: true,
  });
  const modelRef = useRef({ landmarks, rowIndexById, rowCount });
  modelRef.current = { landmarks, rowIndexById, rowCount };
  // The last range written to the rail, so a frame that changes nothing
  // writes nothing.
  const drawnRef = useRef<{ rail: HTMLElement; key: string } | null>(null);
  const measureRef = useRef<() => void>(() => {});
  measureRef.current = () => {
    const element = scrollElement.current;
    const { landmarks, rowIndexById, rowCount } = modelRef.current;
    if (!element || landmarks.length === 0 || rowCount === 0) return;
    const bounds = element.getBoundingClientRect();
    if (bounds.height <= 0) return;
    const middle = bounds.top + bounds.height / 2;
    let first = Number.POSITIVE_INFINITY;
    let last = -1;
    let centre = -1;
    for (const node of element.querySelectorAll<HTMLElement>(ROW_SELECTOR)) {
      const key = node.dataset.transcriptRow ?? node.dataset.chatMessageKey;
      if (!key) continue;
      // The live streaming row is the newest turn's reply.
      const index =
        rowIndexById.get(key) ??
        (key.endsWith(':streaming') ? rowCount - 1 : undefined);
      if (index === undefined) continue;
      const rect = node.getBoundingClientRect();
      if (rect.bottom <= bounds.top || rect.top >= bounds.bottom) continue;
      first = Math.min(first, index);
      last = Math.max(last, index);
      if (rect.top <= middle) centre = Math.max(centre, index);
    }
    if (last < 0) return;
    if (centre < 0) centre = first;
    const activeTurn = turnIndexForRow(landmarks, centre);
    const activeStartVisible = landmarks[activeTurn]!.rowIndex >= first;
    const rail = railRef.current;
    const drawn = `${first}:${last}:${rowCount}`;
    if (
      rail &&
      (drawnRef.current?.rail !== rail || drawnRef.current.key !== drawn)
    ) {
      drawnRef.current = { rail, key: drawn };
      const firstTurn = turnIndexForRow(landmarks, first);
      const lastTurn = turnIndexForRow(landmarks, last);
      for (const tick of rail.querySelectorAll<HTMLElement>(
        '[data-turn-index]',
      )) {
        const turn = Number(tick.dataset.turnIndex);
        tick.toggleAttribute(
          'data-in-view',
          turn >= firstTurn && turn <= lastTurn,
        );
      }
      const band = rail.querySelector<HTMLElement>(
        '.transcript-turn-rail__band',
      );
      if (band) {
        band.style.top = `${(first / rowCount) * 100}%`;
        band.style.height = `${((last + 1 - first) / rowCount) * 100}%`;
      }
    }
    setViewport((current) =>
      current.activeTurn === activeTurn &&
      current.activeStartVisible === activeStartVisible
        ? current
        : { activeTurn, activeStartVisible },
    );
  };
  useEffect(() => {
    const element = scrollElement.current;
    if (!enabled || !element) return;
    let frame: number | undefined;
    const schedule = () => {
      if (frame !== undefined) return;
      frame = requestAnimationFrame(() => {
        frame = undefined;
        measureRef.current();
      });
    };
    element.addEventListener('scroll', schedule, { passive: true });
    const resize =
      typeof ResizeObserver === 'undefined'
        ? undefined
        : new ResizeObserver(schedule);
    resize?.observe(element);
    schedule();
    return () => {
      element.removeEventListener('scroll', schedule);
      resize?.disconnect();
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [enabled, scrollElement]);
  // Rows arriving or the rail mounting move the map without any scroll.
  useLayoutEffect(() => {
    void landmarks;
    void rowCount;
    if (enabled) measureRef.current();
  }, [enabled, landmarks, rowCount]);
  return viewport;
}

/** The previous/next turn a step from the reader's position lands on. */
export function turnStepTarget(
  viewport: TranscriptTurnViewport,
  direction: -1 | 1,
  turnCount: number,
): number | undefined {
  const target =
    direction > 0
      ? viewport.activeTurn + 1
      : // Part-way through a turn whose prompt is above the screen, the
        // previous step is that turn's own start.
        viewport.activeStartVisible
        ? viewport.activeTurn - 1
        : viewport.activeTurn;
  return target >= 0 && target < turnCount ? target : undefined;
}

interface TranscriptTurnRailProps {
  readonly landmarks: readonly TranscriptTurnLandmark[];
  readonly rowCount: number;
  readonly scrollElement: RefObject<HTMLElement | null>;
  readonly railRef: RefObject<HTMLElement | null>;
  readonly activeTurn: number;
  readonly onJump: (turnIndex: number) => void;
  /** Older history exists beyond the loaded rows (see `turnPosition`). */
  readonly olderHistory: boolean;
  /**
   * Whether the gutter has room to show (the column and height minimums
   * below), reported when it changes. The transcript offers a compact step
   * at the latest message while it has none.
   */
  readonly onAvailableChange?: (available: boolean) => void;
}

/**
 * A turn's position. The landmarks cover only the loaded rows; while older
 * history exists, the first loaded turn is not the conversation's first, so
 * the position is named as one among the loaded turns.
 */
function turnPosition(
  index: number,
  count: number,
  olderHistory: boolean,
): string {
  return olderHistory
    ? `Loaded turn ${index + 1} of ${count}`
    : `Turn ${index + 1} of ${count}`;
}

/** A turn's full name: position, prompt excerpt and any marker. */
export function turnLabel(
  landmark: TranscriptTurnLandmark,
  index: number,
  count: number,
  olderHistory: boolean,
): string {
  const marker = landmark.marker ? ` (${MARKER_TEXT[landmark.marker]})` : '';
  return `${turnPosition(index, count, olderHistory)}: ${landmark.prompt}${marker}`;
}

/**
 * A slim gutter beside the live transcript: one tick per user turn, placed by
 * the turn's position in the row model, with the reader's viewport drawn over
 * it. Hover or focus previews a turn; a press or drag jumps to it through the
 * transcript's own reveal path. Keyboard: the ticks are one tab stop, the
 * arrow keys move between turns, Home and End reach the ends.
 */
export const TranscriptTurnRail = memo(function TranscriptTurnRail({
  landmarks,
  rowCount,
  scrollElement,
  railRef,
  activeTurn,
  onJump,
  olderHistory,
  onAvailableChange,
}: TranscriptTurnRailProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const previewId = useId();
  const [hovered, setHovered] = useState<number>();
  const [focused, setFocused] = useState<number>();
  // Mirrors the host's `data-unavailable`: a hidden rail shows no preview,
  // which would otherwise stay mounted and take the next Escape.
  const [unavailable, setUnavailable] = useState(false);
  const availableChangeRef = useRef(onAvailableChange);
  availableChangeRef.current = onAvailableChange;
  const scrubRef = useRef<{ pointerId: number; last?: number } | null>(null);

  // The gutter sits over the transcript's right edge, inside its scrollbar,
  // and spans the transcript's visible height. Geometry is written straight
  // to the host: a resize is not a reason to re-render every tick.
  useLayoutEffect(() => {
    const element = scrollElement.current;
    const host = hostRef.current;
    if (!element || !host) return;
    const place = () => {
      host.style.setProperty(
        '--transcript-turn-rail-height',
        `${element.clientHeight}px`,
      );
      host.style.setProperty(
        '--transcript-turn-rail-scrollbar',
        `${Math.max(0, element.offsetWidth - element.clientWidth)}px`,
      );
      const hidden =
        element.clientWidth < RAIL_MIN_COLUMN_WIDTH_PX ||
        element.clientHeight < RAIL_MIN_TRANSCRIPT_HEIGHT_PX;
      host.toggleAttribute('data-unavailable', hidden);
      setUnavailable(hidden);
      // The pointer that was resting on the rail is no longer over anything.
      if (hidden) setHovered(undefined);
      availableChangeRef.current?.(!hidden);
    };
    place();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(place);
    observer.observe(element);
    return () => observer.disconnect();
  }, [scrollElement]);

  const nearestTurn = useCallback(
    (clientY: number): number | undefined => {
      const rail = railRef.current;
      if (!rail || landmarks.length === 0) return undefined;
      const rect = rail.getBoundingClientRect();
      if (rect.height <= 0) return undefined;
      const fraction = Math.min(
        1,
        Math.max(0, (clientY - rect.top) / rect.height),
      );
      const position = fraction * rowCount;
      const owner = turnIndexForRow(landmarks, Math.floor(position));
      const next = landmarks[owner + 1];
      return next &&
        next.rowIndex - position < position - landmarks[owner]!.rowIndex
        ? owner + 1
        : owner;
    },
    [landmarks, railRef, rowCount],
  );

  const scrubTo = (clientY: number) => {
    const scrub = scrubRef.current;
    const turn = nearestTurn(clientY);
    if (!scrub || turn === undefined || turn === scrub.last) return;
    scrub.last = turn;
    onJump(turn);
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    scrubRef.current = { pointerId: event.pointerId };
    scrubTo(event.clientY);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    setHovered(nearestTurn(event.clientY));
    if (scrubRef.current?.pointerId === event.pointerId) scrubTo(event.clientY);
  };
  const endScrub = (event: ReactPointerEvent<HTMLElement>) => {
    if (scrubRef.current?.pointerId !== event.pointerId) return;
    scrubRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };

  const focusTurn = (turn: number) => {
    const target = Math.min(landmarks.length - 1, Math.max(0, turn));
    railRef.current
      ?.querySelector<HTMLElement>(`[data-turn-index="${target}"]`)
      ?.focus();
    onJump(target);
  };
  const onTickKeyDown = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    turn: number,
  ) => {
    const step: Record<string, number> = {
      ArrowUp: turn - 1,
      ArrowLeft: turn - 1,
      ArrowDown: turn + 1,
      ArrowRight: turn + 1,
      Home: 0,
      End: landmarks.length - 1,
    };
    const target = step[event.key];
    if (target === undefined) return;
    event.preventDefault();
    focusTurn(target);
  };

  // Escape dismisses the preview where it stands (WCAG 1.4.13); pointing at
  // or focusing another turn, or leaving the rail, shows previews again.
  const [dismissed, setDismissed] = useState<number>();
  const target = unavailable ? undefined : (hovered ?? focused);
  useEffect(() => {
    if (dismissed !== undefined && target !== dismissed)
      setDismissed(undefined);
  }, [dismissed, target]);
  const preview = target === dismissed ? undefined : target;
  const previewed = preview === undefined ? undefined : landmarks[preview];
  // A hover preview shows while focus is elsewhere (often the composer), so
  // its Escape is heard on the window. Focus inside the rail handles its own.
  useEffect(() => {
    if (preview === undefined) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (railRef.current?.contains(document.activeElement)) return;
      setDismissed(preview);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [preview, railRef]);
  const tabStop = focused ?? Math.min(activeTurn, landmarks.length - 1);

  // Keep the preview beside its tick but inside the rail's height.
  useLayoutEffect(() => {
    const panel = previewRef.current;
    const rail = railRef.current;
    if (!panel || !rail || !previewed) return;
    const height = rail.clientHeight;
    const half = panel.offsetHeight / 2;
    const centre = (previewed.rowIndex / rowCount) * height;
    panel.style.top = `${Math.min(Math.max(centre, half), Math.max(half, height - half))}px`;
  }, [previewed, railRef, rowCount]);

  return (
    <div className="transcript-turn-rail-host" ref={hostRef}>
      <nav
        className="transcript-turn-rail"
        aria-label="Conversation turns"
        ref={railRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endScrub}
        onPointerCancel={endScrub}
        onPointerLeave={() => setHovered(undefined)}
        onKeyDown={(event) => {
          if (event.key !== 'Escape' || preview === undefined) return;
          // The preview is what Escape closes here, not the surface behind it.
          event.preventDefault();
          event.stopPropagation();
          setDismissed(preview);
        }}
        // A press here moves the transcript, not focus: a reader typing in
        // the composer keeps the caret where it was.
        onMouseDown={(event) => event.preventDefault()}
        onFocus={(event) => {
          const turn = Number(
            (event.target as HTMLElement).dataset.turnIndex ?? Number.NaN,
          );
          if (Number.isInteger(turn)) setFocused(turn);
        }}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node))
            setFocused(undefined);
        }}
      >
        <div className="transcript-turn-rail__band" aria-hidden="true" />
        <ol className="transcript-turn-rail__ticks">
          {landmarks.map((landmark, index) => (
            <li
              key={landmark.rowId}
              className="transcript-turn-rail__item"
              style={{ top: `${(landmark.rowIndex / rowCount) * 100}%` }}
            >
              <button
                type="button"
                className="transcript-turn-rail__tick"
                data-turn-index={index}
                data-marker={landmark.marker}
                tabIndex={index === tabStop ? 0 : -1}
                aria-current={index === activeTurn ? 'location' : undefined}
                aria-label={turnLabel(
                  landmark,
                  index,
                  landmarks.length,
                  olderHistory,
                )}
                aria-describedby={
                  focused === index && preview === index ? previewId : undefined
                }
                onKeyDown={(event) => onTickKeyDown(event, index)}
                // Pointer presses are handled by the rail (they also drag);
                // this is the keyboard's Enter and Space.
                onClick={(event) => {
                  if (event.detail === 0) onJump(index);
                }}
              />
            </li>
          ))}
        </ol>
        {previewed && preview !== undefined && (
          <div
            className="transcript-turn-rail__preview"
            id={previewId}
            ref={previewRef}
            role="tooltip"
            // While it shows, Escape is this preview's: the app's shortcut
            // dispatcher defers (`shouldIgnoreShortcut`), so its "go up one
            // level" and a layout's own Escape do not run first and leave
            // the preview open.
            data-escape-owner=""
          >
            <span className="transcript-turn-rail__preview-turn">
              {turnPosition(preview, landmarks.length, olderHistory)}
              {previewed.marker ? ` · ${MARKER_TEXT[previewed.marker]}` : ''}
            </span>
            <span className="transcript-turn-rail__preview-prompt">
              {previewed.prompt}
            </span>
            {previewed.reply && (
              <span className="transcript-turn-rail__preview-reply">
                {previewed.reply}
              </span>
            )}
          </div>
        )}
      </nav>
    </div>
  );
});

interface TranscriptTurnActionsProps {
  readonly previousTurn: number | undefined;
  readonly nextTurn: number | undefined;
  readonly onJump: (turnIndex: number) => void;
  /** Positioned over the transcript rather than placed in a host's row. */
  readonly floating: boolean;
  /**
   * At the latest message, with no rail to navigate by: Previous turn alone
   * (there is no next turn, and no Scroll to bottom to sit beside).
   */
  readonly latest?: boolean;
  /** The transcript's existing return-to-latest control. */
  readonly children?: ReactNode;
}

/**
 * Previous/next user turn, attached to the transcript's return-to-latest
 * control. The steps stay focusable at either end (`aria-disabled`, not
 * `disabled`), so a reader stepping with the keyboard keeps their place.
 */
export function TranscriptTurnActions({
  previousTurn,
  nextTurn,
  onJump,
  floating,
  latest = false,
  children,
}: TranscriptTurnActionsProps) {
  return (
    <fieldset
      className="transcript-turn-actions"
      aria-label="Turn navigation"
      data-floating={floating || undefined}
      data-latest={latest || undefined}
    >
      <button
        type="button"
        className="transcript-turn-actions__step"
        aria-label="Previous turn"
        title="Previous turn"
        aria-disabled={previousTurn === undefined || undefined}
        onClick={() => previousTurn !== undefined && onJump(previousTurn)}
      >
        <ArrowUpGlyph />
      </button>
      {!latest && (
        <button
          type="button"
          className="transcript-turn-actions__step"
          aria-label="Next turn"
          title="Next turn"
          aria-disabled={nextTurn === undefined || undefined}
          onClick={() => nextTurn !== undefined && onJump(nextTurn)}
        >
          <ArrowDownGlyph />
        </button>
      )}
      {children}
    </fieldset>
  );
}
