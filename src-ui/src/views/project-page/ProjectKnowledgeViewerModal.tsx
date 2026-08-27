import { LazyMarkdown } from '../../components/chat/LazyMarkdown';
import { DocumentGlyph } from '../../components/icons/Glyph';
import { ResponsiveDialogCloseButton } from '../../components/ResponsiveDialogSurface';
import { SkeletonBlock } from '../../components/state';
import { useMobileVisualViewport } from '../../hooks/useMobileVisualViewport';
import type { DocMeta } from './types';

interface ProjectKnowledgeViewerModalProps {
  doc: DocMeta;
  content: string | undefined;
  loading: boolean;
  onClose: () => void;
}

export function ProjectKnowledgeViewerModal({
  doc,
  content,
  loading,
  onClose,
}: ProjectKnowledgeViewerModalProps) {
  const visualViewport = useMobileVisualViewport();
  return (
    <div
      className="project-page__modal-overlay responsive-surface-overlay"
      style={visualViewport.style}
      role="presentation"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="project-page__doc-viewer responsive-surface-panel">
        <div className="project-page__doc-viewer-header">
          <div className="project-page__doc-viewer-title">
            <span className="project-page__doc-viewer-icon">
              <DocumentGlyph />
            </span>
            <span className="project-page__doc-viewer-name">
              {doc.filename}
            </span>
            <span className="project-page__doc-badge">
              {doc.chunkCount} chunks
            </span>
          </div>
          <ResponsiveDialogCloseButton
            onClick={onClose}
            label="Close knowledge document"
          />
        </div>
        <div className="project-page__doc-viewer-body">
          {loading ? (
            <SkeletonBlock count={3} label="Loading content" />
          ) : content ? (
            doc.filename.endsWith('.md') ? (
              <div className="project-page__doc-viewer-markdown">
                <LazyMarkdown>{content}</LazyMarkdown>
              </div>
            ) : (
              <pre className="project-page__doc-viewer-content">{content}</pre>
            )
          ) : (
            <div className="project-page__doc-viewer-empty">
              Unable to load document content
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
