import { useRef, useState } from 'react';
import type { AdvertisedAcpMode } from '../../utils/acpSessionMode';
import { ArrowDownGlyph } from '../icons/Glyph';
import { LazyBoundary } from '../LazyBoundary';
import '../chat/chat.css';

const loadSheet = () =>
  import('./AcpSessionModeSheet').then((module) => ({
    default: module.AcpSessionModeSheet,
  }));

interface AcpSessionModeChipProps {
  modes: AdvertisedAcpMode[];
  currentModeId?: string;
  onChange: (modeId: string) => void;
}

export function AcpSessionModeChip({
  modes,
  currentModeId,
  onChange,
}: AcpSessionModeChipProps) {
  const [isSheetOpen, setIsSheetOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  if (modes.length === 0) return null;
  const selected = modes.find((mode) => mode.id === currentModeId) ?? modes[0];
  if (!selected) return null;
  const selectedLabel = selected.name;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="choice-trigger chat-input__approval-chip chat-input__approval-chip--default"
        aria-haspopup="dialog"
        aria-expanded={isSheetOpen}
        aria-label={`Session mode: ${selectedLabel}. Engine advertised control.`}
        title={`Session mode for this engine: ${selectedLabel}${
          selected.description ? ` — ${selected.description}` : ''
        }`}
        onClick={() => setIsSheetOpen((open) => !open)}
      >
        <span className="chat-input__approval-chip-label" aria-hidden="true">
          {selectedLabel}
        </span>
        <ArrowDownGlyph className="choice-caret" />
      </button>
      {isSheetOpen && (
        <LazyBoundary
          load={loadSheet}
          componentProps={{
            triggerRef,
            modes,
            currentModeId: selected.id,
            onClose: () => setIsSheetOpen(false),
            onSelect: onChange,
          }}
          pending={null}
        />
      )}
    </>
  );
}
