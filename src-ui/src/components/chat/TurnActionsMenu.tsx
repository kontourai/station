import {
  type CSSProperties,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { useMenuFocus } from '../../hooks/useMenuFocus';
import { useMenuTriggerToggle } from '../../hooks/useMenuTriggerToggle';
import { Dialog } from '../Dialog';
import { LazyBoundary } from '../LazyBoundary';
import type { ForkTurnSource } from './fork-turn-source';
import { MoreActionsGlyph } from './MoreActionsGlyph';
import type { TurnProvenanceStatedInRow } from './TurnProvenanceCard';
import { TurnProvenanceCard } from './TurnProvenanceCard';
import './TurnActionsMenu.css';

const loadConnectedAttachUserInputToTaskButton = () =>
  import('./AttachAnswerToTaskButton').then((module) => ({
    default: module.ConnectedAttachUserInputToTaskButton,
  }));
const loadConnectedAttachAnswerToTaskButton = () =>
  import('./AttachAnswerToTaskButton').then((module) => ({
    default: module.ConnectedAttachAnswerToTaskButton,
  }));

const MENU_GAP_PX = 4;
/**
 * `.turn-footer__overflow-menu`'s `min-width`. The placement math needs the
 * menu's widest guaranteed extent before the portalled box has been laid out,
 * so the two must move together (the CSS rule records the twin).
 */
const MENU_MIN_WIDTH_PX = 180;
const VIEWPORT_GUTTER_PX = 8;
/**
 * Estimated row box (`[role="menuitem"]` padding 8px 10px over one text line)
 * plus the container's own 4px padding. Like the dock More menu's estimate,
 * this only has to pick the correct side of the trigger, not equal the
 * rendered height.
 */
const MENU_ROW_PX = 36;
const MENU_PADDING_PX = 8;

/**
 * Fixed placement for the portalled overflow menus of this file.
 *
 * These menus open from inside a message bubble. Absolutely positioned there,
 * they were clipped by the surfaces around them — the side-mode transcript
 * rules give `.message` itself `overflow-x: hidden`, so the menu was cut off
 * at the bubble's own edge. Portalling to the document is the same escape the
 * TaskPicker dialog and the dock's More menu take (leaving the DOM subtree is
 * what beats an ancestor's clipping and stacking context), and a fixed box
 * anchored to the trigger's own rect replaces the in-bubble anchoring.
 *
 * Opens ABOVE the trigger, where the in-bubble menu always sat; flips below
 * when the viewport top cannot hold the estimated rows, and pins the viewport
 * gutter when the trigger sits too near the left edge to right-align a
 * min-width menu (a short answer in a narrow left dock).
 */
function useFixedMenuPlacement(
  triggerRef: RefObject<HTMLButtonElement | null>,
  open: boolean,
  rowCount: number,
) {
  const [position, setPosition] = useState<CSSProperties>({});
  const place = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const roomNeeded = rowCount * MENU_ROW_PX + MENU_PADDING_PX + MENU_GAP_PX;
    const next: CSSProperties =
      rect.top >= roomNeeded
        ? { bottom: window.innerHeight - rect.top + MENU_GAP_PX }
        : { top: rect.bottom + MENU_GAP_PX };
    if (rect.right >= MENU_MIN_WIDTH_PX + VIEWPORT_GUTTER_PX) {
      next.right = window.innerWidth - rect.right;
    } else {
      next.left = VIEWPORT_GUTTER_PX;
    }
    setPosition(next);
  }, [triggerRef, rowCount]);
  // A fixed menu does not ride the transcript's scroll the way the old
  // absolutely-positioned one did: follow the trigger while open.
  useEffect(() => {
    if (!open) return;
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, place]);
  return { position, place };
}

export interface TurnActionsMenuProps {
  taskTarget?: {
    sessionId: string;
    turnId: string;
    projectId?: string;
    excerpt?: string;
  };
  forkSource?: ForkTurnSource | null;
  onForkFromTurn?: (source: ForkTurnSource) => void;
  /**
   * #2211: the per-turn record surfaces. The transcript stays focused on the
   * answer; provenance and reasoning open as dialogs from this menu instead
   * of occupying disclosure rows inside the bubble.
   */
  provenance?: {
    /** The envelope exactly as the row received it; the card decides readability. */
    envelope: unknown;
    /** What the row's own chips already state, so the card can stand down. */
    statedInRow: TurnProvenanceStatedInRow;
    accountableHuman?: string | null;
    /** Share affordance, composed by the row and mounted only in the dialog. */
    shareContent?: React.ReactNode;
  };
  reasoning?: { content: string };
}

/**
 * Word count for the reasoning menu item, mirroring ReasoningSection's
 * Intl.Segmenter count with the same regex fallback.
 */
function countReasoningWords(content: string): number {
  const trimmed = content.trim();
  if (!trimmed) return 0;
  const Segmenter = (
    Intl as typeof Intl & {
      Segmenter?: new (
        locale?: string,
        options?: { granularity?: string },
      ) => { segment(input: string): Iterable<{ isWordLike?: boolean }> };
    }
  ).Segmenter;
  if (Segmenter) {
    let count = 0;
    for (const segment of new Segmenter(undefined, {
      granularity: 'word',
    }).segment(trimmed)) {
      if (segment.isWordLike) count += 1;
    }
    return count;
  }
  return trimmed.match(/\S+/gu)?.length ?? 0;
}

/** Lazy per-turn overflow, using the same focus primitive as app header menus. */
export default function TurnActionsMenu({
  taskTarget,
  forkSource,
  onForkFromTurn,
  provenance,
  reasoning,
}: TurnActionsMenuProps) {
  const [view, setView] = useState<
    'closed' | 'menu' | 'picker' | 'provenance' | 'reasoning'
  >('closed');
  const open = view === 'menu';
  const triggerRef = useRef<HTMLButtonElement>(null);
  const close = () =>
    setView((current) => (current === 'menu' ? 'closed' : current));
  const closeDialog = () => setView('closed');
  const menuRef = useMenuFocus<HTMLDivElement>(open, close);

  const reasoningWordCount = reasoning
    ? countReasoningWords(reasoning.content)
    : 0;
  const rowCount =
    (provenance ? 1 : 0) +
    (reasoning && reasoningWordCount > 0 ? 1 : 0) +
    (taskTarget ? 1 : 0) +
    (forkSource && onForkFromTurn ? 1 : 0);
  const { position, place } = useFixedMenuPlacement(triggerRef, open, rowCount);

  /**
   * #2081. The trigger is NOT inside the menu container — portalled or not,
   * pressing it moves focus out of the container and `useMenuFocus` dismisses
   * the menu before the press becomes a click — after which `setView(open ? …)`
   * read the flushed `closed` and re-opened it. The menu could not be shut
   * from the control that opened it. The hook decides from the state at press
   * time. The open branch records the placement first: the trigger is the
   * anchor, and its rect is cheapest to read at the click that opens.
   */
  const triggerProps = useMenuTriggerToggle(
    open,
    () => {
      place();
      setView('menu');
    },
    close,
  );

  return (
    <span className="turn-footer__actions-menu">
      <button
        ref={triggerRef}
        type="button"
        className="message__copy-btn turn-footer__overflow-trigger"
        aria-label="More answer actions"
        aria-haspopup="menu"
        aria-expanded={open}
        {...triggerProps}
      >
        <MoreActionsGlyph />
      </button>
      {/* The menu portals to the document — see `useFixedMenuPlacement` for
          why an in-bubble anchor cannot hold it. The picker and the #2211
          dialogs portal their own surfaces, and they keep this owner mounted
          after the menu closes on focus transfer, until the surface itself
          settles. */}
      {view !== 'closed' && (
        <>
          {createPortal(
            <div
              hidden={!open}
              ref={menuRef}
              className="turn-footer__overflow-menu"
              style={position}
              role="menu"
              aria-label="Answer actions"
              tabIndex={-1}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  close();
                }
              }}
            >
              {provenance && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => setView('provenance')}
                >
                  Turn provenance
                </button>
              )}
              {reasoning && reasoningWordCount > 0 && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => setView('reasoning')}
                >
                  Reasoning ({reasoningWordCount.toLocaleString()}{' '}
                  {reasoningWordCount === 1 ? 'word' : 'words'})
                </button>
              )}
              {taskTarget && (
                <LazyBoundary
                  load={loadConnectedAttachAnswerToTaskButton}
                  componentProps={{
                    ...taskTarget,
                    menuItem: true,
                    onOpen: () => setView('picker'),
                    onClose: () => setView('closed'),
                    returnFocusTarget: triggerRef.current,
                  }}
                  pending={null}
                  unavailable={() => (
                    <span className="turn-footer__unavailable-note">
                      Add to Task is unavailable.
                    </span>
                  )}
                />
              )}
              {forkSource && onForkFromTurn && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    close();
                    onForkFromTurn(forkSource);
                  }}
                >
                  Fork from here…
                </button>
              )}
            </div>,
            document.body,
          )}
          {view === 'provenance' && provenance && (
            <Dialog
              eyebrow="This turn"
              title="Provenance"
              subtitle="What Station observed about how this answer was produced."
              closeLabel="Close provenance"
              onClose={closeDialog}
              size="md"
              returnFocusTarget={triggerRef.current ?? undefined}
            >
              <TurnProvenanceCard
                provenance={provenance.envelope}
                statedInRow={provenance.statedInRow}
                accountableHuman={provenance.accountableHuman}
                shareContent={provenance.shareContent}
                defaultOpen
              />
            </Dialog>
          )}
          {view === 'reasoning' && reasoning && (
            <Dialog
              eyebrow="This turn"
              title="Reasoning"
              subtitle={`${reasoningWordCount.toLocaleString()} ${reasoningWordCount === 1 ? 'word' : 'words'} recorded for this turn.`}
              closeLabel="Close reasoning"
              onClose={closeDialog}
              size="md"
              returnFocusTarget={triggerRef.current ?? undefined}
            >
              <div
                className="turn-reasoning-dialog__body"
                style={{
                  color: 'var(--text-secondary)',
                  fontStyle: 'italic',
                  lineHeight: 1.5,
                  whiteSpace: 'pre-wrap',
                }}
              >
                {reasoning.content}
              </div>
            </Dialog>
          )}
        </>
      )}
    </span>
  );
}

export interface UserMessageActionsMenuProps {
  forkSource?: ForkTurnSource | null;
  onForkFromTurn?: (source: ForkTurnSource) => void;
  onNewChatFromMessage?: () => void;
  /**
   * The message was not sent: its Discard lives here, beside the bubble's
   * other actions, rather than in a second overflow on the bubble.
   */
  onDiscardUnsent?: () => void;
  /**
   * A durable authored input that can be pinned to a Task. Listed here, like
   * an answer's "Add to Task", instead of as a standing button on every
   * user bubble. Not used inline: the phone sheet lists its own Task row.
   */
  taskTarget?: {
    sessionId: string;
    eventId: string;
    projectId?: string;
    excerpt?: string;
  };
  /**
   * Already inside a surface of its own (the phone's message sheet): the rows
   * render in place, with no second ⋯ to open.
   */
  inline?: boolean;
}

/** Overflow for a user bubble: fork or a new-chat seed (#2216). Copy is the
 * bubble's own icon button, never a second entry here. */
export function UserMessageActionsMenu({
  forkSource,
  onForkFromTurn,
  onNewChatFromMessage,
  onDiscardUnsent,
  taskTarget,
  inline = false,
}: UserMessageActionsMenuProps) {
  // 'picker': the Task dialog is open and this owner stays mounted (with the
  // menu hidden) until it settles, exactly as the answer menu does.
  const [view, setView] = useState<'closed' | 'menu' | 'picker'>('closed');
  const open = view === 'menu';
  const triggerRef = useRef<HTMLButtonElement>(null);
  const close = () =>
    setView((current) => (current === 'menu' ? 'closed' : current));
  const menuRef = useMenuFocus<HTMLDivElement>(open, close);
  const canFork = Boolean(forkSource && onForkFromTurn);
  const pinsToTask = Boolean(taskTarget) && !inline;
  const rowCount =
    (pinsToTask ? 1 : 0) +
    (canFork ? 1 : onNewChatFromMessage ? 1 : 0) +
    (onDiscardUnsent ? 1 : 0);
  const { position, place } = useFixedMenuPlacement(triggerRef, open, rowCount);
  const triggerProps = useMenuTriggerToggle(
    open,
    () => {
      place();
      setView('menu');
    },
    close,
  );

  // In the ⋯ popup the rows are menu items (with the menu's arrow-key
  // focus); inline in the phone's sheet they are plain buttons in a group,
  // since nothing there gives them menu keyboard behaviour.
  const rows = (close: () => void, itemRole?: 'menuitem') => (
    <>
      {pinsToTask && taskTarget && (
        <LazyBoundary
          load={loadConnectedAttachUserInputToTaskButton}
          componentProps={{
            ...taskTarget,
            menuItem: true,
            onOpen: () => setView('picker'),
            onClose: () => setView('closed'),
            returnFocusTarget: triggerRef.current,
          }}
          pending={null}
          unavailable={() => (
            <span className="turn-footer__unavailable-note">
              Add to Task is unavailable.
            </span>
          )}
        />
      )}
      {canFork && forkSource && onForkFromTurn && (
        <button
          type="button"
          role={itemRole}
          onClick={() => {
            close();
            onForkFromTurn(forkSource);
          }}
        >
          Fork from here…
        </button>
      )}
      {!canFork && onNewChatFromMessage && (
        <button
          type="button"
          role={itemRole}
          onClick={() => {
            close();
            onNewChatFromMessage();
          }}
        >
          New chat from this message
        </button>
      )}
      {onDiscardUnsent && (
        <button
          type="button"
          role={itemRole}
          className="turn-footer__overflow-item--danger"
          onClick={() => {
            close();
            onDiscardUnsent();
          }}
        >
          Discard unsent message
        </button>
      )}
    </>
  );
  if (inline)
    return (
      <fieldset className="message-details__menu" aria-label="Message actions">
        {rows(() => {})}
      </fieldset>
    );
  return (
    <span className="turn-footer__actions-menu">
      <button
        ref={triggerRef}
        type="button"
        className="message__copy-btn turn-footer__overflow-trigger"
        aria-label="More message actions"
        aria-haspopup="menu"
        aria-expanded={open}
        {...triggerProps}
      >
        <MoreActionsGlyph />
      </button>
      {/* Portalled for the same reason as the answer menu above. */}
      {view !== 'closed' &&
        createPortal(
          <div
            hidden={!open}
            ref={menuRef}
            className="turn-footer__overflow-menu"
            style={position}
            role="menu"
            aria-label="Message actions"
            tabIndex={-1}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                close();
              }
            }}
          >
            {rows(close, 'menuitem')}
          </div>,
          document.body,
        )}
    </span>
  );
}
