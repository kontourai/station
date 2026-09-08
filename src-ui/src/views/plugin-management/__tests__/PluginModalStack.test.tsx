/** @vitest-environment jsdom */

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const browseMock = vi.fn();

vi.mock('@kontourai/station-sdk', () => ({
  useFileSystemBrowseQuery: (path?: string) => browseMock(path),
}));

import { PluginModalStack } from '../PluginModalStack';

/**
 * #1014 moved plugin management's folder browser to a shared component
 * (`components/modals/FolderBrowserModal`), rendered directly by
 * `PluginModalStack` — the plugin-management-owned `FolderPickerModal.tsx`
 * wrapper this file used to target was deleted (a pure classNames adapter
 * with exactly one consumer; see `scripts/proof-repo-guardrails.mjs`). These
 * tests pin plugin management's own behaviour and markup as unchanged by
 * that move, exercised through the real seam it now lives behind: the same
 * `plugins__*` classnames the page's CSS already styles, the same title id,
 * and the same navigate/select/empty/error behaviour the un-tested original
 * had.
 */

function renderFolderPicker(
  overrides: Partial<{
    onSelectFolder: (value: string) => void;
    onCloseFolderPicker: () => void;
    removeConfirm: string;
    removalRetainsData: boolean;
    showFolderPicker: boolean;
  }> = {},
) {
  return render(
    <PluginModalStack
      apiBase="http://localhost:3000"
      showInstallModal={false}
      showFolderPicker={overrides.showFolderPicker ?? true}
      previewData={null}
      previewSkips={new Set()}
      installPending={false}
      previewPending={false}
      installSource=""
      installMessage={null}
      message={null}
      removeConfirm={overrides.removeConfirm ?? null}
      removalRetainsData={overrides.removalRetainsData}
      layoutAssignment={null}
      projects={[]}
      quickProjectName=""
      selectedProjects={new Set()}
      assigningLayout={false}
      onChangeSource={vi.fn()}
      onBrowse={vi.fn()}
      onInstall={vi.fn()}
      onCloseInstall={vi.fn()}
      onSelectFolder={overrides.onSelectFolder ?? vi.fn()}
      onCloseFolderPicker={overrides.onCloseFolderPicker ?? vi.fn()}
      onClosePreview={vi.fn()}
      onToggleSkip={vi.fn()}
      onConfirmInstall={vi.fn()}
      onCancelRemove={vi.fn()}
      onConfirmRemove={vi.fn()}
      onCloseLayoutAssignment={vi.fn()}
      onToggleProject={vi.fn()}
      onCreateProject={vi.fn()}
      onAddToProjects={vi.fn()}
    />,
  );
}

describe('PluginModalStack folder picker (plugin management)', () => {
  beforeEach(() => {
    browseMock.mockReset();
  });

  test('removal confirmation explains retained data instead of claiming irreversible deletion', () => {
    renderFolderPicker({
      removeConfirm: 'fixture',
      removalRetainsData: true,
      showFolderPicker: false,
    });
    expect(
      screen.getByText(/stored data and code versions will be retained/),
    ).toBeTruthy();
    expect(screen.queryByText(/This cannot be undone/)).toBeNull();
  });

  test('renders with the original plugin-management classnames', () => {
    browseMock.mockReturnValue({
      data: { path: '/tmp', entries: [{ name: 'project', isDirectory: true }] },
    });

    renderFolderPicker();

    expect(document.querySelector('.plugins__modal-overlay')).toBeTruthy();
    expect(
      document.querySelector('.plugins__modal.plugins__folder-modal'),
    ).toBeTruthy();
    expect(document.querySelector('.plugins__modal-header')).toBeTruthy();
    expect(document.querySelector('.plugins__folder-path')).toBeTruthy();
    expect(screen.getByText('project').closest('button')?.className).toBe(
      'plugins__folder-entry',
    );
    expect(screen.getByText('Select This Folder').className).toBe(
      'plugins__folder-select-btn',
    );
    expect(screen.getByRole('heading', { name: 'Select Folder' }).id).toBe(
      'folder-picker-title',
    );
  });

  test('navigating, selecting, and closing still work exactly as before', () => {
    browseMock.mockImplementation((path?: string) => {
      if (path === '/tmp/project') {
        return {
          data: { path: '/tmp/project', entries: [] },
        };
      }
      return {
        data: {
          path: '/tmp',
          entries: [{ name: 'project', isDirectory: true }],
        },
      };
    });
    const onSelectFolder = vi.fn();
    const onCloseFolderPicker = vi.fn();

    renderFolderPicker({ onSelectFolder, onCloseFolderPicker });

    fireEvent.click(screen.getByText('project'));
    expect(browseMock).toHaveBeenCalledWith('/tmp/project');
    expect(screen.getByText('No subdirectories')).toBeTruthy();

    fireEvent.click(screen.getByText('Select This Folder'));
    expect(onSelectFolder).toHaveBeenCalledWith('/tmp/project');
    expect(onCloseFolderPicker).toHaveBeenCalledOnce();
  });

  test('surfaces a browse error the same way as before', () => {
    browseMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error('Permission denied'),
    });

    renderFolderPicker();

    const message = screen.getByText('Permission denied');
    expect(message.className).toBe(
      'plugins__modal-message plugins__message--error',
    );
  });
});
