import { useClipboardImagePaste } from '../../hooks/useClipboardImagePaste';

/**
 * The icon form of Paste image, beside an icon Attach control (`className`
 * is that control's class, so both share chrome and the 44px mobile target).
 * Renders nothing where clipboard images cannot be read.
 */
export function ClipboardImagePasteButton({
  className,
  disabled,
  onFiles,
  onMessage,
}: {
  className: string;
  disabled?: boolean;
  onFiles: (files: File[]) => void | Promise<void>;
  onMessage: (message: string) => void;
}) {
  const { available, pending, paste } = useClipboardImagePaste({
    onFiles,
    onMessage,
  });
  if (!available) return null;
  return (
    <button
      type="button"
      className={className}
      aria-label="Paste image"
      title="Paste image"
      disabled={disabled || pending}
      aria-busy={pending || undefined}
      onClick={() => void paste()}
    >
      {/* The paperclip's icon family, size and stroke, so the pair matches. */}
      <svg
        aria-hidden="true"
        focusable="false"
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
        <rect x="8" y="2" width="8" height="4" rx="1" ry="1" />
      </svg>
    </button>
  );
}
