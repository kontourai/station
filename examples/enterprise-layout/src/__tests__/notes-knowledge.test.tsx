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
import { fireEvent, render, screen } from '@testing-library/react';
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

afterEach(() => vi.clearAllMocks());

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
    fireEvent.click(screen.getByTitle('Save note'));

    expect(sdk.update.mutateAsync).toHaveBeenCalledWith({
      docId: 'doc-alpha',
      content: '# Alpha, revised',
      metadata: { title: 'Alpha review', territory: 'West' },
    });
    expect(sdk.save.mutateAsync).not.toHaveBeenCalled();
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
});
