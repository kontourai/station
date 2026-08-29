import { WORKSPACE_CHAT_PANE_DESCRIPTOR } from '@kontourai/station-contracts/workspace-chat-pane';
import { useState } from 'react';
import { ambientDockOccupantChoices } from '../../workspace-panes/ambientDockOccupants';
import { LazyBoundary } from '../LazyBoundary';
import {
  ResponsiveDialogHeader,
  ResponsiveDialogSurface,
} from '../ResponsiveDialogSurface';
import type { ChatDockMobileOverflowActions } from './ChatDockMobileHeader';

/**
 * station#524 (review round 2, H2): every OTHER pane the ambient dock
 * admits — this sheet only ever mounts as part of Chat's own mobile header
 * (`ChatDockMobileHeader`), so Chat is always the current occupant here and
 * never needs its own menu item (picking the current occupant is already a
 * no-op in `DockOccupantPicker`, which this mirrors). The derivation is the
 * SAME `ambientDockOccupantChoices()` the picker itself reads — not a
 * curated list — so a pane admitted/refused there is admitted/refused here
 * too, with no second edit.
 */
function otherAmbientOccupants() {
  return ambientDockOccupantChoices().filter(
    (choice) => choice.descriptor.id !== WORKSPACE_CHAT_PANE_DESCRIPTOR.id,
  );
}

const loadSessionInventoryFullFallback = () =>
  import('./SessionInventoryFullFallback').then((module) => ({
    default: module.SessionInventoryFullFallback,
  }));

/**
 * The mobile header's overflow sheet.
 *
 * Split out of `ChatDockMobileHeader` and lazy-loaded purely so it stays out of
 * the entry chunk: it only renders behind a tap, and `origin/main` was already
 * within ~200 gzip bytes of the budget in `scripts/ui-bundle-budget.mjs`. Same
 * reasoning as App.tsx's lazy overlays.
 */
export function ChatDockMobileOverflowSheet({
  overflow,
  projectScope,
  returnFocusTarget,
  onClose,
}: {
  overflow: ChatDockMobileOverflowActions;
  /** Folded out of the bar at #3309 review SF-2 — see ChatDockMobileHeader. */
  projectScope?: { name: string; onClear: () => void };
  returnFocusTarget?: HTMLElement | null;
  onClose: () => void;
}) {
  const [inventoryOpen, setInventoryOpen] = useState(false);
  const run = (action: () => void) => {
    onClose();
    action();
  };

  if (inventoryOpen && overflow.sessionInventory)
    return (
      <LazyBoundary
        load={loadSessionInventoryFullFallback}
        pending={null}
        componentProps={{
          scope: {
            kind: 'whole-session' as const,
            sessionId: overflow.sessionInventory.sessionId,
          },
          chatStoreId: overflow.sessionInventory.chatStoreId,
          trigger: returnFocusTarget ?? null,
          forceFallback: true,
          onClose: () => {
            setInventoryOpen(false);
            onClose();
          },
        }}
      />
    );

  return (
    <ResponsiveDialogSurface
      ariaLabel="Chat actions"
      onClose={onClose}
      historyMode="entry"
      overlayClassName="composer-popover-overlay composer-popover-overlay--end"
      panelClassName="composer-popover-panel chat-dock__mobile-overflow-panel"
    >
      <ResponsiveDialogHeader
        title="Actions"
        closeLabel="Close actions menu"
        onClose={onClose}
      />
      <div
        className="composer-actions-menu__list"
        role="menu"
        aria-label="Chat actions"
      >
        {/* #3309: "New chat" left this sheet for a pinned header icon — a
            primary action should not live behind an overflow tap. */}
        <button
          type="button"
          role="menuitem"
          className="composer-actions-menu__item"
          onClick={() => run(overflow.onOpenConversation)}
        >
          Open conversation
        </button>
        <button
          type="button"
          role="menuitem"
          className="composer-actions-menu__item"
          onClick={() => run(overflow.onToggleHistory)}
        >
          Conversation history
        </button>
        {overflow.sessionInventory ? (
          <button
            type="button"
            role="menuitem"
            className="composer-actions-menu__item"
            onClick={() => setInventoryOpen(true)}
          >
            Session inventory
          </button>
        ) : null}
        {overflow.onOpenProject && (
          <button
            type="button"
            role="menuitem"
            className="composer-actions-menu__item"
            onClick={() =>
              run(
                overflow.onOpenProject as NonNullable<
                  typeof overflow.onOpenProject
                >,
              )
            }
          >
            Open project
            {overflow.openProjectName && (
              /* NOT aria-hidden, unlike the Clear-project-scope hint below:
                 that item has an explicit `aria-label` this would fight, while
                 this one takes its accessible name from its text, so the
                 project reaches a screen reader and the eye through the same
                 node. This is the channel the phone bar's narrow-width label
                 drop points at (station#3309). */
              <span className="composer-actions-menu__item-hint">
                {overflow.openProjectName}
              </span>
            )}
          </button>
        )}
        {/* One named entry point per snap state the drag gesture can reach
            (collapsed / half / full), so the pointer gesture is never the only
            way to change dock height. */}
        {overflow.dockControls !== false && overflow.isDockMaximized ? (
          <button
            type="button"
            role="menuitem"
            className="composer-actions-menu__item"
            onClick={() => run(overflow.onRestoreDock)}
          >
            Restore chat
            <span
              className="composer-actions-menu__item-hint"
              aria-hidden="true"
            >
              Or drag this bar down
            </span>
          </button>
        ) : overflow.dockControls !== false ? (
          <button
            type="button"
            role="menuitem"
            className="composer-actions-menu__item"
            onClick={() => run(overflow.onExpandDock)}
          >
            Expand chat
            <span
              className="composer-actions-menu__item-hint"
              aria-hidden="true"
            >
              Or drag this bar up
            </span>
          </button>
        ) : null}
        {overflow.dockControls !== false && (
          <button
            type="button"
            role="menuitem"
            className="composer-actions-menu__item"
            onClick={() => run(overflow.onCollapseDock)}
          >
            Collapse chat
          </button>
        )}
        {/* station#524 (review round 2, H2): the header's own occupant
            picker hides in the maximized bar at <=430px — the bar's slot
            math doesn't fit an eighth control there even with the agent
            avatar already dropped. This is the fallback: same derivation
            the picker itself reads, so a pane it admits/refuses is
            admitted/refused here too. Switching occupant while ALREADY
            maximized cannot strand the main area (the dock still covers
            the whole screen either way), so this stays on the plain
            `onSwitchOccupant` action, not a mobile-maximizing one. */}
        {overflow.onSwitchOccupant &&
          otherAmbientOccupants().map((choice) => (
            <button
              key={choice.descriptor.id}
              type="button"
              role="menuitem"
              className="composer-actions-menu__item"
              onClick={() =>
                run(() =>
                  overflow.onSwitchOccupant?.(
                    choice.descriptor,
                    choice.instance,
                  ),
                )
              }
            >
              Switch to {choice.descriptor.name}
            </button>
          ))}
        {projectScope && (
          <button
            type="button"
            role="menuitem"
            className="composer-actions-menu__item"
            aria-label="Clear project chat scope"
            onClick={() => run(projectScope.onClear)}
          >
            Clear project scope
            <span
              className="composer-actions-menu__item-hint"
              aria-hidden="true"
            >
              {projectScope.name}
            </span>
          </button>
        )}
        <button
          type="button"
          role="menuitem"
          className="composer-actions-menu__item"
          onClick={() => run(overflow.onOpenChatSettings)}
        >
          Chat settings
        </button>
        <button
          type="button"
          role="menuitem"
          className="composer-actions-menu__item"
          onClick={() => run(overflow.onOpenProfile)}
        >
          Profile
        </button>
        <button
          type="button"
          role="menuitem"
          className="composer-actions-menu__item"
          onClick={() => run(overflow.onOpenAppSettings)}
        >
          Settings
        </button>
      </div>
    </ResponsiveDialogSurface>
  );
}
