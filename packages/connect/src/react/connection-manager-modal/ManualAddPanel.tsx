import { useEffect, useRef } from 'react';
import { HttpsPreferenceHint } from '../HttpsPreferenceHint';

interface ManualAddPanelProps {
  name: string;
  url: string;
  onNameChange: (value: string) => void;
  onUrlChange: (value: string) => void;
  onAdd: () => void;
  onCancel: () => void;
  /** True while the host's compatibility is being checked before it is saved. */
  checking?: boolean;
}

export function ManualAddPanel({
  name,
  url,
  onNameChange,
  onUrlChange,
  onAdd,
  onCancel,
  checking = false,
}: ManualAddPanelProps) {
  const nameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameInputRef.current?.focus();
  }, []);

  return (
    <div className="station-connect-form">
      <input
        ref={nameInputRef}
        type="text"
        value={name}
        onChange={(event) => onNameChange(event.target.value)}
        placeholder="Name (optional)"
        aria-label="Name (optional)"
        className="station-connect-input"
      />
      <input
        type="text"
        value={url}
        onChange={(event) => onUrlChange(event.target.value)}
        placeholder="https://station.example.ts.net"
        aria-label="Station address"
        className="station-connect-input"
        onKeyDown={(event) => {
          if (event.key === 'Enter') onAdd();
          if (event.key === 'Escape') onCancel();
        }}
      />
      <HttpsPreferenceHint address={url} />
      <div className="station-connect-btn-row">
        <button
          type="button"
          onClick={onAdd}
          disabled={!url.trim() || checking}
          className="station-connect-btn station-connect-btn--primary"
        >
          {checking ? 'Checking…' : 'Add'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="station-connect-btn station-connect-btn--secondary"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
