import type { RefObject } from 'react';
import { useState } from 'react';
import { withShortcutHint } from '../../contexts/KeyboardShortcutsContext';
import {
  ResponsiveDialogHeader,
  ResponsiveDialogSurface,
} from '../ResponsiveDialogSurface';

export interface ComposerActionsMenuProps {
  /**
   * The "+" trigger is the only PERSISTENTLY-mounted control in this
   * subtree (the menu items themselves unmount when the popover closes),
   * so it — not an individual item — is what launched dialogs
   * (Delegate/Commands/Task-context/Files) restore focus to on close.
   */
  triggerRef: RefObject<HTMLButtonElement | null>;
  commandLauncherDisabled: boolean;
  commandLauncherShortcut: string;
  filesActive: boolean;
  taskContextActive: boolean;
  filesCount?: number;
  onOpenDelegation: () => void;
  onOpenCommandLauncher: () => void;
  onToggleFiles: () => void;
  onToggleTaskContext: () => void;
  projectActionsAvailable?: boolean;
  onOpenHandoff?: () => void;
  handoffDisabled?: boolean;
  handoffDisabledReason?: string;
  onOpenContextReset?: () => void;
  contextBoundaryStatus?: string;
}

/**
 * Delegate / Commands / Files / Task-context collapse into one grouped
 * secondary-actions "+" menu (docs/design/chat-composer.md §3.2), next to
 * attach + mic in the composer row. A labeled button opens a dialog-surface
 * popover (no pointer interception from surrounding layers) containing a
 * real `role="menu"` with `menuitem` entries — every item stays a real
 * button with an accessible name, reachable via `getByRole`.
 */
export function ComposerActionsMenu({
  triggerRef,
  commandLauncherDisabled,
  commandLauncherShortcut,
  filesActive,
  taskContextActive,
  filesCount,
  onOpenDelegation,
  onOpenCommandLauncher,
  onToggleFiles,
  onToggleTaskContext,
  projectActionsAvailable = true,
  onOpenHandoff,
  handoffDisabled = false,
  handoffDisabledReason,
  onOpenContextReset,
  contextBoundaryStatus,
}: ComposerActionsMenuProps) {
  const [isOpen, setIsOpen] = useState(false);

  const close = () => setIsOpen(false);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="composer-actions-menu__trigger"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-label="Composer actions"
        title="Composer actions"
        onClick={() => setIsOpen((value) => !value)}
      >
        <span aria-hidden="true">+</span>
      </button>
      {isOpen && (
        <ResponsiveDialogSurface
          ariaLabel="Composer actions"
          onClose={close}
          historyMode="entry"
          returnFocusTarget={triggerRef.current}
          anchorRef={triggerRef}
          overlayClassName="composer-popover-overlay composer-popover-overlay--start"
          panelClassName="composer-popover-panel composer-actions-menu__panel"
        >
          <ResponsiveDialogHeader
            title="Actions"
            closeLabel="Close actions menu"
            onClose={close}
          />
          <div
            className="composer-actions-menu__list"
            role="menu"
            aria-label="Composer actions"
          >
            {onOpenHandoff && (
              <button
                type="button"
                role="menuitem"
                className="composer-actions-menu__item"
                disabled={handoffDisabled}
                title={
                  handoffDisabled
                    ? handoffDisabledReason
                    : 'Continue this conversation with another Agent'
                }
                onClick={() => {
                  close();
                  onOpenHandoff();
                }}
              >
                Continue with…
                <span
                  className="composer-actions-menu__item-hint"
                  aria-hidden="true"
                >
                  Another Agent
                </span>
              </button>
            )}
            {onOpenContextReset && (
              <button
                type="button"
                role="menuitem"
                className="composer-actions-menu__item"
                disabled={handoffDisabled}
                title={
                  handoffDisabled
                    ? handoffDisabledReason
                    : 'Replace the next engine context'
                }
                onClick={() => {
                  close();
                  onOpenContextReset();
                }}
              >
                Replace engine context
                {contextBoundaryStatus && (
                  <span
                    className="composer-actions-menu__item-hint"
                    aria-live="polite"
                  >
                    {contextBoundaryStatus}
                  </span>
                )}
              </button>
            )}
            {projectActionsAvailable && (
              <>
                <button
                  type="button"
                  role="menuitem"
                  className="composer-actions-menu__item"
                  title="Delegate a resumable task"
                  onClick={() => {
                    close();
                    onOpenDelegation();
                  }}
                >
                  Delegate
                  <span
                    className="composer-actions-menu__item-hint"
                    aria-hidden="true"
                  >
                    Start a resumable task
                  </span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="composer-actions-menu__item"
                  disabled={commandLauncherDisabled}
                  aria-label="Open command launcher"
                  title={
                    commandLauncherDisabled
                      ? 'Command launcher unavailable while the agent is working'
                      : commandLauncherShortcut
                        ? withShortcutHint(
                            'Open command launcher',
                            'active-command-launcher',
                            () => commandLauncherShortcut,
                          )
                        : 'Open command launcher'
                  }
                  onClick={() => {
                    close();
                    onOpenCommandLauncher();
                  }}
                >
                  <span aria-hidden="true">Commands</span>
                  {commandLauncherShortcut && (
                    <kbd className="composer-actions-menu__item-hint">
                      {commandLauncherShortcut}
                    </kbd>
                  )}
                </button>
                <button
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={filesActive}
                  className="composer-actions-menu__item"
                  onClick={() => {
                    close();
                    onToggleFiles();
                  }}
                >
                  {`Files${typeof filesCount === 'number' && filesCount > 0 ? ` (${filesCount})` : ''}`}
                </button>
                <button
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={taskContextActive}
                  className="composer-actions-menu__item"
                  onClick={() => {
                    close();
                    onToggleTaskContext();
                  }}
                >
                  Task context
                </button>
              </>
            )}
          </div>
        </ResponsiveDialogSurface>
      )}
    </>
  );
}
