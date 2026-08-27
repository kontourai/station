import type { FileAttachment } from '../../types';
import { formatBytes } from '../../utils/formatBytes';
import { DocumentGlyph } from '../icons/Glyph';

interface AttachmentPreviewMenuProps {
  attachments: FileAttachment[];
  onRemove: (id: string) => void;
  onClearAll: () => void;
  onAddMore: () => void;
  onPreviewImage: (preview: string) => void;
}

export function AttachmentPreviewMenu({
  attachments,
  onRemove,
  onClearAll,
  onAddMore,
  onPreviewImage,
}: AttachmentPreviewMenuProps) {
  return (
    <div role="dialog" className="attachment-menu">
      <div className="attachment-menu__header">
        <div className="attachment-menu__count">
          {attachments.length} Attachment{attachments.length !== 1 ? 's' : ''}
        </div>
        <div className="attachment-menu__actions">
          <button
            type="button"
            className="attachment-menu__add-btn"
            onClick={(e) => {
              e.stopPropagation();
              onAddMore();
            }}
          >
            Add more
          </button>
          <button
            type="button"
            className="attachment-menu__clear-btn"
            onClick={(e) => {
              e.stopPropagation();
              onClearAll();
            }}
          >
            Clear all
          </button>
        </div>
      </div>
      <div className="attachment-menu__list">
        {attachments.map((att) => (
          <div key={att.id} className="attachment-menu__item" data-attachment>
            {att.preview ? (
              <img
                src={att.preview}
                alt={att.name}
                className="attachment-menu__thumbnail"
                onClick={() => onPreviewImage(att.preview!)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onPreviewImage(att.preview!);
                  }
                }}
                title="Click to preview"
              />
            ) : (
              <div className="attachment-menu__file-icon">
                <DocumentGlyph />
              </div>
            )}
            <div className="attachment-menu__info">
              <div className="attachment-menu__name">{att.name}</div>
              <div className="attachment-menu__size">
                {/* The strip says an image was resized; a size here with no
                    mention of it reads as the size of the file the user
                    picked, which it is not. */}
                {att.resized
                  ? `${formatBytes(att.size)} · resized from ${formatBytes(att.resized.fromBytes)}`
                  : formatBytes(att.size)}
              </div>
            </div>
            <button
              type="button"
              className="attachment-menu__remove-btn"
              onClick={(e) => {
                e.stopPropagation();
                onRemove(att.id);
              }}
              title="Remove"
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
