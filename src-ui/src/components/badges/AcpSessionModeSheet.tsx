import { Badge } from '@kontourai/ui/react';
import type { RefObject } from 'react';
import { useManagedApprovalCeiling } from '../../contexts/ManagedPolicyContext';
import type { AdvertisedAcpMode } from '../../utils/acpSessionMode';
import { ManagedApprovalCeilingNote } from '../managed/ManagedApprovalCeilingNote';
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
  const { acpModeAboveCeiling } = useManagedApprovalCeiling();
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
      {modes.some((mode) => acpModeAboveCeiling(mode.id)) ? (
        <div className="composer-mode-sheet__notes">
          <ManagedApprovalCeilingNote className="composer-mode-sheet__confirm-body" />
        </div>
      ) : null}
      <div role="radiogroup" aria-label="Session mode">
        {modes.map((mode) => {
          const isSelected = mode.id === currentModeId;
          // #4518: a recognized full-access mode is above a managed ceiling
          // below Full access; the server refuses it, so it is not offered.
          const managed = acpModeAboveCeiling(mode.id) && !isSelected;
          return (
            <label
              key={mode.id}
              className={`composer-actions-menu__item composer-mode-sheet__option${
                managed ? ' composer-mode-sheet__option--managed' : ''
              }`}
            >
              <input
                type="radio"
                name="acp-session-mode-option"
                value={mode.id}
                checked={isSelected}
                aria-checked={isSelected}
                disabled={managed}
                className="composer-mode-sheet__option-input"
                onChange={() => {
                  if (managed) return;
                  if (mode.id !== currentModeId) onSelect(mode.id);
                  onClose();
                }}
              />
              <span className="composer-mode-sheet__option-body">
                <strong>
                  {mode.name}
                  {managed ? (
                    <>
                      {' '}
                      <Badge value="Managed" tone="neutral" />
                    </>
                  ) : null}
                </strong>
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
