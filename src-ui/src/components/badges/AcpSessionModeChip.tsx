import { useRef, useState } from 'react';
import type { AdvertisedAcpMode } from '../../utils/acpSessionMode';
import { ComposerChoice } from '../ComposerChoice';
import { SettingsGlyph } from '../icons/Glyph';
import { LazyBoundary } from '../LazyBoundary';
import '../chat/chat.css';

const loadSheet = () =>
  import('./AcpSessionModeSheet').then((module) => ({
    default: module.AcpSessionModeSheet,
  }));

interface AcpSessionModeChipProps {
  modes: AdvertisedAcpMode[];
  currentModeId?: string;
  requestedModeId?: string;
  onChange: (modeId: string) => void;
}

export function AcpSessionModeChip({
  modes,
  currentModeId,
  requestedModeId,
  onChange,
}: AcpSessionModeChipProps) {
  const [isSheetOpen, setIsSheetOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  if (modes.length === 0) return null;
  const reported = modes.find((mode) => mode.id === currentModeId);
  const requested = modes.find((mode) => mode.id === requestedModeId);
  const pending = requested && requested.id !== reported?.id;
  const selectedLabel = pending
    ? `${requested.name} · next send`
    : (reported?.name ?? 'Unconfirmed');

  return (
    <>
      <ComposerChoice
        ref={triggerRef}
        className="chat-input__approval-chip chat-input__approval-chip--default"
        aria-haspopup="dialog"
        aria-expanded={isSheetOpen}
        /* The visible "Mode {name}" stays inside the accessible name
           (WCAG 2.5.3 Label in Name); the sheet carries each mode's description. */
        aria-label={`Session mode: ${selectedLabel}. Mode ${selectedLabel}`}
        onClick={() => setIsSheetOpen((open) => !open)}
        caption="Mode"
        icon={<SettingsGlyph />}
        value={selectedLabel}
        valueClassName="chat-input__approval-chip-label"
      />
      {isSheetOpen && (
        <LazyBoundary
          load={loadSheet}
          componentProps={{
            triggerRef,
            modes,
            currentModeId: requested?.id ?? reported?.id,
            pendingName: pending ? requested.name : undefined,
            onClose: () => setIsSheetOpen(false),
            onSelect: onChange,
          }}
          pending={null}
        />
      )}
    </>
  );
}
