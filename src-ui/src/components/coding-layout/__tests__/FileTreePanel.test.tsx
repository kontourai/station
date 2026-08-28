/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  clipboardAbsent,
  clipboardRefuses,
  clipboardWrites,
} from '../../../__tests__/clipboard-stubs';

const createMutate = vi.fn();
const renameMutate = vi.fn();
const deleteMutate = vi.fn();
const previewProjectWorkspaceFileMock = vi.fn();

const filesState: { data: unknown; isLoading: boolean; error: unknown } = {
  data: [],
  isLoading: false,
  error: null,
};

vi.mock('@kontourai/station-sdk', () => ({
  useCodingFilesQuery: () => filesState,
  useCreateCodingFileMutation: () => ({ mutate: createMutate, error: null }),
  useRenameCodingFileMutation: () => ({ mutate: renameMutate, error: null }),
  useDeleteCodingFileMutation: () => ({ mutate: deleteMutate, error: null }),
}));
vi.mock('@kontourai/station-sdk/workspace-file-preview', () => ({
  previewProjectWorkspaceFile: (...args: unknown[]) =>
    previewProjectWorkspaceFileMock(...args),
}));

vi.mock('../../../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: '' }),
}));

const addFileMock = vi.fn();
const removeFileMock = vi.fn();
const removeFilesAtPathMock = vi.fn();
const attachState: {
  files: {
    projectSlug: string;
    path: string;
    content: string;
    lineRange?: { start: number; end: number };
  }[];
} = {
  files: [],
};
vi.mock('../../../providers/context/CodingFilesContextProvider', () => ({
  useCodingFilesContext: () => ({
    files: attachState.files,
    has: (p: string) => attachState.files.some((f) => f.path === p),
    addFile: addFileMock,
    removeFile: removeFileMock,
    removeFilesAtPath: removeFilesAtPathMock,
  }),
}));

import { activeTerminalWriter } from '../activeTerminal';
import { FileTreePanel } from '../FileTreePanel';

const tree = [
  {
    name: 'src',
    path: 'src',
    type: 'directory',
    children: [{ name: 'app.ts', path: 'src/app.ts', type: 'file' }],
  },
  { name: 'README.md', path: 'README.md', type: 'file' },
];

beforeEach(() => {
  filesState.data = tree;
  filesState.isLoading = false;
  filesState.error = null;
  attachState.files = [];
  createMutate.mockClear();
  renameMutate.mockClear();
  deleteMutate.mockClear();
  previewProjectWorkspaceFileMock.mockReset();
  addFileMock.mockClear();
  addFileMock.mockReturnValue(true);
  removeFileMock.mockClear();
  removeFilesAtPathMock.mockClear();
  clipboardAbsent();
});

function renderPanel(onFileSelect = vi.fn()) {
  return render(
    <FileTreePanel
      projectSlug="project"
      workingDir="/repo"
      onFileSelect={onFileSelect}
    />,
  );
}

describe('FileTreePanel', () => {
  test('renders directories and (expanded) files', () => {
    renderPanel();
    expect(screen.getByText('src')).toBeTruthy();
    expect(screen.getByText('app.ts')).toBeTruthy();
    expect(screen.getByText('README.md')).toBeTruthy();
  });

  test('the filter input prunes the tree to matches', () => {
    renderPanel();
    fireEvent.change(screen.getByPlaceholderText('Filter files…'), {
      target: { value: 'readme' },
    });
    expect(screen.getByText('README.md')).toBeTruthy();
    expect(screen.queryByText('app.ts')).toBeNull();
  });

  test('right-click a file opens a menu and Delete confirms then mutates', () => {
    renderPanel();
    fireEvent.contextMenu(screen.getByText('README.md'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    // ConfirmModal appears; the mutation only fires after confirming.
    expect(deleteMutate).not.toHaveBeenCalled();
    const confirm = screen
      .getAllByRole('button', { name: 'Delete' })
      .find((b) => b.classList.contains('button--danger'));
    fireEvent.click(confirm!);
    expect(deleteMutate).toHaveBeenCalledWith({ target: 'README.md' });
  });

  test('New File from a directory creates inside it', () => {
    renderPanel();
    fireEvent.contextMenu(screen.getByText('src'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'New File' }));
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'new.ts' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(createMutate).toHaveBeenCalledWith({
      target: 'src/new.ts',
      type: 'file',
    });
  });

  test('Rename pre-fills the name and mutates with the new path', () => {
    renderPanel();
    fireEvent.contextMenu(screen.getByText('app.ts'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    const input = screen.getByRole('textbox') as HTMLInputElement;
    expect(input.value).toBe('app.ts');
    fireEvent.change(input, { target: { value: 'main.ts' } });
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    expect(renameMutate).toHaveBeenCalledWith({
      from: 'src/app.ts',
      to: 'src/main.ts',
    });
  });

  test('a name with a slash is rejected before mutating', () => {
    renderPanel();
    fireEvent.contextMenu(screen.getByText('src'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'New File' }));
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'a/b.ts' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(createMutate).not.toHaveBeenCalled();
    expect(screen.getByText('Name cannot contain a slash')).toBeTruthy();
  });

  test('the header + button opens a New File / New Folder menu', () => {
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'New file or folder' }));
    expect(screen.getByRole('menuitem', { name: 'New File' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'New Folder' })).toBeTruthy();
  });

  test('the labeled empty file-tree region keeps the root menu available alongside the header action', () => {
    renderPanel();
    const fileTree = screen.getByRole('region', { name: 'File tree' });

    fireEvent.contextMenu(fileTree, { clientX: 24, clientY: 48 });
    expect(screen.getByRole('menuitem', { name: 'New File' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close menu' }));

    fireEvent.click(screen.getByRole('button', { name: 'New file or folder' }));
    expect(screen.getByRole('menuitem', { name: 'New Folder' })).toBeTruthy();
  });

  test('Add to chat uses the bounded Project preview and attaches its normalized context', async () => {
    previewProjectWorkspaceFileMock.mockResolvedValue({
      path: 'src/app.ts',
      status: 'ready',
      renderKind: 'source',
      content: 'const x = 1;',
    });
    renderPanel();
    fireEvent.contextMenu(screen.getByText('app.ts'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Add to chat' }));
    // Content is fetched workspace-scoped (root + relative path), then attached.
    await vi.waitFor(() => expect(addFileMock).toHaveBeenCalled());
    expect(previewProjectWorkspaceFileMock).toHaveBeenCalledWith(
      '',
      'project',
      { path: 'src/app.ts' },
    );
    expect(addFileMock).toHaveBeenCalledWith(
      { projectSlug: 'project', path: 'src/app.ts' },
      expect.objectContaining({ content: 'const x = 1;' }),
    );
  });

  test('an attached file offers Remove from chat and shows a marker', () => {
    attachState.files = [
      { projectSlug: 'project', path: 'src/app.ts', content: 'x' },
    ];
    renderPanel();
    expect(screen.getByLabelText('Attached to chat context')).toBeTruthy();
    fireEvent.contextMenu(screen.getByText('app.ts'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove from chat' }));
    expect(removeFileMock).toHaveBeenCalledWith({
      projectSlug: 'project',
      path: 'src/app.ts',
    });
  });

  test('keeps exact whole-file removal distinct from all same-path attachments', () => {
    attachState.files = [
      { projectSlug: 'project', path: 'src/app.ts', content: 'whole' },
      {
        projectSlug: 'project',
        path: 'src/app.ts',
        content: 'first range',
        lineRange: { start: 8, end: 12 },
      },
      {
        projectSlug: 'project',
        path: 'src/app.ts',
        content: 'second range',
        lineRange: { start: 20, end: 24 },
      },
    ];
    renderPanel();
    fireEvent.contextMenu(screen.getByText('app.ts'));

    fireEvent.click(
      screen.getByRole('menuitem', { name: 'Remove whole file from chat' }),
    );
    expect(removeFileMock).toHaveBeenCalledWith({
      projectSlug: 'project',
      path: 'src/app.ts',
    });
    expect(removeFilesAtPathMock).not.toHaveBeenCalled();

    fireEvent.contextMenu(screen.getByText('app.ts'));
    fireEvent.click(
      screen.getByRole('menuitem', {
        name: 'Remove all 3 attachments from chat',
      }),
    );
    expect(removeFilesAtPathMock).toHaveBeenCalledWith('project', 'src/app.ts');
  });

  test('Copy path writes the workspace-relative path to the clipboard', async () => {
    const writeText = clipboardWrites();
    renderPanel();
    fireEvent.contextMenu(screen.getByText('app.ts'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy path' }));
    expect(writeText).toHaveBeenCalledWith('src/app.ts');
    // A resolved write leaves no error behind.
    await waitFor(() =>
      expect(screen.queryByText('Clipboard unavailable')).toBeNull(),
    );
  });

  // archive#3341: `navigator.clipboard?.writeText(p).catch(...)` short-circuits
  // the whole expression when there is no clipboard, so the `.catch` that was
  // supposed to report this never ran on the one origin that needs it.
  test('an insecure origin with no clipboard API reports the failure', async () => {
    clipboardAbsent();
    renderPanel();
    fireEvent.contextMenu(screen.getByText('app.ts'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy path' }));
    await waitFor(() =>
      expect(screen.getByText('Clipboard unavailable')).toBeTruthy(),
    );
  });

  test('a refused write reports the failure', async () => {
    clipboardRefuses();
    renderPanel();
    fireEvent.contextMenu(screen.getByText('app.ts'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy path' }));
    await waitFor(() =>
      expect(screen.getByText('Clipboard unavailable')).toBeTruthy(),
    );
  });

  test('directories do not offer chat/clipboard actions', () => {
    renderPanel();
    fireEvent.contextMenu(screen.getByText('src'));
    expect(screen.queryByRole('menuitem', { name: 'Add to chat' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Copy path' })).toBeNull();
  });

  test('Send to terminal types the path into the active terminal', () => {
    const writer = vi.fn(() => true);
    activeTerminalWriter.setActive('t1', writer);
    try {
      renderPanel();
      fireEvent.contextMenu(screen.getByText('app.ts'));
      fireEvent.click(
        screen.getByRole('menuitem', { name: 'Send to terminal' }),
      );
      expect(writer).toHaveBeenCalledWith('src/app.ts ');
    } finally {
      activeTerminalWriter.clearActive('t1');
    }
  });

  test('Send to terminal surfaces an error when no terminal is active', () => {
    activeTerminalWriter.clearActive('t1');
    renderPanel();
    fireEvent.contextMenu(screen.getByText('app.ts'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Send to terminal' }));
    expect(screen.getByText('No active terminal')).toBeTruthy();
  });
});
