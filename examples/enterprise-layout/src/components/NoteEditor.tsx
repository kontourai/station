import { useCallback, useState } from 'react';
import type { NoteFrontmatter } from '../data/notes-hooks';

interface NoteEditorProps {
  content: string;
  frontmatter: NoteFrontmatter;
  onChange: (content: string) => void;
  onFrontmatterChange: (fm: NoteFrontmatter) => void;
  readOnly?: boolean;
}

type EditorMode = 'edit' | 'preview';

function renderMarkdown(md: string): string {
  // Minimal safe markdown → HTML (no external dep required)
  return md
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>)/gs, '<ul>$1</ul>')
    .replace(/\n\n/g, '</p><p>')
    .replace(/^(?!<[hul])(.+)$/gm, '<p>$1</p>');
}

export function NoteEditor({
  content,
  frontmatter,
  onChange,
  onFrontmatterChange,
  readOnly = false,
}: NoteEditorProps) {
  const [mode, setMode] = useState<EditorMode>('edit');
  const [fmExpanded, setFmExpanded] = useState(false);

  const insertAtCursor = useCallback(
    (before: string, after = '') => {
      const ta = document.getElementById(
        'note-editor-textarea',
      ) as HTMLTextAreaElement | null;
      if (!ta) return;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      const selected = content.slice(start, end);
      const next =
        content.slice(0, start) +
        before +
        selected +
        after +
        content.slice(end);
      onChange(next);
      requestAnimationFrame(() => {
        ta.focus();
        ta.setSelectionRange(
          start + before.length,
          start + before.length + selected.length,
        );
      });
    },
    [content, onChange],
  );

  return (
    <div className="note-editor">
      {/* Toolbar */}
      <div className="note-editor-toolbar">
        <div className="note-editor-toolbar-left">
          <button
            type="button"
            className={`note-toolbar-btn ${mode === 'edit' ? 'note-toolbar-btn--active' : ''}`}
            onClick={() => setMode('edit')}
            title="Edit"
          >
            Edit
          </button>
          <button
            type="button"
            className={`note-toolbar-btn ${mode === 'preview' ? 'note-toolbar-btn--active' : ''}`}
            onClick={() => setMode('preview')}
            title="Preview"
          >
            Preview
          </button>
        </div>
        {mode === 'edit' && !readOnly && (
          <div className="note-editor-toolbar-right">
            <button
              type="button"
              className="note-toolbar-btn"
              onClick={() => insertAtCursor('**', '**')}
              title="Bold"
            >
              <strong>B</strong>
            </button>
            <button
              type="button"
              className="note-toolbar-btn"
              onClick={() => insertAtCursor('*', '*')}
              title="Italic"
            >
              <em>I</em>
            </button>
            <button
              type="button"
              className="note-toolbar-btn"
              onClick={() => insertAtCursor('`', '`')}
              title="Code"
            >
              {'</>'}
            </button>
            <button
              type="button"
              className="note-toolbar-btn"
              onClick={() => insertAtCursor('## ')}
              title="Heading"
            >
              H2
            </button>
            <button
              type="button"
              className="note-toolbar-btn"
              onClick={() => insertAtCursor('- ')}
              title="List item"
            >
              •
            </button>
          </div>
        )}
        <button
          type="button"
          className="note-toolbar-btn note-toolbar-btn--fm"
          onClick={() => setFmExpanded((x) => !x)}
          title="Frontmatter"
        >
          {fmExpanded ? '▲ Meta' : '▼ Meta'}
        </button>
      </div>

      {/* Frontmatter panel */}
      {fmExpanded && (
        <div className="note-frontmatter-panel">
          <label className="note-fm-field">
            <span>Title</span>
            <input
              type="text"
              value={frontmatter.title ?? ''}
              onChange={(e) =>
                onFrontmatterChange({ ...frontmatter, title: e.target.value })
              }
              disabled={readOnly}
              className="note-fm-input"
            />
          </label>
          <label className="note-fm-field">
            <span>Territory</span>
            <input
              type="text"
              value={frontmatter.territory ?? ''}
              onChange={(e) =>
                onFrontmatterChange({
                  ...frontmatter,
                  territory: e.target.value,
                })
              }
              disabled={readOnly}
              className="note-fm-input"
            />
          </label>
          <label className="note-fm-field">
            <span>Type</span>
            <input
              type="text"
              value={frontmatter.type ?? ''}
              onChange={(e) =>
                onFrontmatterChange({ ...frontmatter, type: e.target.value })
              }
              disabled={readOnly}
              className="note-fm-input"
            />
          </label>
          <label className="note-fm-field">
            <span>Status</span>
            <select
              value={frontmatter.status ?? ''}
              onChange={(e) =>
                onFrontmatterChange({ ...frontmatter, status: e.target.value })
              }
              disabled={readOnly}
              className="note-fm-input"
            >
              <option value="">—</option>
              <option value="raw">Raw</option>
              <option value="enhanced">Enhanced</option>
            </select>
          </label>
          <label className="note-fm-field">
            <span>Tags</span>
            <input
              type="text"
              value={(frontmatter.tags ?? []).join(', ')}
              onChange={(e) =>
                onFrontmatterChange({
                  ...frontmatter,
                  tags: e.target.value
                    .split(',')
                    .map((t) => t.trim())
                    .filter(Boolean),
                })
              }
              disabled={readOnly}
              placeholder="tag1, tag2"
              className="note-fm-input"
            />
          </label>
        </div>
      )}

      {/* Editor / Preview */}
      <div className="note-editor-body">
        {mode === 'edit' ? (
          <textarea
            id="note-editor-textarea"
            className="note-editor-textarea"
            value={content}
            onChange={(e) => onChange(e.target.value)}
            readOnly={readOnly}
            spellCheck
          />
        ) : (
          <div
            className="note-editor-preview"
            // eslint-disable-next-line react/no-danger
            dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }}
          />
        )}
      </div>
    </div>
  );
}
