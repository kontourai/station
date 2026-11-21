import { useFileAttachment } from '../../hooks/useFileAttachment';
import type { FileAttachment } from '../../types';

interface FileAttachmentInputProps {
  attachments: FileAttachment[];
  onFilesSelected: (files: File[]) => void | Promise<void>;
  disabled?: boolean;
  supportsImages?: boolean;
  supportsFiles?: boolean;
  /**
   * Why nothing can be attached here (e.g. the engine's own "no images"
   * answer). With it, the paperclip stays tappable and says so — a disabled
   * button's `title` never reaches a touch user.
   */
  unavailableReason?: string;
  onUnavailable?: (reason: string) => void;
}

/**
 * The paperclip. It always opens the file picker and adds to what is already
 * attached: the composer's chip strip shows, previews and removes each file.
 */
export function FileAttachmentInput({
  attachments,
  onFilesSelected,
  disabled,
  supportsImages,
  supportsFiles,
  unavailableReason,
  onUnavailable,
}: FileAttachmentInputProps) {
  const { fileInputRef, attachButtonRef, handleFileSelect, openFilePicker } =
    useFileAttachment({ onFilesSelected });

  const accept = [];
  // Some desktop pickers do not classify HEIF under image/*, even though the
  // shared intake can safely inspect it before any upload.
  if (supportsImages) accept.push('image/*,.heic,.heif');
  if (supportsFiles) accept.push('.pdf,.txt,.csv,.md,.json');

  const canAttach = supportsImages || supportsFiles;
  const explainUnavailable =
    !canAttach && !!unavailableReason && !!onUnavailable;

  return (
    <div className="attachment-wrapper">
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept={accept.join(',')}
        onChange={handleFileSelect}
        className="attachment-input"
        disabled={disabled || !canAttach}
        // #4403: the Attach button below is the control; this input is only
        // what it clicks. Exposed, it was a second, 1x1 "Choose File" button
        // in every composer. Same treatment as the Home composer's input.
        tabIndex={-1}
        aria-hidden="true"
      />

      <button
        type="button"
        ref={attachButtonRef}
        className={`attachment-btn ${attachments.length > 0 ? 'has-attachments' : ''}`}
        onClick={() => {
          if (explainUnavailable) onUnavailable?.(unavailableReason!);
          else openFilePicker();
        }}
        disabled={disabled && !explainUnavailable}
        aria-disabled={explainUnavailable || undefined}
        title={
          explainUnavailable
            ? unavailableReason
            : disabled && !canAttach
              ? "Current model doesn't support attachments"
              : 'Attach files'
        }
        aria-label="Attach files"
      >
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
          <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
        </svg>
        {attachments.length > 0 && (
          <span className="attachment-btn__badge" aria-hidden="true">
            {attachments.length}
          </span>
        )}
      </button>
    </div>
  );
}
