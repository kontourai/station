import { ChatDockMobileConnection } from './ChatDockMobileConnection';
import './ChatDockMobileOverflowSheet.css';
import {
  ResponsiveDialogHeader,
  ResponsiveDialogSurface,
} from '../ResponsiveDialogSurface';
import type { ChatDockMobileOverflowActions } from './ChatDockMobileHeader';

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
  showConnection,
  onNewChat,
  branchLabel,
  returnFocusTarget,
  onClose,
}: {
  overflow: ChatDockMobileOverflowActions;
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
  const run = (action: () => void) => {
    onClose();
    action();
  };

  return (
    <ResponsiveDialogSurface
      layer="popover"
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
        {branchLabel && <p>{branchLabel}</p>}
        {showConnection && <ChatDockMobileConnection showLabel />}
        <button
          type="button"
          role="menuitem"
          className="composer-actions-menu__item"
          onClick={() => run(overflow.onToggleHistory)}
        >
          Chats
        </button>
        {overflow.onOpenConversationHistory && (
          <button
            type="button"
            role="menuitem"
            className="composer-actions-menu__item"
            onClick={() => run(overflow.onOpenConversationHistory!)}
          >
            Conversation history
          </button>
        )}
        {overflow.onOpenBackgroundTasks && (
          <button
            type="button"
            role="menuitem"
            className="composer-actions-menu__item"
            aria-haspopup="dialog"
            onClick={() => run(overflow.onOpenBackgroundTasks!)}
          >
            {(overflow.backgroundTasksRunningCount ?? 0) > 0
              ? `Background tasks — ${overflow.backgroundTasksRunningCount} running`
              : 'Background tasks'}
          </button>
        )}
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
        {overflow.inputOriginLabel && (
          <div className="composer-actions-menu__item" role="note">
            {overflow.inputOriginLabel}
          </div>
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
        {/* #2046 2b: the region's other panes. No tab strip on a coarse
            device, so this row is how a pane sharing Chat's region is
            switched to from Chat; the toolbar's `⋯` region rows are the
            way back. */}
        {overflow.onSelectRegionPane
          ? (overflow.regionPanes ?? [])
              .filter((pane) => !pane.selected)
              .map((pane) => (
                <button
                  key={pane.id}
                  type="button"
                  role="menuitem"
                  className="composer-actions-menu__item"
                  onClick={() => {
                    const select = overflow.onSelectRegionPane;
                    run(() => select?.(pane.id));
                  }}
                >
                  Switch to {pane.title}
                </button>
              ))
          : null}
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
      </div>
    </ResponsiveDialogSurface>
  );
}
