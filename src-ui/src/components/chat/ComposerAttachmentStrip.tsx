import type {
  ComposerAttachmentStageSnapshot,
  FileAttachment,
} from '../../types';
import { formatBytes } from '../../utils/formatBytes';
import { DocumentGlyph } from '../icons/Glyph';

interface ComposerAttachmentStripProps {
  attachments: FileAttachment[];
  stages?: ComposerAttachmentStageSnapshot[];
  onRemove: (id: string) => void;
  onRetry?: (id: string) => void | Promise<void>;
  onCancel?: (id: string) => void | Promise<void>;
  onReplaceFile?: (id: string, files: File[]) => void | Promise<void>;
}

/**
 * What the composer will send, when that is not what the user handed it
 * (station#3375). Both numbers are chip text, not a tooltip: a title attribute
 * reaches neither a touch user nor a screen reader, so a bare "Resized" there
 * would leave the size change unreadable to exactly the readers most likely to
 * be pasting a phone screenshot. The title adds only the pixel dimensions,
 * which are detail rather than the claim.
 */
function resizedLabel(
  resized: NonNullable<FileAttachment['resized']>,
  sentBytes: number,
): string {
  return `Resized ${formatBytes(resized.fromBytes)} → ${formatBytes(sentBytes)}`;
}

/**
 * The attached files, visible in the composer itself (station#3344).
 *
 * Before this, a pasted screenshot's only trace was a count badge on the
 * paperclip button, and the thumbnail lived behind a popover the user had to
 * think to open — a paste that worked looked, at a glance, exactly like a
 * paste that did nothing. The popover (`AttachmentPreviewMenu`) still owns
 * bulk actions and full-size preview; this strip only has to answer "did my
 * image attach, and how do I take it back off".
 */
export function ComposerAttachmentStrip({
  attachments,
  stages = [],
  onRemove,
  onRetry,
  onCancel,
  onReplaceFile,
}: ComposerAttachmentStripProps) {
  const visibleAttachments = [
    ...attachments,
    ...stages
      .filter(
        (stage) =>
          !attachments.some(
            (attachment) => attachment.id === stage.clientAttachmentId,
          ),
      )
      .map(
        (stage): FileAttachment => ({
          id: stage.clientAttachmentId,
          name: stage.name,
          type: stage.mimeType,
          size: stage.size,
          // Presentation-only descriptor reconstructed after reload. It is
          // never sent; dispatch uses a reconciled reference or blocks.
          data: '',
          ...(stage.transformation
            ? { transformation: stage.transformation }
            : {}),
        }),
      ),
  ];
  if (visibleAttachments.length === 0) return null;
  return (
    <ul className="composer-attachments" aria-label="Attached files">
      {visibleAttachments.map((attachment) => (
        <li key={attachment.id} className="composer-attachments__chip">
          {(() => {
            const stage = stages.find(
              (entry) => entry.clientAttachmentId === attachment.id,
            );
            if (!stage) return null;
            const label =
              stage.delivery === 'legacy-inline'
                ? 'Ready using compatible inline delivery'
                : stage.state === 'uploading'
                  ? `Uploading ${Math.round(stage.progress * 100)}%`
                  : stage.state === 'complete'
                    ? 'Ready to send'
                    : stage.state === 'accepted'
                      ? 'Accepted; waiting for reply'
                      : stage.needsFile
                        ? 'Choose file again to retry'
                        : stage.state;
            return (
              <span className="composer-attachments__stage" role="status">
                {label}
                {stage.state === 'uploading' && (
                  <progress
                    value={stage.progress}
                    max="1"
                    aria-label={`${attachment.name} upload progress`}
                  />
                )}
                {stage.needsFile ? (
                  <label className="composer-attachments__choose">
                    Choose file again
                    <input
                      type="file"
                      onChange={(event) => {
                        const files = Array.from(
                          event.currentTarget.files ?? [],
                        );
                        if (files.length > 0)
                          void onReplaceFile?.(attachment.id, files);
                        event.currentTarget.value = '';
                      }}
                      aria-label={`Choose ${attachment.name} again`}
                    />
                  </label>
                ) : stage.state === 'retryable' ? (
                  <button
                    type="button"
                    onClick={() => void onRetry?.(attachment.id)}
                    aria-label={`Retry ${attachment.name}`}
                  >
                    Retry
                  </button>
                ) : null}
                {stage.state === 'queued' ||
                stage.state === 'uploading' ||
                stage.state === 'retryable' ? (
                  <button
                    type="button"
                    onClick={() => void onCancel?.(attachment.id)}
                    aria-label={`Cancel ${attachment.name}`}
                  >
                    Cancel
                  </button>
                ) : null}
              </span>
            );
          })()}
          {attachment.preview ? (
            <img
              src={attachment.preview}
              alt={attachment.name}
              className="composer-attachments__thumb"
            />
          ) : (
            <span className="composer-attachments__glyph" aria-hidden="true">
              <DocumentGlyph />
            </span>
          )}
          <span className="composer-attachments__name" title={attachment.name}>
            {attachment.name}
          </span>
          {attachment.resized ? (
            <span
              className="composer-attachments__resized"
              title={`Resized to fit the 5 MB attachment limit — sent at ${attachment.resized.width}×${attachment.resized.height}`}
            >
              {resizedLabel(attachment.resized, attachment.size)}
            </span>
          ) : null}
          {attachment.transformation ? (
            <span className="composer-attachments__resized">
              Converted HEIF to JPEG locally
            </span>
          ) : null}
          <button
            type="button"
            className="composer-attachments__remove"
            onClick={() => onRemove(attachment.id)}
            aria-label={`Remove ${attachment.name}`}
            title={`Remove ${attachment.name}`}
          >
            ×
          </button>
        </li>
      ))}
    </ul>
  );
}
