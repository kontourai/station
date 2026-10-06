export function ComposerStopButton({
  onCancel,
  stopPending = false,
}: {
  onCancel: () => void;
  stopPending?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onCancel}
      tabIndex={0}
      disabled={stopPending}
      aria-busy={stopPending || undefined}
      className="send-button chat-input__stop-btn"
      aria-label={
        stopPending
          ? 'Stop requested — waiting for the engine'
          : 'Stop the current turn'
      }
      title={
        stopPending
          ? 'Stop requested — waiting for the engine'
          : 'Stop the current turn'
      }
    >
      <svg
        viewBox="0 0 24 24"
        width="16"
        height="16"
        aria-hidden="true"
        focusable="false"
      >
        <rect x="7" y="7" width="10" height="10" rx="2" />
      </svg>
    </button>
  );
}
