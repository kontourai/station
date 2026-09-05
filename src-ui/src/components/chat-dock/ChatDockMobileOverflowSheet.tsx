import { WORKSPACE_CHAT_PANE_DESCRIPTOR } from '@kontourai/station-contracts/workspace-chat-pane';
import { useRef, useState } from 'react';
import { ChatDockMobileConnection } from './ChatDockMobileConnection';
import { ProjectSwitcherOverlay } from './ChatDockProjectContext';
import './ChatDockMobileOverflowSheet.css';
import { useNavigation } from '../../contexts/NavigationContext';
import { useIsMobile } from '../../hooks/useIsMobile';
import {
  ambientDockOccupantChoices,
  chooseAmbientOccupant,
} from '../../workspace-panes/ambientDockOccupants';
import { LazyBoundary } from '../LazyBoundary';
import {
  ResponsiveDialogHeader,
  ResponsiveDialogSurface,
} from '../ResponsiveDialogSurface';
import type {
  ChatDockMobileOverflowActions,
  ChatDockMobileProjectSwitcher,
} from './ChatDockMobileHeader';

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
  projectSwitcher,
  showConnection,
  onNewChat,
  onOpenActivity,
  activeCount,
  branchLabel,
  returnFocusTarget,
  onClose,
}: {
  overflow: ChatDockMobileOverflowActions;
  projectSwitcher?: ChatDockMobileProjectSwitcher | null;
  showConnection?: boolean;
  onNewChat?: () => void;
  onOpenActivity?: () => void;
  activeCount?: number;
  branchLabel?: string | null;
  /** Folded out of the bar at #3309 review SF-2 — see ChatDockMobileHeader. */
  projectScope?: { name: string; onClear: () => void };
  returnFocusTarget?: HTMLElement | null;
  onClose: () => void;
}) {
  const [inventoryOpen, setInventoryOpen] = useState(false);
  const [projectOpen, setProjectOpen] = useState(false);
  const projectTriggerRef = useRef<HTMLButtonElement>(null);
  const run = (action: () => void) => {
    onClose();
    action();
  };
  // station#520 (review round 3, B1): the occupant-switch items below need
  // the SAME inputs `DockOccupantPicker` reads for `chooseAmbientOccupant`
  // — this sheet is a real component too, so it reads them itself rather
  // than having `ChatDock.tsx` compute and thread them down.
  const isMobile = useIsMobile();
  const { pathname } = useNavigation();

  if (projectOpen && projectSwitcher)
    return (
      <ProjectSwitcherOverlay
        anchorRef={projectTriggerRef}
        boundProjectSlug={projectSwitcher.projectSlug}
        projects={projectSwitcher.projects}
        onOpenProject={projectSwitcher.onOpenProject}
        onSwitchProject={projectSwitcher.onSwitchProject}
        onClose={() => setProjectOpen(false)}
      />
    );

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
      returnFocusTarget={returnFocusTarget}
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
        {onNewChat && (
          <button
            type="button"
            role="menuitem"
            className="composer-actions-menu__item"
            onClick={() => run(onNewChat)}
          >
            New chat
          </button>
        )}
        {onOpenActivity && (
          <button
            type="button"
            role="menuitem"
            className="composer-actions-menu__item"
            onClick={() => run(onOpenActivity)}
          >
            Activity
            {activeCount ? (
              <span className="composer-actions-menu__item-hint">
                {activeCount} working
              </span>
            ) : null}
          </button>
        )}
        {projectSwitcher && (
          <button
            ref={projectTriggerRef}
            type="button"
            role="menuitem"
            className="composer-actions-menu__item"
            onClick={() => setProjectOpen(true)}
          >
            Switch project
            <span className="composer-actions-menu__item-hint">
              {projectSwitcher.projectName}
            </span>
          </button>
        )}
        {branchLabel && <p>{branchLabel}</p>}
        {showConnection && <ChatDockMobileConnection showLabel />}
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
        {/* station#524 (review round 2, H2) + station#520 (review round 3,
            B1): reachable at EVERY dock state (collapsed/half/maximized),
            not only when the header's own picker hides — the mobile
            dock-and-empty contract applies here exactly as it does to
            `DockOccupantPicker`, through the SAME shared derivation
            (`chooseAmbientOccupant`), not a second copy of it. Same
            occupant list the picker reads too — a pane it admits/refuses
            is admitted/refused here. */}
        {overflow.onSwitchOccupant &&
          otherAmbientOccupants().map((choice) => (
            <button
              key={choice.descriptor.id}
              type="button"
              role="menuitem"
              className="composer-actions-menu__item"
              onClick={() =>
                run(() => {
                  if (!overflow.onSwitchOccupant) return;
                  chooseAmbientOccupant({
                    isMobile,
                    pathname,
                    descriptor: choice.descriptor,
                    instance: choice.instance,
                    onChoose: overflow.onSwitchOccupant.onChoose,
                    onChooseAsOnlyContent:
                      overflow.onSwitchOccupant.onChooseAsOnlyContent,
                  });
                })
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
