import { useEffect, useRef } from 'react';
import { usePreview } from '../../contexts/PreviewContext';
import { useFileAttachment } from '../../hooks/useFileAttachment';
import type { FileAttachment } from '../../types';
import { AttachmentPreviewMenu } from './AttachmentPreviewMenu';

interface FileAttachmentInputProps {
  attachments: FileAttachment[];
  onFilesSelected: (files: File[]) => void | Promise<void>;
  onRemove: (id: string) => void;
  onClearAll: () => void;
  disabled?: boolean;
  supportsImages?: boolean;
  supportsFiles?: boolean;
}

export function FileAttachmentInput({
  attachments,
  onFilesSelected,
  onRemove,
  onClearAll,
  disabled,
  supportsImages,
  supportsFiles,
}: FileAttachmentInputProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const { openPreview } = usePreview();
  const {
    fileInputRef,
    attachButtonRef,
    showPreview,
    setShowPreview,
    handleFileSelect,
    openFilePicker,
  } = useFileAttachment({ onFilesSelected });

  // Escape key handling
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && showPreview) {
        setShowPreview(false);
        attachButtonRef.current?.focus();
      }
    };

    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [showPreview, setShowPreview, attachButtonRef]);

  useEffect(() => {
    if (!showPreview) return;
    const dismiss = (event: PointerEvent) => {
      if (!wrapperRef.current?.contains(event.target as Node)) {
        setShowPreview(false);
      }
    };
    window.addEventListener('pointerdown', dismiss);
    return () => window.removeEventListener('pointerdown', dismiss);
  }, [showPreview, setShowPreview]);

  const accept = [];
  // Some desktop pickers do not classify HEIF under image/*, even though the
  // shared intake can safely inspect it before any upload.
  if (supportsImages) accept.push('image/*,.heic,.heif');
  if (supportsFiles) accept.push('.pdf,.txt,.csv,.md,.json');

  const canAttach = supportsImages || supportsFiles;

  const handleClearAll = () => {
    onClearAll();
    setShowPreview(false);
    setTimeout(() => attachButtonRef.current?.focus(), 0);
  };

  const handlePreviewImage = (preview: string) => {
    const att = attachments.find((a) => a.preview === preview);
    const allPreviewable = attachments
      .filter((a) => a.preview && a.type.startsWith('image/'))
      .map((a) => ({ url: a.preview!, mediaType: a.type, name: a.name }));
    openPreview(
      { url: preview, mediaType: att?.type || 'image/png', name: att?.name },
      allPreviewable,
    );
  };

  return (
    <div className="attachment-wrapper" ref={wrapperRef}>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept={accept.join(',')}
        onChange={handleFileSelect}
        className="attachment-input"
        disabled={disabled || !canAttach}
      />

      <button
        type="button"
        ref={attachButtonRef}
        className={`attachment-btn ${attachments.length > 0 ? 'has-attachments' : ''}`}
        onClick={() => {
          if (attachments.length > 0) {
            setShowPreview((open) => !open);
          } else {
            openFilePicker();
          }
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            openFilePicker();
          } else if (e.key === 'ArrowUp' && attachments.length > 0) {
            e.preventDefault();
            setShowPreview(true);
          }
        }}
        disabled={disabled}
        tabIndex={0}
        title={
          disabled && !canAttach
            ? "Current model doesn't support attachments"
            : attachments.length > 0
              ? 'Review attachments'
              : 'Attach files'
        }
        aria-label={
          attachments.length > 0
            ? `Review ${attachments.length} attachments`
            : 'Attach files'
        }
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
          <span className="attachment-btn__badge">{attachments.length}</span>
        )}
      </button>

      {showPreview && attachments.length > 0 && (
        <AttachmentPreviewMenu
          attachments={attachments}
          onRemove={onRemove}
          onClearAll={handleClearAll}
          onAddMore={openFilePicker}
          onPreviewImage={handlePreviewImage}
        />
      )}
    </div>
  );
}
