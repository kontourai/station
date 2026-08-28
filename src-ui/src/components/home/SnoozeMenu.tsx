import type { RefObject } from 'react';
import { snoozePresetTargets } from '../../views/home/snooze-presets';
import {
  ResponsiveDialogHeader,
  ResponsiveDialogSurface,
} from '../ResponsiveDialogSurface';

export interface SnoozeMenuProps {
  itemTitle: string;
  now: number;
  triggerRef: RefObject<HTMLButtonElement | null>;
  onSnooze: (wakeAt: number) => void;
  onClose: () => void;
}

/**
 * Agent-rhythm snooze presets (design (b), archive#1099): In 1 hour / This
 * evening / Tomorrow 9am / Next week Mon 9am.
 *
 * Reuses `ResponsiveDialogHeader` and `composer-actions-menu__list`/
 * `__item` — the same primitives ComposerActionsMenu and ComposerModeSheet
 * already share (see the note above `.composer-mode-sheet__option` in
 * index.css) — so this menu adds zero new CSS. Loaded via `React.lazy` from
 * HomeView: the presets menu opens rarely enough that its weight does not
 * belong in the entry bundle.
 */
export default function SnoozeMenu({
  itemTitle,
  now,
  triggerRef,
  onSnooze,
  onClose,
}: SnoozeMenuProps) {
  const presets = snoozePresetTargets(now);
  return (
    <ResponsiveDialogSurface
      ariaLabel={`Snooze ${itemTitle}`}
      onClose={onClose}
      historyMode="entry"
      returnFocusTarget={triggerRef.current}
      anchorRef={triggerRef}
      overlayClassName="composer-popover-overlay composer-popover-overlay--start"
      panelClassName="composer-popover-panel"
    >
      <ResponsiveDialogHeader
        title="Snooze"
        closeLabel="Close snooze menu"
        onClose={onClose}
      />
      <div
        className="composer-actions-menu__list"
        role="menu"
        aria-label={`Snooze ${itemTitle}`}
      >
        {presets.map((preset) => (
          <button
            key={preset.id}
            type="button"
            role="menuitem"
            className="composer-actions-menu__item"
            onClick={() => {
              onSnooze(preset.wakeAt);
              onClose();
            }}
          >
            {preset.label}
          </button>
        ))}
      </div>
    </ResponsiveDialogSurface>
  );
}
