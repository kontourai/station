import { useRef, useState } from 'react';
import { useMenuFocus } from '../../hooks/useMenuFocus';
import { useMenuTriggerToggle } from '../../hooks/useMenuTriggerToggle';
import { LazyBoundary } from '../LazyBoundary';
import type { ForkTurnSource } from './fork-turn-source';
import './TurnActionsMenu.css';

const loadConnectedAttachAnswerToTaskButton = () =>
  import('./AttachAnswerToTaskButton').then((module) => ({
    default: module.ConnectedAttachAnswerToTaskButton,
  }));

export interface TurnActionsMenuProps {
  taskTarget?: { sessionId: string; turnId: string; projectId?: string };
  forkSource?: ForkTurnSource | null;
  onForkFromTurn?: (source: ForkTurnSource) => void;
}

/** Lazy per-turn overflow, using the same focus primitive as app header menus. */
export default function TurnActionsMenu({
  taskTarget,
  forkSource,
  onForkFromTurn,
}: TurnActionsMenuProps) {
  const [view, setView] = useState<'closed' | 'menu' | 'picker'>('closed');
  const open = view === 'menu';
  const triggerRef = useRef<HTMLButtonElement>(null);
  const close = () =>
    setView((current) => (current === 'menu' ? 'closed' : current));
  const menuRef = useMenuFocus<HTMLDivElement>(open, close);
  /**
   * #2081. The trigger is a SIBLING of the menu container, not a child, so
   * pressing it moves focus out of the container and `useMenuFocus` dismisses
   * the menu before the press becomes a click — after which `setView(open ?
   * …)` read the flushed `closed` and re-opened it. The menu could not be shut
   * from the control that opened it. The hook decides from the state at press
   * time; nothing about this depends on the menu being portalled, which the
   * issue took for the condition and which this menu is not.
   */
  const triggerProps = useMenuTriggerToggle(open, () => setView('menu'), close);

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
        …
      </button>
      {/* The picker portals its dialog. Keep its owner mounted after the menu
          closes on focus transfer, until the dialog itself settles. */}
      {view !== 'closed' && (
        <div
          hidden={!open}
          ref={menuRef}
          className="turn-footer__overflow-menu"
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
        </div>
      )}
    </span>
  );
}
