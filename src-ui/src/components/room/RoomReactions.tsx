import { Tooltip } from '@kontourai/ui/react';
import {
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { glyph, SearchGlyph } from '../icons/Glyph';
import {
  ResponsiveDialogHeader,
  ResponsiveDialogSurface,
} from '../ResponsiveDialogSurface';
import { FilteredEmpty } from '../state';
import { useTouchKeyboard } from './composerKeys';
import {
  ROOM_EMOJI_GROUPS,
  readRecentRoomEmoji,
  rememberRoomEmoji,
  searchRoomEmoji,
} from './roomEmoji';
import './RoomReactions.css';

/** A smiley with a plus: "add a reaction". */
export const ReactGlyph = /* @__PURE__ */ glyph(
  'M13.5 7.2A5.5 5.5 0 1 1 8.8 2.56M5.8 9.6c.5.8 1.3 1.2 2.2 1.2s1.7-.4 2.2-1.2M6 6.5h.01M9.5 6.5h.01M12.5 1.5v4M10.5 3.5h4',
);
export const TrashGlyph = /* @__PURE__ */ glyph(
  'M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5M7 7v4M9 7v4',
);

/** One emoji on a message, as the reader sees it. */
export interface RoomReactionView {
  readonly emoji: string;
  /** People who reacted, in order; the reader is labelled "(you)". */
  readonly names: readonly string[];
  readonly mine: boolean;
}

const LONG_PRESS_MS = 450;

/** "Maya Chen (you), Priya and Jonas" */
export function roomReactorList(names: readonly string[]) {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/**
 * Reaction pills under a message: the emoji, its count, and the reader's own
 * state (pressed). A tap toggles. Who reacted is a tooltip where a pointer can
 * hover; on touch a long press asks for the list instead.
 */
export function RoomReactionBar({
  reactions,
  disabled = false,
  onToggle,
  onAdd,
  onShowWho,
}: {
  reactions: readonly RoomReactionView[];
  disabled?: boolean;
  onToggle(emoji: string, reacted: boolean): void;
  /** Opens the picker anchored to the add button. */
  onAdd?(anchor: HTMLElement): void;
  /** Touch: a long press on a pill lists who reacted, anchored to it. */
  onShowWho?(anchor: HTMLElement): void;
}) {
  const touch = useTouchKeyboard();
  const press = useRef<number | undefined>(undefined);
  const longPressed = useRef(false);
  const cancel = useCallback(() => {
    if (press.current !== undefined) window.clearTimeout(press.current);
    press.current = undefined;
  }, []);
  useEffect(() => cancel, [cancel]);
  if (!reactions.length) return null;
  return (
    // biome-ignore lint/a11y/useSemanticElements: a group of toggle buttons, not a form fieldset.
    <div className="room-reactions" role="group" aria-label="Reactions">
      {reactions.map((reaction) => {
        const who = roomReactorList(reaction.names);
        const pill = (
          <button
            key={reaction.emoji}
            type="button"
            className="room-reaction"
            aria-pressed={reaction.mine}
            aria-label={`${reaction.emoji} ${reaction.names.length}: ${who}`}
            disabled={disabled}
            onPointerDown={(event) => {
              if (event.pointerType !== 'touch' || !onShowWho) return;
              // A hold on a pill is this pill's: the row's own hold (its
              // action menu) must not start too, or both open at once.
              event.stopPropagation();
              longPressed.current = false;
              cancel();
              const anchor = event.currentTarget;
              press.current = window.setTimeout(() => {
                press.current = undefined;
                longPressed.current = true;
                onShowWho(anchor);
              }, LONG_PRESS_MS);
            }}
            onPointerUp={cancel}
            onPointerLeave={cancel}
            onPointerCancel={cancel}
            onContextMenu={(event) => {
              if (touch) event.preventDefault();
            }}
            onClick={() => {
              // The long press already answered; this release is not a tap.
              if (longPressed.current) {
                longPressed.current = false;
                return;
              }
              onToggle(reaction.emoji, !reaction.mine);
            }}
          >
            <span className="room-reaction__emoji" aria-hidden="true">
              {reaction.emoji}
            </span>
            <span className="room-reaction__count" aria-hidden="true">
              {reaction.names.length}
            </span>
          </button>
        );
        return touch ? (
          <span key={reaction.emoji} className="room-reaction__slot">
            {pill}
          </span>
        ) : (
          <Tooltip
            key={reaction.emoji}
            className="room-reaction__slot"
            label={who}
          >
            {pill}
          </Tooltip>
        );
      })}
      {onAdd && (
        <button
          type="button"
          className="room-reaction room-reaction--add"
          aria-label="Add reaction"
          title="Add reaction"
          disabled={disabled}
          onClick={(event) => onAdd(event.currentTarget)}
        >
          <ReactGlyph />
        </button>
      )}
    </div>
  );
}

/**
 * The quick picker: this reader's recent emoji, then the catalogue, with a
 * search over names and keywords. Anchored beside its trigger on a desktop,
 * a bottom sheet on a phone.
 */
export function RoomEmojiPicker({
  anchorRef,
  onClose,
  onPick,
}: {
  anchorRef: RefObject<HTMLElement | null>;
  onClose(): void;
  onPick(emoji: string): void;
}) {
  const titleId = useId();
  const searchRef = useRef<HTMLInputElement>(null);
  const touch = useTouchKeyboard();
  const [query, setQuery] = useState('');
  const recent = useMemo(() => readRecentRoomEmoji(), []);
  const found = useMemo(() => searchRoomEmoji(query), [query]);
  const pick = (emoji: string) => {
    rememberRoomEmoji(emoji);
    onPick(emoji);
  };
  const grid = (label: string, emoji: readonly string[]) => (
    <section key={label} className="room-emoji-picker__group">
      <h3 className="room-emoji-picker__label">{label}</h3>
      <div className="room-emoji-picker__grid">
        {emoji.map((value) => (
          <button
            key={value}
            type="button"
            className="room-emoji-picker__emoji"
            onClick={() => pick(value)}
          >
            {value}
          </button>
        ))}
      </div>
    </section>
  );
  return (
    <ResponsiveDialogSurface
      layer="popover"
      ariaLabelledBy={titleId}
      onClose={onClose}
      historyMode="entry"
      anchorRef={anchorRef}
      returnFocusTarget={anchorRef.current}
      // Search first on a desktop; a phone opens on the emoji, not a keyboard.
      initialFocusRef={touch ? undefined : searchRef}
      overlayClassName="room-sheet-overlay"
      panelClassName="room-sheet-panel room-emoji-picker"
    >
      <ResponsiveDialogHeader
        title="Add reaction"
        titleId={titleId}
        closeLabel="Close reactions"
        onClose={onClose}
      />
      <label className="room-emoji-picker__search">
        <SearchGlyph />
        <span className="sr-only">Search emoji</span>
        <input
          ref={searchRef}
          type="search"
          placeholder="Search emoji"
          value={query}
          enterKeyHint="done"
          onChange={(event) => setQuery(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && found[0]) {
              event.preventDefault();
              pick(found[0].emoji);
            }
          }}
        />
      </label>
      <div className="room-emoji-picker__body">
        {query.trim() ? (
          found.length ? (
            grid(
              'Results',
              found.map((entry) => entry.emoji),
            )
          ) : (
            <FilteredEmpty
              query={query}
              title={`No emoji match “${query.trim()}”`}
              description="Try another word, like “thumbs” or “party”."
              clearLabel="Clear search"
              onClear={() => {
                setQuery('');
                searchRef.current?.focus();
              }}
            />
          )
        ) : (
          <>
            {grid('Recent', recent)}
            {ROOM_EMOJI_GROUPS.map((entry) =>
              grid(
                entry.label,
                entry.emoji.map((item) => item.emoji),
              ),
            )}
          </>
        )}
      </div>
    </ResponsiveDialogSurface>
  );
}

/** Who reacted with what: the phone's answer to the desktop tooltip. */
export function RoomReactionsSheet({
  reactions,
  anchorRef,
  onClose,
}: {
  reactions: readonly RoomReactionView[];
  anchorRef: RefObject<HTMLElement | null>;
  onClose(): void;
}) {
  const titleId = useId();
  return (
    <ResponsiveDialogSurface
      layer="popover"
      ariaLabelledBy={titleId}
      onClose={onClose}
      historyMode="entry"
      anchorRef={anchorRef}
      returnFocusTarget={anchorRef.current}
      overlayClassName="room-sheet-overlay"
      panelClassName="room-sheet-panel room-reactions-sheet"
    >
      <ResponsiveDialogHeader
        title="Reactions"
        titleId={titleId}
        closeLabel="Close reactions"
        onClose={onClose}
      />
      <ul className="room-reactions-sheet__list">
        {reactions.map((reaction) => (
          <li key={reaction.emoji} className="room-reactions-sheet__item">
            <span className="room-reactions-sheet__emoji" aria-hidden="true">
              {reaction.emoji}
            </span>
            <span>
              <span className="sr-only">{reaction.emoji} </span>
              {roomReactorList(reaction.names)}
            </span>
          </li>
        ))}
      </ul>
    </ResponsiveDialogSurface>
  );
}
