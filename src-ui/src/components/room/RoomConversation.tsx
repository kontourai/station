import {
  Fragment,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useIsMobile } from '../../hooks/useIsMobile';
import {
  ActionOverflowMenu,
  type OverflowAction,
  type OverflowMenuHandle,
} from '../ActionOverflowMenu';
import { Button } from '../Button';
import {
  type ChatScrollAnchor,
  captureChatScrollAnchor,
  restoreChatScrollAnchor,
} from '../chat/chatScrollAnchor';
import { TranscriptVirtualizer } from '../chat/TranscriptVirtualizer';
import { IconButton } from '../IconButton';
import { glyph, MoreGlyph } from '../icons/Glyph';
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
  /** Reaction pills under the body (`RoomReactionBar`). */
  readonly reactions?: ReactNode;
  /** ISO time of the latest edit: the body ends with an "edited" marker. */
  readonly editedAt?: string;
  /**
   * A deleted message: a "Message deleted" line replaces the body, and its
   * author and time stay so replies to it still read.
   */
  readonly deleted?: boolean;
  /** The row the composer is editing: marked so the reader sees which. */
  readonly highlighted?: boolean;
  /** Under the body: a thread summary or a delivery state. */
  readonly footer?: ReactNode;
  /** The row's action bar: shown on hover, focus or long press. */
  readonly actions?: ReactNode;
  /**
   * The same actions as labelled menu rows. Where there is no hover (touch
   * and phone layouts) the ⋯ control and a long press open these as a menu
   * instead of the icon bar, whose icons would have no visible names there.
   */
  readonly menu?: readonly OverflowAction[];
  readonly tone?: 'failed' | 'pending';
  /** Written by the reader: the list follows it instead of counting it as new. */
  readonly own?: boolean;
}

/** A struck-through circle: content that was removed. */
const DeletedGlyph = /* @__PURE__ */ glyph(
  'M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11ZM4.2 4.2l7.6 7.6',
);

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
  showMore,
  onLongPress,
  onCloseActions,
}: {
  row: RoomConversationRow;
  placement: RoomRowPlacement;
  unread: boolean;
  actionsOpen: boolean;
  /** Touch and phone layouts: a visible button opens the actions. */
  showMore: boolean;
  /** Opens (or toggles) this row's actions. */
  onLongPress(id: string): void;
  onCloseActions(): void;
}) {
  const actionsId = useId();
  const moreButton = useRef<HTMLButtonElement>(null);
  const menuHandle = useRef<OverflowMenuHandle>(null);
  const menuOnTouch = showMore && !!row.menu?.length;
  const rowElement = useRef<HTMLDivElement>(null);
  const actionsElement = useRef<HTMLDivElement>(null);
  // Opening by the button or a long press moves focus into the actions; with
  // none enabled (a send in flight), focus rests on the button instead.
  useEffect(() => {
    if (!actionsOpen || !showMore) return;
    (
      actionsElement.current?.querySelector<HTMLElement>(
        'button:not(:disabled), [href]',
      ) ?? moreButton.current
    )?.focus({ preventScroll: true });
    // Bring the whole bar into view, not just its first button: on the last
    // message a wrapped bar would otherwise sit under the fold, and the
    // partial scroll read as the reader leaving the end of the list.
    actionsElement.current?.scrollIntoView?.({ block: 'nearest' });
  }, [actionsOpen, showMore]);
  // Escape closes from the button or the actions and returns to the button.
  const closeOnEscape = (event: React.KeyboardEvent) => {
    if (event.key !== 'Escape' || !actionsOpen) return;
    event.preventDefault();
    event.stopPropagation();
    onCloseActions();
    moreButton.current?.focus();
  };
  // A tap outside closes them; focus that was inside returns to the button.
  useEffect(() => {
    if (!actionsOpen) return;
    const close = (event: PointerEvent) => {
      if (rowElement.current?.contains(event.target as Node)) return;
      const hadFocus = actionsElement.current?.contains(document.activeElement);
      onCloseActions();
      if (!hadFocus) return;
      // The tap's own focus change lands after this; restore on its click
      // unless it pressed another control, which keeps its focus.
      const button = moreButton.current;
      const restore = () => {
        window.clearTimeout(expire);
        const active = document.activeElement;
        if (!active?.closest('button, a[href], input, select, textarea'))
          button?.focus();
      };
      const expire = window.setTimeout(
        () => document.removeEventListener('click', restore, true),
        1000,
      );
      document.addEventListener('click', restore, {
        capture: true,
        once: true,
      });
    };
    document.addEventListener('pointerdown', close, true);
    return () => document.removeEventListener('pointerdown', close, true);
  }, [actionsOpen, onCloseActions]);
  const press = useRef<number | undefined>(undefined);
  const origin = useRef<{ x: number; y: number } | undefined>(undefined);
  const cancelPress = useCallback(() => {
    if (press.current !== undefined) window.clearTimeout(press.current);
    press.current = undefined;
  }, []);
  useEffect(() => cancelPress, [cancelPress]);
  const touchHandlers =
    row.actions || menuOnTouch
      ? {
          onPointerDown: (event: React.PointerEvent) => {
            if (event.pointerType !== 'touch') return;
            origin.current = { x: event.clientX, y: event.clientY };
            cancelPress();
            press.current = window.setTimeout(() => {
              press.current = undefined;
              if (menuOnTouch) menuHandle.current?.open();
              else onLongPress(row.id);
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
  // The time tells one author's messages apart.
  const moreLabel = `More actions for ${row.author?.label ?? 'this'}'s message${row.at && Number.isFinite(Date.parse(row.at)) ? ` at ${roomShortTime(row.at)}` : ''}`;
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
          row.highlighted && 'room-row--highlighted',
        ]
          .filter(Boolean)
          .join(' ')}
        data-room-author={row.author?.agent ? 'agent' : 'person'}
        ref={rowElement}
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
          {row.deleted ? (
            <p className="room-row__body room-row__deleted">
              <DeletedGlyph />
              Message deleted
            </p>
          ) : (
            <div
              className={`room-row__body${row.editedAt ? ' room-row__body--edited' : ''}`}
            >
              {row.body ??
                (row.text !== undefined ? (
                  <RoomMessageText text={row.text} />
                ) : null)}
              {row.editedAt && (
                <span
                  className="room-row__edited"
                  title={
                    Number.isFinite(Date.parse(row.editedAt))
                      ? `Edited ${roomFullTime(row.editedAt)}`
                      : undefined
                  }
                >
                  edited
                </span>
              )}
            </div>
          )}
          {!row.deleted && row.attachments}
          {!row.deleted && row.reactions}
          {row.footer && <div className="room-row__footer">{row.footer}</div>}
        </div>
        {menuOnTouch && (
          <ActionOverflowMenu
            actions={row.menu!}
            handleRef={menuHandle}
            triggerClassName="action-overflow__trigger room-row__more"
            label={moreLabel}
          />
        )}
        {row.actions && showMore && !menuOnTouch && (
          <IconButton
            ref={moreButton}
            className="room-row__more"
            // The time tells one author's messages apart.
            aria-label={moreLabel}
            aria-expanded={actionsOpen}
            aria-controls={actionsId}
            onClick={() =>
              actionsOpen ? onCloseActions() : onLongPress(row.id)
            }
            onKeyDown={closeOnEscape}
          >
            <MoreGlyph />
          </IconButton>
        )}
        {row.actions && !menuOnTouch && (
          <div
            ref={actionsElement}
            id={actionsId}
            className="room-row__actions"
            role="toolbar"
            aria-label={`Actions for ${row.author?.label ?? 'message'}`}
            onKeyDown={closeOnEscape}
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
  regionLabel,
  rows,
  loading = false,
  status,
  empty,
  hasOlder = false,
  olderNote,
  loadingOlder = false,
  onLoadOlder,
  trailing,
  className,
}: {
  /** Accessible name of the message list. */
  label: string;
  /** Accessible name of the scroll region, e.g. "Messages in #general". */
  regionLabel?: string;
  /** Oldest first. */
  rows: readonly RoomConversationRow[];
  loading?: boolean;
  /** A failure or notice shown above the rows (with its own recovery). */
  status?: ReactNode;
  /** Shown when there are no rows and nothing is loading. */
  empty?: ReactNode;
  hasOlder?: boolean;
  /**
   * Why the list starts where it does when earlier history exists but is not
   * all here (a kept-history limit, or rows unloaded), shown at the top.
   */
  olderNote?: string;
  loadingOlder?: boolean;
  onLoadOlder?(): void;
  /** Live rows after the history, such as a working agent. */
  trailing?: ReactNode;
  className?: string;
}) {
  const scroller = useRef<HTMLElement>(null);
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

  const closeActions = useCallback(() => setActionsFor(undefined), []);

  const renderRow = (row: RoomConversationRow, index: number) => {
    const placement = placements[index];
    if (!placement) return null;
    return (
      <Row
        row={row}
        placement={placement}
        unread={row.id === unreadFrom}
        actionsOpen={actionsFor === row.id}
        showMore={compact || touch}
        onLongPress={setActionsFor}
        onCloseActions={closeActions}
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
        (compact || touch) && 'room-conversation--more',
        !touch && 'room-conversation--hover',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {/* A named region (a labelled section) so its tab stop says what it
          scrolls; keyboard readers scroll the history with arrows and Page keys. */}
      <section
        ref={scroller}
        aria-label={regionLabel ?? `Messages in ${label}`}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a scroll region must be focusable to be keyboard-scrollable (WCAG 2.1.1).
        tabIndex={0}
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
          {olderNote && (
            <p className="room-conversation__older-note" role="note">
              {olderNote}
            </p>
          )}
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
      </section>
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
