import { useClipboardImagePaste } from '../../hooks/useClipboardImagePaste';
import { PasteGlyph } from '../icons/Glyph';

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
      <PasteGlyph />
    </button>
  );
}
