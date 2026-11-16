import type { ReactNode, RefObject } from 'react';
import { useState } from 'react';
import { withShortcutHint } from '../../contexts/KeyboardShortcutsContext';
import { useCoarsePointer } from '../../hooks/useCoarsePointer';
import {
  ResponsiveDialogHeader,
  ResponsiveDialogSurface,
} from '../ResponsiveDialogSurface';

export interface ComposerActionsMenuProps {
  /**
   * The "+" trigger is the only PERSISTENTLY-mounted control in this
   * subtree (the menu items themselves unmount when the popover closes),
   * so it — not an individual item — is what launched dialogs
   * (Delegate/Commands/Continue with) restore focus to on close.
   */
  triggerRef: RefObject<HTMLButtonElement | null>;
  commandLauncherDisabled: boolean;
  commandLauncherShortcut: string;
  onOpenDelegation: () => void;
  onOpenCommandLauncher: () => void;
  projectActionsAvailable?: boolean;
  /**
   * Opens this Project's Terminal in the bottom dock region, or reveals the
   * one already there. Absent where the chat has no Project.
   */
  onOpenTerminal?: () => void;
  /** Why the Terminal row cannot open; shown under its label. */
  terminalDisabledReason?: string;
  /**
   * Switches to the chat's coding layout, which shows this same chat
   * beside the workbench. Absent when the Project has no coding layout or
   * the dock is already scoped to a Project layout.
   */
  onOpenCodingLayout?: () => void;
  /** "Open in Coding", or the contributed layout's own name. */
  codingLayoutLabel?: string;
  onOpenHandoff?: () => void;
  handoffDisabled?: boolean;
  handoffDisabledReason?: string;
  onOpenContextReset?: () => void;
  contextBoundaryStatus?: string;
  onOpenConversationReference?: () => void;
}

/**
 * The composer's "+" (docs/design/chat-composer.md §3, item 2): the actions
 * that start from the composer, in three labelled groups — what goes into
 * the message, where the work goes next in this Project, and what happens to
 * the conversation itself. Panel toggles (Files, Task context) are not here:
 * they show something beside the chat, so they live in the dock's More menu.
 *
 * A labeled button opens a dialog-surface popover (no pointer interception
 * from surrounding layers) containing a real `role="menu"` with `menuitem`
 * entries — every item stays a real button with an accessible name,
 * reachable via `getByRole`. A disabled row states its reason as visible
 * text, since a phone has no tooltip to carry it.
 */
export function ComposerActionsMenu({
  triggerRef,
  commandLauncherDisabled,
  onOpenDelegation,
  onOpenCommandLauncher,
  projectActionsAvailable = true,
  onOpenTerminal,
  terminalDisabledReason,
  onOpenCodingLayout,
  codingLayoutLabel = 'Open in Coding',
  onOpenHandoff,
  handoffDisabled = false,
  handoffDisabledReason,
  onOpenContextReset,
  contextBoundaryStatus,
  onOpenConversationReference,
  commandLauncherShortcut: registeredShortcut,
}: ComposerActionsMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  // A finger has no chord to press: on a coarse primary pointer the menu
  // shows no keyboard hint, in its label or as a kbd. Accepted limit: a
  // tablet whose primary pointer is touch also loses the hint when a
  // hardware keyboard is attached; Station has no keyboard-presence signal.
  const coarsePointer = useCoarsePointer();
  const commandLauncherShortcut = coarsePointer ? '' : registeredShortcut;

  const close = () => setIsOpen(false);
  const run = (action: () => void) => () => {
    close();
    action();
  };

  const messageRows: ReactNode[] = [];
  if (onOpenConversationReference)
    messageRows.push(
      <button
        key="reference"
        type="button"
        role="menuitem"
        className="composer-actions-menu__item"
        onClick={run(onOpenConversationReference)}
      >
        Reference chat…
      </button>,
    );
  if (projectActionsAvailable)
    messageRows.push(
      <button
        key="commands"
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
        onClick={run(onOpenCommandLauncher)}
      >
        <span aria-hidden="true">Commands</span>
        {commandLauncherShortcut && (
          <kbd className="composer-actions-menu__item-hint">
            {commandLauncherShortcut}
          </kbd>
        )}
      </button>,
    );

  const workRows: ReactNode[] = [];
  if (projectActionsAvailable && onOpenTerminal)
    workRows.push(
      <button
        key="terminal"
        type="button"
        role="menuitem"
        className="composer-actions-menu__item"
        disabled={Boolean(terminalDisabledReason)}
        onClick={run(onOpenTerminal)}
      >
        Open terminal
        <span className="composer-actions-menu__item-hint">
          {terminalDisabledReason ?? 'Bottom dock'}
        </span>
      </button>,
    );
  if (projectActionsAvailable && onOpenCodingLayout)
    workRows.push(
      <button
        key="coding"
        type="button"
        role="menuitem"
        className="composer-actions-menu__item"
        onClick={run(onOpenCodingLayout)}
      >
        {codingLayoutLabel}
        <span className="composer-actions-menu__item-hint" aria-hidden="true">
          Moves this chat
        </span>
      </button>,
    );
  if (projectActionsAvailable)
    workRows.push(
      <button
        key="delegate"
        type="button"
        role="menuitem"
        className="composer-actions-menu__item"
        title="Delegate a resumable task"
        onClick={run(onOpenDelegation)}
      >
        Delegate…
        <span className="composer-actions-menu__item-hint" aria-hidden="true">
          Resumable task
        </span>
      </button>,
    );

  const conversationRows: ReactNode[] = [];
  if (onOpenHandoff)
    conversationRows.push(
      <button
        key="handoff"
        type="button"
        role="menuitem"
        className="composer-actions-menu__item"
        disabled={handoffDisabled}
        onClick={run(onOpenHandoff)}
      >
        Continue with another agent…
        {handoffDisabled && handoffDisabledReason && (
          <span className="composer-actions-menu__item-hint">
            {handoffDisabledReason}
          </span>
        )}
      </button>,
    );
  if (onOpenContextReset)
    conversationRows.push(
      <button
        key="reset"
        type="button"
        role="menuitem"
        className="composer-actions-menu__item"
        data-tone="danger"
        disabled={handoffDisabled}
        onClick={run(onOpenContextReset)}
      >
        Reset agent context…
        {(contextBoundaryStatus ||
          (handoffDisabled && handoffDisabledReason)) && (
          <span className="composer-actions-menu__item-hint" aria-live="polite">
            {contextBoundaryStatus ??
              (handoffDisabled ? handoffDisabledReason : undefined)}
          </span>
        )}
      </button>,
    );

  const groups = [
    { key: 'message', label: 'Add to message', rows: messageRows },
    { key: 'work', label: 'Work in this project', rows: workRows },
    { key: 'conversation', label: 'This conversation', rows: conversationRows },
  ].filter((group) => group.rows.length > 0);

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
          layer="popover"
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
            {groups.map((group, index) => (
              <fieldset
                key={group.key}
                aria-label={group.label}
                className="composer-actions-menu__group"
              >
                {index > 0 && (
                  <hr className="composer-actions-menu__separator" />
                )}
                {group.rows}
              </fieldset>
            ))}
          </div>
        </ResponsiveDialogSurface>
      )}
    </>
  );
}
