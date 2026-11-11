import {
  Fragment,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useIsMobile } from '../../hooks/useIsMobile';
import { Button } from '../Button';
import {
  type ChatScrollAnchor,
  captureChatScrollAnchor,
  restoreChatScrollAnchor,
} from '../chat/chatScrollAnchor';
import { TranscriptVirtualizer } from '../chat/TranscriptVirtualizer';
import { useTouchKeyboard } from './composerKeys';
import {
  groupRows,
  type RoomRowPlacement,
  roomDayLabel,
  roomFullTime,
  roomShortTime,
} from './groupRows';
import { RoomAvatar } from './RoomAvatar';
import { RoomMessageText } from './RoomMessageText';
import './RoomConversation.css';

export interface RoomConversationRow {
  readonly id: string;
  readonly kind: 'message' | 'system';
  readonly author?: {
    /** Stable identity; grouping never compares labels. */
    readonly id: string;
    readonly label: string;
    readonly agent: boolean;
  };
  /** ISO timestamp. */
  readonly at?: string;
  /** A reply starts its own group and shows its context line. */
  readonly reply?: boolean;
  /** Line above the body, such as "Replying to Jonas". */
  readonly context?: ReactNode;
  /** Markdown body. Ignored when `body` is given. */
  readonly text?: string;
  /** Custom body (an agent answer with its own Show more). */
  readonly body?: ReactNode;
  readonly attachments?: ReactNode;
  /** Under the body: a thread summary or a delivery state. */
  readonly footer?: ReactNode;
  /** The row's action bar: shown on hover, focus or long press. */
  readonly actions?: ReactNode;
  readonly tone?: 'failed' | 'pending';
  /** Written by the reader: the list follows it instead of counting it as new. */
  readonly own?: boolean;
}

/** How close to the end still counts as reading the latest message. */
const FOLLOW_SLACK_PX = 48;
/** Scrolling this close to the top asks for older history. */
const OLDER_BAND_PX = 320;
/** A scroll this soon after wheel, touch, key or pointer input is the reader's. */
const READER_INPUT_MS = 800;
const LONG_PRESS_MS = 450;
/**
 * A short room renders every row; a long one hands its rows to the shared
 * transcript virtualizer, which keeps the reader's row across a prepend.
 */
export const ROOM_VIRTUALIZE_AFTER = 120;
/** Live rows (a working agent) ride at the end of the virtual list. */
const TRAILING_ROW = 'room-conversation:trailing';

function gutterTime(at: string) {
  // The gutter is narrow: hours and minutes without the day period.
  const parts = new Intl.DateTimeFormat([], {
    hour: 'numeric',
    minute: '2-digit',
  }).formatToParts(new Date(at));
  return parts
    .filter((part) => part.type !== 'dayPeriod')
    .map((part) => part.value)
    .join('')
    .trim();
}

function RowTime({ at, gutter = false }: { at?: string; gutter?: boolean }) {
  if (!at || !Number.isFinite(Date.parse(at))) return null;
  return (
    <time
      className={gutter ? 'room-row__gutter-time' : 'room-row__time'}
      dateTime={at}
      title={roomFullTime(at)}
    >
      {gutter ? gutterTime(at) : roomShortTime(at)}
    </time>
  );
}

function Row({
  row,
  placement,
  unread,
  actionsOpen,
  onLongPress,
}: {
  row: RoomConversationRow;
  placement: RoomRowPlacement;
  unread: boolean;
  actionsOpen: boolean;
  onLongPress(id: string): void;
}) {
  const press = useRef<number | undefined>(undefined);
  const origin = useRef<{ x: number; y: number } | undefined>(undefined);
  const cancelPress = useCallback(() => {
    if (press.current !== undefined) window.clearTimeout(press.current);
    press.current = undefined;
  }, []);
  useEffect(() => cancelPress, [cancelPress]);
  const touchHandlers = row.actions
    ? {
        onPointerDown: (event: React.PointerEvent) => {
          if (event.pointerType !== 'touch') return;
          origin.current = { x: event.clientX, y: event.clientY };
          cancelPress();
          press.current = window.setTimeout(() => {
            press.current = undefined;
            onLongPress(row.id);
          }, LONG_PRESS_MS);
        },
        onPointerMove: (event: React.PointerEvent) => {
          const start = origin.current;
          if (
            start &&
            Math.hypot(event.clientX - start.x, event.clientY - start.y) > 8
          )
            cancelPress();
        },
        onPointerUp: cancelPress,
        onPointerCancel: cancelPress,
        onContextMenu: (event: React.MouseEvent) => {
          if (actionsOpen) event.preventDefault();
        },
      }
    : {};
  const day =
    placement.newDay && row.at ? (
      <div className="room-divider room-divider--day">
        <span>{roomDayLabel(row.at)}</span>
      </div>
    ) : null;
  const newMarker = unread ? (
    <div className="room-divider room-divider--unread">
      <span>
        New<span className="sr-only"> messages</span>
      </span>
    </div>
  ) : null;
  if (row.kind === 'system')
    return (
      // biome-ignore lint/a11y/useSemanticElements: virtualized rows sit in positioned wrappers, so an <li> could not be a direct child of a <ul>.
      <div role="listitem" className="room-item" data-chat-message-key={row.id}>
        {day}
        {newMarker}
        <div
          className={`room-row room-row--system${row.tone ? ` room-row--${row.tone}` : ''}`}
        >
          <span className="room-row__system-text">{row.body ?? row.text}</span>
          <RowTime at={row.at} />
          {row.actions && (
            <span className="room-row__system-actions">{row.actions}</span>
          )}
        </div>
      </div>
    );
  const stacked = placement.stackPrevious;
  return (
    // biome-ignore lint/a11y/useSemanticElements: virtualized rows sit in positioned wrappers, so an <li> could not be a direct child of a <ul>.
    <div role="listitem" className="room-item" data-chat-message-key={row.id}>
      {day}
      {newMarker}
      <div
        className={[
          'room-row',
          'room-row--message',
          stacked && 'room-row--stacked',
          placement.stackNext && 'room-row--continues',
          row.tone && `room-row--${row.tone}`,
          actionsOpen && 'room-row--actions-open',
        ]
          .filter(Boolean)
          .join(' ')}
        data-room-author={row.author?.agent ? 'agent' : 'person'}
        {...touchHandlers}
      >
        <div className="room-row__gutter">
          {stacked ? (
            <RowTime at={row.at} gutter />
          ) : (
            <RoomAvatar
              name={row.author?.label ?? '?'}
              agent={row.author?.agent}
            />
          )}
        </div>
        <div className="room-row__main">
          {!stacked && (
            <div className="room-row__header">
              <strong className="room-row__author">
                {row.author?.label ?? 'Unknown'}
              </strong>
              {row.author?.agent && (
                <span className="room-row__badge">Agent</span>
              )}
              <RowTime at={row.at} />
            </div>
          )}
          {row.context && (
            <div className="room-row__context">{row.context}</div>
          )}
          <div className="room-row__body">
            {row.body ??
              (row.text !== undefined ? (
                <RoomMessageText text={row.text} />
              ) : null)}
          </div>
          {row.attachments}
          {row.footer && <div className="room-row__footer">{row.footer}</div>}
        </div>
        {row.actions && (
          <div
            className="room-row__actions"
            role="toolbar"
            aria-label={`Actions for ${row.author?.label ?? 'message'}`}
          >
            {row.actions}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The one conversation list for Project and Task rooms. Rows group by author
 * and day; the list follows the newest row until the reader scrolls up,
 * keeps the reader's row in place while older history loads above, and counts
 * rows that arrive while the reader is away.
 */
export function RoomConversation({
  label,
  rows,
  loading = false,
  status,
  empty,
  hasOlder = false,
  loadingOlder = false,
  onLoadOlder,
  trailing,
  className,
}: {
  /** Accessible name of the message list. */
  label: string;
  /** Oldest first. */
  rows: readonly RoomConversationRow[];
  loading?: boolean;
  /** A failure or notice shown above the rows (with its own recovery). */
  status?: ReactNode;
  /** Shown when there are no rows and nothing is loading. */
  empty?: ReactNode;
  hasOlder?: boolean;
  loadingOlder?: boolean;
  onLoadOlder?(): void;
  /** Live rows after the history, such as a working agent. */
  trailing?: ReactNode;
  className?: string;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const [isFollowing, setIsFollowing] = useState(true);
  const [anchorVersion, setAnchorVersion] = useState(0);
  const [followTick, setFollowTick] = useState(0);
  const readerInputAt = useRef(-Infinity);
  const pressedAt = useRef(-Infinity);
  const readerAnchor = useRef<ChatScrollAnchor | null>(null);
  // Where the list last scrolled itself. A scroll event landing there is
  // the list's own correction, never the reader moving.
  const programmaticTop = useRef<number | undefined>(undefined);
  const noteProgrammatic = useCallback((element: HTMLElement) => {
    programmaticTop.current = element.scrollTop;
  }, []);
  const virtualize = rows.length > ROOM_VIRTUALIZE_AFTER;
  const compact = useIsMobile();
  const touch = useTouchKeyboard();
  const [unseen, setUnseen] = useState(0);
  const [unreadFrom, setUnreadFrom] = useState<string>();
  const [actionsFor, setActionsFor] = useState<string>();
  const placements = useMemo(
    () =>
      groupRows(
        rows.map((row) => ({
          kind: row.kind,
          authorId: row.author?.id,
          at: row.at,
          reply: row.reply,
        })),
      ),
    [rows],
  );
  const virtualRows = useMemo(
    () =>
      rows.map((row, index) => ({
        id: row.id,
        kind:
          row.kind === 'system'
            ? 'message:system'
            : placements[index]?.stackPrevious
              ? 'room:stacked'
              : 'message:user',
        index,
      })),
    [rows, placements],
  );
  const hasTrailing = !!trailing;
  const listRows = useMemo(
    () =>
      hasTrailing
        ? [
            ...virtualRows,
            { id: TRAILING_ROW, kind: 'message:system', index: -1 },
          ]
        : virtualRows,
    [virtualRows, hasTrailing],
  );

  const setFollowing = useCallback((next: boolean) => {
    following.current = next;
    setIsFollowing(next);
    if (next) {
      // Reading to the end retires the New marker; the next time away
      // marks its own first arrival (#4810 review 5).
      setUnseen(0);
      setUnreadFrom(undefined);
    }
  }, []);

  const pin = useCallback(() => {
    const element = scroller.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
    noteProgrammatic(element);
  }, [noteProgrammatic]);

  const jumpToLatest = useCallback(() => {
    setFollowing(true);
    setFollowTick((tick) => tick + 1);
    pin();
  }, [pin, setFollowing]);

  // New rows at the end: follow them, or count them while the reader is away.
  const known = useRef<Set<string> | undefined>(undefined);
  const lastId = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    const previousLast = lastId.current;
    const seen = known.current;
    lastId.current = rows.at(-1)?.id;
    known.current = new Set(rows.map((row) => row.id));
    if (!seen || !previousLast) return;
    const start = rows.findIndex((row) => row.id === previousLast);
    if (start < 0) return;
    const fresh = rows.slice(start + 1).filter((row) => !seen.has(row.id));
    if (!fresh.length) return;
    if (fresh.some((row) => row.own)) {
      setUnreadFrom(undefined);
      jumpToLatest();
      return;
    }
    if (following.current) {
      setFollowTick((tick) => tick + 1);
      return;
    }
    const arrived = fresh.filter((row) => row.kind === 'message');
    if (!arrived.length) return;
    setUnseen((count) => count + arrived.length);
    setUnreadFrom((current) => current ?? arrived[0]?.id);
  }, [rows, jumpToLatest]);

  // Unvirtualized rows: stay at the end, or keep the reader's row where it
  // was when rows arrive above (older history) or below.
  useLayoutEffect(() => {
    void rows;
    const element = scroller.current;
    if (virtualize || !element) return;
    if (following.current) pin();
    else if (readerAnchor.current) {
      restoreChatScrollAnchor(element, readerAnchor.current);
      noteProgrammatic(element);
    }
  }, [rows, virtualize, pin, noteProgrammatic]);

  // Late growth (Markdown, images, a live row) keeps the end in view, unless
  // the reader just pressed something in the list (Show more) and is reading it.
  useLayoutEffect(() => {
    const element = content.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (
        following.current &&
        performance.now() - pressedAt.current > READER_INPUT_MS
      )
        pin();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [pin]);

  const markReaderInput = useCallback(() => {
    readerInputAt.current = performance.now();
  }, []);
  const markPress = useCallback(() => {
    readerInputAt.current = performance.now();
    pressedAt.current = readerInputAt.current;
  }, []);
  const captureReader = () => {
    const element = scroller.current;
    if (element) readerAnchor.current = captureChatScrollAnchor(element);
  };
  const loadOlder = () => {
    if (!onLoadOlder || loadingOlder) return;
    captureReader();
    setAnchorVersion((version) => version + 1);
    onLoadOlder();
  };

  const onScroll = () => {
    const element = scroller.current;
    if (!element) return;
    const programmatic =
      programmaticTop.current !== undefined &&
      Math.abs(element.scrollTop - programmaticTop.current) <= 1;
    const reader =
      !programmatic &&
      performance.now() - readerInputAt.current < READER_INPUT_MS;
    const distance =
      element.scrollHeight - element.scrollTop - element.clientHeight;
    // Momentum keeps scrolling after the gesture's input window; any scroll
    // that is not the list's own correction moves the reader's saved place.
    if (reader || (!programmatic && !following.current)) {
      setAnchorVersion((version) => version + 1);
      captureReader();
    }
    if (distance <= FOLLOW_SLACK_PX) {
      if (!following.current || unseen) setFollowing(true);
    } else if (reader && following.current) setFollowing(false);
    if (reader && hasOlder && element.scrollTop <= OLDER_BAND_PX) loadOlder();
  };

  useEffect(() => {
    if (!actionsFor) return;
    const close = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (!target?.closest('.room-row--actions-open')) setActionsFor(undefined);
    };
    document.addEventListener('pointerdown', close, true);
    return () => document.removeEventListener('pointerdown', close, true);
  }, [actionsFor]);

  const renderRow = (row: RoomConversationRow, index: number) => {
    const placement = placements[index];
    if (!placement) return null;
    return (
      <Row
        row={row}
        placement={placement}
        unread={row.id === unreadFrom}
        actionsOpen={actionsFor === row.id}
        onLongPress={setActionsFor}
      />
    );
  };
  const trailingItem = trailing ? (
    // biome-ignore lint/a11y/useSemanticElements: rows may be virtualized; see the list below.
    <div role="listitem" className="room-item room-trailing">
      {trailing}
    </div>
  ) : null;

  return (
    <div
      className={[
        'room-conversation',
        compact && 'room-conversation--compact',
        !touch && 'room-conversation--hover',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: passive listeners only tell a reader's scroll from a programmatic one. */}
      <div
        ref={scroller}
        className="room-conversation__scroller"
        onScroll={onScroll}
        onWheel={markReaderInput}
        onTouchStart={markReaderInput}
        onTouchMove={markReaderInput}
        onPointerDown={markPress}
        onKeyDown={markPress}
      >
        <div
          ref={content}
          className={`room-conversation__content${!rows.length && !loading ? ' room-conversation__content--empty' : ''}`}
        >
          {hasOlder && onLoadOlder && (
            <Button
              variant="ghost"
              size="sm"
              className="room-conversation__older"
              pending={loadingOlder}
              pendingLabel="Loading earlier messages"
              onClick={loadOlder}
            >
              Load earlier messages
            </Button>
          )}
          {status}
          {!rows.length && !loading && empty}
          {/* biome-ignore lint/a11y/useSemanticElements: virtualized rows sit in positioned wrappers, so the list cannot be a <ul>. */}
          <div
            role="list"
            aria-label={label}
            className="room-conversation__list"
          >
            {virtualize ? (
              <TranscriptVirtualizer
                rows={listRows}
                scrollElement={scroller}
                followTail={isFollowing}
                followTick={`${followTick}:${rows.length}`}
                anchorVersion={anchorVersion}
                onProgrammaticScroll={noteProgrammatic}
                initialAnchor={following.current ? null : readerAnchor.current}
                renderRow={(virtual) => {
                  if (virtual.index < 0) return trailingItem;
                  const row = rows[virtual.index];
                  return row ? renderRow(row, virtual.index) : null;
                }}
              />
            ) : (
              <>
                {rows.map((row, index) => (
                  <Fragment key={row.id}>{renderRow(row, index)}</Fragment>
                ))}
                {trailingItem}
              </>
            )}
          </div>
        </div>
      </div>
      {!isFollowing && (
        <Button
          className="room-conversation__jump"
          variant="secondary"
          size="sm"
          onClick={jumpToLatest}
        >
          <span aria-hidden="true">↓</span>{' '}
          {unseen
            ? `${unseen} new ${unseen === 1 ? 'message' : 'messages'}`
            : 'Jump to latest'}
        </Button>
      )}
      <p className="sr-only" role="status">
        {unseen ? `${unseen} new ${unseen === 1 ? 'message' : 'messages'}` : ''}
      </p>
    </div>
  );
}
