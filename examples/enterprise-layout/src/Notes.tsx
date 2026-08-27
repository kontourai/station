import { useToast } from '@kontourai/station-sdk';
import { useCallback, useState } from 'react';
import { NoteActions } from './components/NoteActions';
import { NoteEditor } from './components/NoteEditor';
import { NoteFilterBar } from './components/NoteFilterBar';
import { NotesSidebar } from './components/NotesSidebar';
import { useEnhanceNote, useHasVault, useVaultSave } from './data';
import {
  type NoteFrontmatter,
  useDeleteNote,
  useFilteredNotes,
  useNoteContent,
  useNoteTree,
  useSaveNote,
  useUpdateNote,
} from './data/notes-hooks';
import { useProjectSlug } from './hooks/useProjectSlug';

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
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
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
  const noteContent = useNoteContent(isNew ? null : selectedPath);
  const saveNote = useSaveNote();
  const updateNote = useUpdateNote();
  const deleteNote = useDeleteNote();
  const enhanceNote = useEnhanceNote();
  const hasVault = useHasVault(projectSlug ?? undefined);
  const vaultSave = useVaultSave(projectSlug ?? '', 'enterprise-notes');

  // Sync loaded note into editor
  const loadedContent = noteContent.data?.content ?? '';
  const loadedFm =
    (noteContent.data?.frontmatter as NoteFrontmatter) ?? EMPTY_FM;

  function handleSelectNote(path: string) {
    if (dirty) {
      // Simple guard — could use useUnsavedGuard but Notes is self-contained
      if (!window.confirm('You have unsaved changes. Discard?')) return;
    }
    setSelectedPath(path);
    setIsNew(false);
    setDirty(false);
    // Content will be loaded by useNoteContent
    setContent('');
    setFrontmatter(EMPTY_FM);
  }

  // Once note content loads, populate editor
  if (!dirty && !isNew && noteContent.data && content !== loadedContent) {
    setContent(loadedContent);
    setFrontmatter(loadedFm);
  }

  function handleNew() {
    if (dirty && !window.confirm('You have unsaved changes. Discard?')) return;
    setSelectedPath(null);
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
    const path =
      selectedPath ??
      `notes/${Date.now()}-${title.toLowerCase().replace(/\s+/g, '-')}.md`;
    try {
      if (isNew || !selectedPath) {
        await saveNote.mutateAsync({ path, content, frontmatter });
        setSelectedPath(path);
        setIsNew(false);
      } else {
        await updateNote.mutateAsync({ path, content, frontmatter });
      }
      setDirty(false);
      showToast('Note saved', 'success');
    } catch {
      showToast('Failed to save note', 'error');
    }
  }, [
    selectedPath,
    isNew,
    content,
    frontmatter,
    saveNote,
    updateNote,
    showToast,
  ]);

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
    if (!hasVault || !selectedPath) {
      showToast('No vault configured', 'warning');
      return;
    }
    try {
      await vaultSave.mutateAsync({ path: selectedPath, content, frontmatter });
      showToast('Saved to vault', 'success');
    } catch {
      showToast('Failed to save to vault', 'error');
    }
  }, [hasVault, selectedPath, content, frontmatter, vaultSave, showToast]);

  const handleDelete = useCallback(async () => {
    if (!selectedPath) return;
    try {
      await deleteNote.mutateAsync(selectedPath);
      setSelectedPath(null);
      setContent('');
      setFrontmatter(EMPTY_FM);
      setDirty(false);
      setIsNew(false);
      showToast('Note deleted', 'success');
    } catch {
      showToast('Failed to delete note', 'error');
    }
  }, [selectedPath, deleteNote, showToast]);

  const hasNote = isNew || !!selectedPath;

  return (
    <div className="workspace-container workspace-container--notes">
      {/* Column 1: Tree sidebar */}
      <NotesSidebar
        tree={tree.data ?? []}
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
          {!filteredNotes.isLoading &&
            (filteredNotes.data ?? []).length === 0 && (
              <div className="notes-list-empty">No notes match filters</div>
            )}
          {(filteredNotes.data ?? []).map((note) => (
            <button
              type="button"
              key={note.path}
              className={`notes-list-item ${note.path === selectedPath ? 'notes-list-item--active' : ''}`}
              onClick={() => handleSelectNote(note.path)}
            >
              <span className="notes-list-item-title">
                {(note.frontmatter as NoteFrontmatter)?.title ?? note.name}
              </span>
              <span className="notes-list-item-meta">
                {(note.frontmatter as NoteFrontmatter)?.territory && (
                  <span className="notes-list-item-tag">
                    {(note.frontmatter as NoteFrontmatter).territory}
                  </span>
                )}
                {(note.frontmatter as NoteFrontmatter)?.type && (
                  <span className="notes-list-item-tag">
                    {(note.frontmatter as NoteFrontmatter).type}
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
