/**
 * @vitest-environment jsdom
 *
 * Notes against the knowledge API's real shapes (#2343). The pane used to
 * pass `{ path, content, frontmatter }` to hooks that take
 * `{ filename, content, metadata }`, address documents by path where the API
 * takes a document id, read `.content` off a body the API returns as a string,
 * and render the tree route's single root node as if it were an array. The
 * SDK knowledge hooks are stubbed with the shapes their fetchers return; the
 * Notes pane, its notes-hooks adapter and its child components are real.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

const alpha = {
  id: 'doc-alpha',
  filename: 'alpha.md',
  namespace: 'enterprise-notes',
  path: 'alpha.md',
  source: 'upload' as const,
  chunkCount: 1,
  createdAt: '2026-09-01T00:00:00.000Z',
  metadata: { title: 'Alpha review', territory: 'West' },
};
const beta = {
  ...alpha,
  id: 'doc-beta',
  filename: 'beta.md',
  path: 'beta.md',
  metadata: { title: 'Beta kickoff' },
};

const sdk = vi.hoisted(() => ({
  filtered: vi.fn(),
  content: vi.fn(),
  save: { mutateAsync: vi.fn(), isPending: false },
  update: { mutateAsync: vi.fn(), isPending: false },
  remove: { mutateAsync: vi.fn(), isPending: false },
}));

vi.mock('@kontourai/station-sdk', () => ({
  useToast: () => ({ showToast: vi.fn() }),
  useKnowledgeTreeQuery: () => ({
    // The tree route returns the namespace's root directory node.
    data: {
      name: 'enterprise-notes',
      path: '',
      type: 'directory',
      children: [
        { name: 'alpha.md', path: 'alpha.md', type: 'file', doc: alpha },
        { name: 'orphan.md', path: 'orphan.md', type: 'file' },
      ],
    },
    isLoading: false,
  }),
  useKnowledgeFilteredQuery: sdk.filtered,
  useKnowledgeDocContentQuery: sdk.content,
  useKnowledgeSaveMutation: () => sdk.save,
  useKnowledgeUpdateMutation: () => sdk.update,
  useKnowledgeDeleteMutation: () => sdk.remove,
}));

vi.mock('../hooks/useProjectSlug', () => ({
  useProjectSlug: () => 'enterprise',
}));

const idleMutation = { mutateAsync: vi.fn(), isPending: false };
vi.mock('../data', () => ({
  useEnhanceNote: () => idleMutation,
  useHasVault: () => false,
  useVaultSave: () => idleMutation,
}));

import { Notes } from '../Notes';

const BODIES: Record<string, string> = {
  'doc-alpha': '# Alpha body',
  'doc-beta': '# Beta body',
};

function renderNotes() {
  sdk.filtered.mockReturnValue({ data: [alpha, beta], isLoading: false });
  sdk.content.mockImplementation((_slug: string, docId: string | null) => ({
    data: docId ? BODIES[docId] : undefined,
  }));
  return render(<Notes />);
}

function editor() {
  return document.getElementById('note-editor-textarea') as HTMLTextAreaElement;
}

afterEach(() => {
  vi.clearAllMocks();
  delete BODIES['doc-new'];
});

describe('Notes over the knowledge API', () => {
  test('lists notes by their metadata title and opens one by document id', () => {
    renderNotes();

    fireEvent.click(screen.getByText('Beta kickoff'));

    expect(sdk.content).toHaveBeenLastCalledWith(
      'enterprise',
      'doc-beta',
      'enterprise-notes',
    );
    expect(editor().value).toBe('# Beta body');
  });

  test('opens a note from the tree, and cannot open a file with no document', () => {
    renderNotes();

    expect(screen.getByTitle('orphan.md')).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByTitle('alpha.md'));

    expect(editor().value).toBe('# Alpha body');
  });

  test('saves an edited note in place by document id, with frontmatter as metadata', async () => {
    renderNotes();
    fireEvent.click(screen.getByText('Alpha review'));

    fireEvent.change(editor(), { target: { value: '# Alpha, revised' } });
    // Resolve the save and flush the state updates that follow it.
    await act(async () => {
      fireEvent.click(screen.getByTitle('Save note'));
    });

    expect(sdk.update.mutateAsync).toHaveBeenCalledWith({
      docId: 'doc-alpha',
      content: '# Alpha, revised',
      metadata: { title: 'Alpha review', territory: 'West' },
    });
    expect(sdk.save.mutateAsync).not.toHaveBeenCalled();
    // The stubbed body is still the pre-edit text, as a cached query would
    // be. The saved edit must stay in the editor, or the next save writes
    // from the stale base.
    expect(editor().value).toBe('# Alpha, revised');
  });

  test('filters frontmatter fields server-side and free text locally', () => {
    renderNotes();

    fireEvent.change(screen.getByPlaceholderText('Territory'), {
      target: { value: 'West' },
    });
    expect(sdk.filtered).toHaveBeenLastCalledWith(
      'enterprise',
      'enterprise-notes',
      { metadata: { territory: 'West' } },
      { enabled: true },
    );

    fireEvent.change(screen.getByPlaceholderText('Search notes…'), {
      target: { value: 'kickoff' },
    });
    expect(screen.getByText('Beta kickoff')).toBeTruthy();
    expect(screen.queryByText('Alpha review')).toBeNull();
  });

  test('keeps the editor read-only until the selected note body arrives', () => {
    const view = renderNotes();
    let delivered = false;
    sdk.content.mockImplementation((_slug: string, docId: string | null) => ({
      data: delivered && docId ? BODIES[docId] : undefined,
    }));

    fireEvent.click(screen.getByText('Beta kickoff'));
    expect(editor().readOnly).toBe(true);
    fireEvent.change(editor(), { target: { value: 'typed too early' } });
    expect(editor().value).toBe('');

    delivered = true;
    view.rerender(<Notes />);

    expect(editor().readOnly).toBe(false);
    expect(editor().value).toBe('# Beta body');
  });

  test('says so and offers Retry when a note body fails to load', () => {
    const view = renderNotes();
    const refetch = vi.fn();
    let failed = true;
    sdk.content.mockImplementation((_slug: string, docId: string | null) =>
      failed
        ? { data: undefined, isError: true, refetch }
        : { data: docId ? BODIES[docId] : undefined, refetch },
    );

    fireEvent.click(screen.getByText('Beta kickoff'));
    expect(editor().readOnly).toBe(true);
    expect(screen.getByRole('alert').textContent).toContain(
      'could not be loaded',
    );
    // Actions that read the note's text wait for it, without claiming to be
    // mid-action.
    const vault = screen.getByRole('button', { name: /vault/i });
    const enhance = screen.getByRole('button', { name: /enhance/i });
    expect(vault.hasAttribute('disabled')).toBe(true);
    expect(enhance.hasAttribute('disabled')).toBe(true);
    expect(vault.textContent).not.toContain('Saving');
    expect(enhance.textContent).not.toContain('Enhancing');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refetch).toHaveBeenCalledTimes(1);

    failed = false;
    view.rerender(<Notes />);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(editor().value).toBe('# Beta body');
  });

  test('keeps the text of a note it just created when the new body arrives', async () => {
    renderNotes();
    sdk.save.mutateAsync.mockResolvedValue({
      ...alpha,
      id: 'doc-new',
      filename: 'new.md',
      path: 'new.md',
      metadata: {},
    });
    // What the server serves for the new document differs from the editor,
    // as a normalized or not-yet-indexed body would.
    BODIES['doc-new'] = 'server copy';

    fireEvent.click(screen.getByTitle('New note'));
    fireEvent.change(editor(), { target: { value: '# Fresh note' } });
    await act(async () => {
      fireEvent.click(screen.getByTitle('Save note'));
    });

    expect(sdk.save.mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ content: '# Fresh note' }),
    );
    expect(sdk.content).toHaveBeenLastCalledWith(
      'enterprise',
      'doc-new',
      'enterprise-notes',
    );
    expect(editor().value).toBe('# Fresh note');
  });
});
