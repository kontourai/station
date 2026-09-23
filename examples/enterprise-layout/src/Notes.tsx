import { useToast } from '@kontourai/station-sdk';
import { useCallback, useState } from 'react';
import { NoteActions } from './components/NoteActions';
import { NoteEditor } from './components/NoteEditor';
import { NoteFilterBar } from './components/NoteFilterBar';
import { NotesSidebar } from './components/NotesSidebar';
import { useEnhanceNote, useHasVault, useVaultSave } from './data';
import {
  type NoteFrontmatter,
  type NoteSummary,
  toNoteSummary,
  useDeleteNote,
  useFilteredNotes,
  useNoteContent,
  useNoteTree,
  useSaveNote,
  useUpdateNote,
} from './data/notes-hooks';
import { useProjectSlug } from './hooks/useProjectSlug';
import type { KnowledgeDocumentMeta } from './types/knowledge';

interface NoteFilter {
  query: string;
  territory: string;
  type: string;
  status: string;
}

const EMPTY_FILTER: NoteFilter = {
  query: '',
  territory: '',
  type: '',
  status: '',
};
const EMPTY_FM: NoteFrontmatter = {};

export function Notes() {
  const { showToast } = useToast();
  const projectSlug = useProjectSlug();

  // Navigation state
  const [selected, setSelected] = useState<NoteSummary | null>(null);
  const selectedPath = selected?.path ?? null;
  const [filter, setFilter] = useState<NoteFilter>(EMPTY_FILTER);

  // Editor state
  const [content, setContent] = useState('');
  const [frontmatter, setFrontmatter] = useState<NoteFrontmatter>(EMPTY_FM);
  const [dirty, setDirty] = useState(false);
  const [isNew, setIsNew] = useState(false);

  // Data hooks
  const tree = useNoteTree();
  const filteredNotes = useFilteredNotes({
    query: filter.query || undefined,
    territory: filter.territory || undefined,
    type: filter.type || undefined,
    status: filter.status || undefined,
  });
  const noteContent = useNoteContent(isNew ? null : (selected?.docId ?? null));
  const saveNote = useSaveNote();
  const updateNote = useUpdateNote();
  const deleteNote = useDeleteNote();
  const enhanceNote = useEnhanceNote();
  const hasVault = useHasVault(projectSlug ?? undefined);
  const vaultSave = useVaultSave(projectSlug ?? '', 'enterprise-notes');

  // Sync loaded note into editor. The content route returns the body only;
  // frontmatter comes from the selected document's metadata.
  const loadedContent = noteContent.data ?? '';
  const loadedFm = selected?.frontmatter ?? EMPTY_FM;

  function handleSelectNote(note: NoteSummary) {
    if (dirty) {
      // Simple guard — could use useUnsavedGuard but Notes is self-contained
      if (!window.confirm('You have unsaved changes. Discard?')) return;
    }
    setSelected(note);
    setIsNew(false);
    setDirty(false);
    // Content will be loaded by useNoteContent
    setContent('');
    setFrontmatter(EMPTY_FM);
  }

  // Once note content loads, populate editor
  if (
    !dirty &&
    !isNew &&
    noteContent.data !== undefined &&
    content !== loadedContent
  ) {
    setContent(loadedContent);
    setFrontmatter(loadedFm);
  }

  function handleNew() {
    if (dirty && !window.confirm('You have unsaved changes. Discard?')) return;
    setSelected(null);
    setIsNew(true);
    setContent('');
    setFrontmatter(EMPTY_FM);
    setDirty(false);
  }

  function handleContentChange(v: string) {
    setContent(v);
    setDirty(true);
  }

  function handleFrontmatterChange(fm: NoteFrontmatter) {
    setFrontmatter(fm);
    setDirty(true);
  }

  const handleSave = useCallback(async () => {
    const title = frontmatter.title || 'Untitled';
    try {
      if (isNew || !selected) {
        const filename = `${Date.now()}-${title.toLowerCase().replace(/\s+/g, '-')}.md`;
        const created: KnowledgeDocumentMeta = await saveNote.mutateAsync({
          filename,
          content,
          metadata: frontmatter,
        });
        setSelected(toNoteSummary(created));
        setIsNew(false);
      } else {
        await updateNote.mutateAsync({
          docId: selected.docId,
          content,
          metadata: frontmatter,
        });
        setSelected({ ...selected, frontmatter });
      }
      setDirty(false);
      showToast('Note saved', 'success');
    } catch {
      showToast('Failed to save note', 'error');
    }
  }, [selected, isNew, content, frontmatter, saveNote, updateNote, showToast]);

  const handleEnhance = useCallback(async () => {
    try {
      const enhanced = await enhanceNote.mutateAsync(content);
      setContent(enhanced);
      setFrontmatter((fm) => ({ ...fm, status: 'enhanced' }));
      setDirty(true);
      showToast('Note enhanced', 'success');
    } catch {
      showToast('Failed to enhance note', 'error');
    }
  }, [content, enhanceNote, showToast]);

  const handleVault = useCallback(async () => {
    if (!hasVault || !selected) {
      showToast('No vault configured', 'warning');
      return;
    }
    try {
      await vaultSave.mutateAsync({
        filename: selected.path,
        content,
        metadata: frontmatter,
      });
      showToast('Saved to vault', 'success');
    } catch {
      showToast('Failed to save to vault', 'error');
    }
  }, [hasVault, selected, content, frontmatter, vaultSave, showToast]);

  const handleDelete = useCallback(async () => {
    if (!selected) return;
    try {
      await deleteNote.mutateAsync(selected.docId);
      setSelected(null);
      setContent('');
      setFrontmatter(EMPTY_FM);
      setDirty(false);
      setIsNew(false);
      showToast('Note deleted', 'success');
    } catch {
      showToast('Failed to delete note', 'error');
    }
  }, [selected, deleteNote, showToast]);

  const hasNote = isNew || !!selected;

  return (
    <div className="workspace-container workspace-container--notes">
      {/* Column 1: Tree sidebar */}
      <NotesSidebar
        tree={tree.data}
        selectedPath={selectedPath}
        onSelect={handleSelectNote}
        loading={tree.isLoading}
      />

      {/* Column 2: Filtered note list */}
      <div className="notes-list-panel">
        <NoteFilterBar
          query={filter.query}
          territory={filter.territory}
          type={filter.type}
          status={filter.status}
          onQueryChange={(v) => setFilter((f) => ({ ...f, query: v }))}
          onTerritoryChange={(v) => setFilter((f) => ({ ...f, territory: v }))}
          onTypeChange={(v) => setFilter((f) => ({ ...f, type: v }))}
          onStatusChange={(v) => setFilter((f) => ({ ...f, status: v }))}
          onClear={() => setFilter(EMPTY_FILTER)}
        />
        <div className="notes-list">
          {filteredNotes.isLoading && (
            <div className="notes-list-loading">Loading…</div>
          )}
          {!filteredNotes.isLoading && filteredNotes.data.length === 0 && (
            <div className="notes-list-empty">No notes match filters</div>
          )}
          {filteredNotes.data.map((note) => (
            <button
              type="button"
              key={note.docId}
              className={`notes-list-item ${note.docId === selected?.docId ? 'notes-list-item--active' : ''}`}
              onClick={() => handleSelectNote(note)}
            >
              <span className="notes-list-item-title">{note.title}</span>
              <span className="notes-list-item-meta">
                {note.frontmatter.territory && (
                  <span className="notes-list-item-tag">
                    {note.frontmatter.territory}
                  </span>
                )}
                {note.frontmatter.type && (
                  <span className="notes-list-item-tag">
                    {note.frontmatter.type}
                  </span>
                )}
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* Column 3: Editor */}
      <div className="notes-editor-panel">
        <NoteActions
          hasNote={hasNote}
          dirty={dirty}
          saving={saveNote.isPending || updateNote.isPending}
          enhancing={enhanceNote.isPending}
          vaulting={vaultSave.isPending}
          onNew={handleNew}
          onSave={handleSave}
          onEnhance={handleEnhance}
          onVault={handleVault}
          onDelete={handleDelete}
        />
        {hasNote ? (
          <NoteEditor
            content={content}
            frontmatter={frontmatter}
            onChange={handleContentChange}
            onFrontmatterChange={handleFrontmatterChange}
          />
        ) : (
          <div className="notes-editor-empty">
            <p>Select a note or create a new one</p>
          </div>
        )}
      </div>
    </div>
  );
}
