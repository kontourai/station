import {
  type ReactNode,
  type Ref,
  type RefObject,
  useContext,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { useFixedMenuPlacement } from '../../hooks/useFixedMenuPlacement';
import { useMenuFocus } from '../../hooks/useMenuFocus';
import { useMenuTriggerToggle } from '../../hooks/useMenuTriggerToggle';
import { countWords } from '../../utils/text-display';
import type { OverflowMenuHandle } from '../ActionOverflowMenu';
import { Dialog } from '../Dialog';
import { LazyBoundary } from '../LazyBoundary';
import type { ForkTurnSource } from './fork-turn-source';
import { MessageDetailsCloseContext } from './MessageDetails';
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

/**
 * The bubble's right-click opens its ⋯ (`OverflowMenuHandle`): the same rows,
 * anchored to the same trigger. Focus goes to the trigger first so the menu
 * returns it there on close. No trigger (the phone sheet's inline rows) means
 * no menu to open. An open, not a toggle: asked again while the menu is open,
 * it leaves focus in the menu.
 */
function useMenuHandle(
  handleRef: Ref<OverflowMenuHandle> | undefined,
  triggerRef: RefObject<HTMLButtonElement | null>,
  isOpen: boolean,
  openMenu: () => void,
) {
  useImperativeHandle(handleRef, () => ({
    open: () => {
      const trigger = triggerRef.current;
      if (!trigger) return false;
      if (isOpen) return true;
      trigger.focus();
      openMenu();
      return true;
    },
  }));
}

/**
 * `.turn-footer__overflow-menu`'s `min-width`. The placement math needs the
 * menu's widest guaranteed extent before the portalled box has been laid out,
 * so the two must move together (the CSS rule records the twin).
 */
const MENU_MIN_WIDTH_PX = 180;
/**
 * Estimated row box (`[role="menuitem"]` padding 8px 10px over one text line).
 * Like the dock More menu's estimate, this only has to pick the correct side
 * of the trigger, not equal the rendered height.
 */
const MENU_ROW_PX = 36;

/**
 * Placement of this file's portalled overflow menus (`useFixedMenuPlacement`).
 *
 * These menus open from inside a message bubble. Absolutely positioned there,
 * they were clipped by the surfaces around them — the side-mode transcript
 * rules give `.message` itself `overflow-x: hidden`, so the menu was cut off
 * at the bubble's own edge.
 *
 * Opens ABOVE the trigger, where the in-bubble menu always sat; a short
 * answer in a narrow left dock pins the viewport gutter instead of
 * right-aligning.
 */
const TURN_MENU_PLACEMENT = {
  preferredSide: 'above',
  minWidthPx: MENU_MIN_WIDTH_PX,
  rowPx: MENU_ROW_PX,
} as const;

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
   * #4406: send the message that produced this answer again, in a fork that
   * keeps this answer where it is.
   */
  onRegenerate?: () => void;
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
  /** Opens the menu from the bubble it belongs to (a right-click on it). */
  handleRef?: Ref<OverflowMenuHandle>;
  /**
   * #4404 (A40): the phone's answer sheet lists these rows itself, as the
   * user bubble's sheet does, instead of a second ⋯ whose popup clipped the
   * sheet's title.
   */
  inline?: boolean;
}

/** Lazy per-turn overflow, using the same focus primitive as app header menus. */
export default function TurnActionsMenu({
  taskTarget,
  forkSource,
  onForkFromTurn,
  onRegenerate,
  provenance,
  reasoning,
  handleRef,
  inline = false,
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
  // Inside the phone's answer sheet: Regenerate leaves the chat, so it
  // closes the sheet too.
  const closeSheet = useContext(MessageDetailsCloseContext);

  const reasoningWordCount = reasoning ? countWords(reasoning.content) : 0;
  const rowCount =
    (provenance ? 1 : 0) +
    (reasoning && reasoningWordCount > 0 ? 1 : 0) +
    (taskTarget ? 1 : 0) +
    (onRegenerate ? 1 : 0) +
    (forkSource && onForkFromTurn ? 1 : 0);
  const { position, place } = useFixedMenuPlacement(triggerRef, open, {
    ...TURN_MENU_PLACEMENT,
    rowCount,
  });

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
  useMenuHandle(handleRef, triggerRef, open, () => {
    place();
    setView('menu');
  });

  // Menu items in the ⋯ popup; plain buttons in the phone sheet (`inline`),
  // where "Answer details" would repeat the sheet's own title. One list,
  // so the two presentations cannot offer different actions.
  const rows = (itemRole?: 'menuitem') => {
    const item = (key: string, label: ReactNode, onSelect: () => void) => (
      <button key={key} type="button" role={itemRole} onClick={onSelect}>
        {label}
      </button>
    );
    return [
      provenance
        ? item('provenance', itemRole ? 'Answer details' : 'Provenance', () =>
            setView('provenance'),
          )
        : null,
      reasoning && reasoningWordCount > 0
        ? item(
            'reasoning',
            `Reasoning (${reasoningWordCount.toLocaleString()} ${reasoningWordCount === 1 ? 'word' : 'words'})`,
            () => setView('reasoning'),
          )
        : null,
      taskTarget ? (
        <LazyBoundary
          key="task"
          load={loadConnectedAttachAnswerToTaskButton}
          componentProps={{
            ...taskTarget,
            menuItem: itemRole === 'menuitem',
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
      ) : null,
      onRegenerate
        ? item('regenerate', 'Regenerate', () => {
            close();
            closeSheet();
            onRegenerate();
          })
        : null,
      forkSource && onForkFromTurn
        ? item('fork', 'Fork from here…', () => {
            close();
            onForkFromTurn(forkSource);
          })
        : null,
    ];
  };

  const dialogs = (
    <>
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
  );

  if (inline)
    return (
      <>
        <fieldset className="message-details__menu" aria-label="Answer actions">
          {rows()}
        </fieldset>
        {dialogs}
      </>
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
              {rows('menuitem')}
            </div>,
            document.body,
          )}
          {dialogs}
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
   * #4406: a fork before this message, opened with it in the composer. It
   * stands in for "New chat from this message" on a message that opened the
   * conversation, where the fork would be that same empty chat.
   */
  onEditAndResend?: () => void;
  /**
   * The message was not sent: its Discard lives here, beside the bubble's
   * other actions, rather than in a second overflow on the bubble.
   */
  onDiscardUnsent?: () => void;
  /**
   * Rewind the live engine's context to before this message
   * (`SessionRewind`). Present only where the session's engine declares an
   * in-place rewind and this turn can be its point.
   */
  onRewindToHere?: () => void;
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
  /** Opens the menu from the bubble it belongs to (a right-click on it). */
  handleRef?: Ref<OverflowMenuHandle>;
}

/** Overflow for a user bubble: fork or a new-chat seed (#2216). Copy is the
 * bubble's own icon button, never a second entry here. */
export function UserMessageActionsMenu({
  forkSource,
  onForkFromTurn,
  onNewChatFromMessage,
  onEditAndResend,
  onDiscardUnsent,
  onRewindToHere,
  taskTarget,
  inline = false,
  handleRef,
}: UserMessageActionsMenuProps) {
  // 'picker': the Task dialog is open and this owner stays mounted (with the
  // menu hidden) until it settles, exactly as the answer menu does.
  const [view, setView] = useState<'closed' | 'menu' | 'picker'>('closed');
  const open = view === 'menu';
  const triggerRef = useRef<HTMLButtonElement>(null);
  const close = () =>
    setView((current) => (current === 'menu' ? 'closed' : current));
  const menuRef = useMenuFocus<HTMLDivElement>(open, close);
  const closeSheet = useContext(MessageDetailsCloseContext);
  const canFork = Boolean(forkSource && onForkFromTurn);
  const pinsToTask = Boolean(taskTarget) && !inline;
  const newChatFromMessage =
    !canFork && !onEditAndResend ? onNewChatFromMessage : undefined;
  const rowCount =
    (pinsToTask ? 1 : 0) +
    (onEditAndResend ? 1 : 0) +
    (canFork ? 1 : 0) +
    (newChatFromMessage ? 1 : 0) +
    (onRewindToHere ? 1 : 0) +
    (onDiscardUnsent ? 1 : 0);
  const { position, place } = useFixedMenuPlacement(triggerRef, open, {
    ...TURN_MENU_PLACEMENT,
    rowCount,
  });
  const triggerProps = useMenuTriggerToggle(
    open,
    () => {
      place();
      setView('menu');
    },
    close,
  );
  useMenuHandle(handleRef, triggerRef, open, () => {
    place();
    setView('menu');
  });

  // In the ⋯ popup the rows are menu items (with the menu's arrow-key
  // focus); inline in the phone's sheet they are plain buttons in a group,
  // since nothing there gives them menu keyboard behaviour.
  const rows = (close: () => void, itemRole?: 'menuitem') => {
    const item = (label: string, onSelect: () => void, className?: string) => (
      <button
        type="button"
        role={itemRole}
        className={className}
        onClick={onSelect}
      >
        {label}
      </button>
    );
    return (
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
        {onEditAndResend &&
          item('Edit and resend', () => {
            close();
            // In the phone sheet the fork's draft replaces the chat.
            closeSheet();
            onEditAndResend();
          })}
        {canFork &&
          forkSource &&
          onForkFromTurn &&
          item('Fork from here…', () => {
            close();
            onForkFromTurn(forkSource);
          })}
        {newChatFromMessage &&
          item('New chat from this message', () => {
            close();
            newChatFromMessage();
          })}
        {onRewindToHere &&
          item('Rewind conversation to here', () => {
            close();
            closeSheet();
            onRewindToHere();
          })}
        {onDiscardUnsent &&
          item(
            'Discard unsent message',
            () => {
              close();
              onDiscardUnsent();
            },
            'turn-footer__overflow-item--danger',
          )}
      </>
    );
  };
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
