import type { RefObject } from 'react';
import type { AdvertisedAcpMode } from '../../utils/acpSessionMode';
import {
  ResponsiveDialogHeader,
  ResponsiveDialogSurface,
} from '../ResponsiveDialogSurface';

interface AcpSessionModeSheetProps {
  triggerRef: RefObject<HTMLButtonElement | null>;
  modes: AdvertisedAcpMode[];
  currentModeId: string;
  onClose: () => void;
  onSelect: (modeId: string) => void;
}

export function AcpSessionModeSheet({
  triggerRef,
  modes,
  currentModeId,
  onClose,
  onSelect,
}: AcpSessionModeSheetProps) {
  return (
    <ResponsiveDialogSurface
      layer="popover"
      ariaLabel="Session mode"
      onClose={onClose}
      historyMode="entry"
      returnFocusTarget={triggerRef.current}
      anchorRef={triggerRef}
      overlayClassName="composer-popover-overlay composer-popover-overlay--start"
      panelClassName="composer-popover-panel composer-mode-sheet"
    >
      <ResponsiveDialogHeader
        title="Session mode"
        closeLabel="Close session mode picker"
        onClose={onClose}
      />
      <div role="radiogroup" aria-label="Session mode">
        {modes.map((mode) => {
          const isSelected = mode.id === currentModeId;
          return (
            <label
              key={mode.id}
              className="composer-actions-menu__item composer-mode-sheet__option"
            >
              <input
                type="radio"
                name="acp-session-mode-option"
                value={mode.id}
                checked={isSelected}
                aria-checked={isSelected}
                className="composer-mode-sheet__option-input"
                onChange={() => {
                  if (mode.id !== currentModeId) onSelect(mode.id);
                  onClose();
                }}
              />
              <span className="composer-mode-sheet__option-body">
                <strong>{mode.name}</strong>
                {mode.description ? <small>{mode.description}</small> : null}
              </span>
              <span
                className="composer-mode-sheet__option-mark"
                aria-hidden="true"
              />
            </label>
          );
        })}
      </div>
    </ResponsiveDialogSurface>
  );
}
