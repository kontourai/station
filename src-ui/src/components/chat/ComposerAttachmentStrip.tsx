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
  /**
   * The bound engine/model has said it cannot take images. An image chip
   * then says so itself instead of claiming it is ready to send.
   */
  imagesRefused?: boolean;
}

function isImage(
  attachment: FileAttachment,
  stage: ComposerAttachmentStageSnapshot | undefined,
): boolean {
  return (stage?.mimeType ?? attachment.type ?? '').startsWith('image/');
}

/**
 * One short status per chip. Each label names what happened and what the
 * chip's own control does about it — a bare "Retry required before sending"
 * that appeared ten minutes after upload, with no action from the user, read
 * as a malfunction when it was the server stage's TTL running out.
 */
function chipStatus(
  stage: ComposerAttachmentStageSnapshot | undefined,
  refused: boolean,
): { label: string; tone: 'ok' | 'pending' | 'blocked' } | null {
  if (refused) return { label: 'Not accepted here', tone: 'blocked' };
  if (!stage) return null;
  if (stage.delivery === 'legacy-inline')
    return { label: 'Ready (inline delivery)', tone: 'ok' };
  switch (stage.state) {
    case 'queued':
      return { label: 'Waiting to upload', tone: 'pending' };
    case 'uploading':
      return {
        label: `Uploading ${Math.round(stage.progress * 100)}%`,
        tone: 'pending',
      };
    case 'complete':
      return { label: 'Ready', tone: 'ok' };
    case 'accepted':
      return { label: 'Sent; waiting for reply', tone: 'pending' };
    case 'retryable':
      return stage.needsFile
        ? { label: 'Choose the file again', tone: 'blocked' }
        : stage.expired
          ? { label: 'Upload expired', tone: 'blocked' }
          : { label: "Upload didn't finish", tone: 'blocked' };
    case 'cancelled':
      return { label: 'Upload stopped', tone: 'blocked' };
    case 'failed':
      if (stage.capacityFull)
        return { label: 'Upload limit reached', tone: 'blocked' };
      return stage.needsFile
        ? { label: 'Choose the file again', tone: 'blocked' }
        : { label: 'Upload failed', tone: 'blocked' };
  }
}

/**
 * What the composer will send, when that is not what the user handed it
 * (archive#3375). Both numbers are chip text, not a tooltip: a title attribute
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
 * The attached files, visible in the composer itself (archive#3344).
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
  imagesRefused = false,
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
      {visibleAttachments.map((attachment) => {
        const stage = stages.find(
          (entry) => entry.clientAttachmentId === attachment.id,
        );
        const refused = imagesRefused && isImage(attachment, stage);
        const status = chipStatus(stage, refused);
        return (
          <li
            key={attachment.id}
            className={`composer-attachments__chip${
              status?.tone === 'blocked'
                ? ' composer-attachments__chip--blocked'
                : ''
            }`}
          >
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
            <span className="composer-attachments__text">
              <span
                className="composer-attachments__name"
                title={attachment.name}
              >
                {attachment.name}
              </span>
              {status ? (
                <span
                  className="composer-attachments__stage"
                  role="status"
                  title={stage?.error}
                >
                  {status.label}
                  {stage?.state === 'uploading' && (
                    <progress
                      value={stage.progress}
                      max="1"
                      aria-label={`${attachment.name} upload progress`}
                    />
                  )}
                </span>
              ) : null}
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
            </span>
            {refused ? null : stage?.needsFile ? (
              <label className="composer-attachments__action composer-attachments__choose">
                Choose again
                <input
                  type="file"
                  onChange={(event) => {
                    const files = Array.from(event.currentTarget.files ?? []);
                    if (files.length > 0)
                      void onReplaceFile?.(attachment.id, files);
                    event.currentTarget.value = '';
                  }}
                  aria-label={`Choose ${attachment.name} again`}
                />
              </label>
            ) : stage?.state === 'retryable' ? (
              <button
                type="button"
                className="composer-attachments__action"
                onClick={() => void onRetry?.(attachment.id)}
                aria-label={`${stage.expired ? 'Upload again' : 'Retry'} ${attachment.name}`}
              >
                {stage.expired ? 'Upload again' : 'Retry'}
              </button>
            ) : stage?.state === 'queued' || stage?.state === 'uploading' ? (
              // Stops the transfer but keeps the chip; × below removes it.
              <button
                type="button"
                className="composer-attachments__action"
                onClick={() => void onCancel?.(attachment.id)}
                aria-label={`Stop uploading ${attachment.name}`}
              >
                Stop
              </button>
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
        );
      })}
    </ul>
  );
}
