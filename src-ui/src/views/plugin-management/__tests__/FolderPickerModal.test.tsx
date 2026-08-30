/** @vitest-environment jsdom */

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const browseMock = vi.fn();

vi.mock('@kontourai/station-sdk', () => ({
  useFileSystemBrowseQuery: (path?: string) => browseMock(path),
}));

import { FolderPickerModal } from '../FolderPickerModal';

/**
 * #1014 moved the folder browser to a shared component
 * (`components/modals/FolderBrowserModal`). These tests pin plugin
 * management's own behaviour and markup as unchanged by that move: the same
 * `plugins__*` classnames the page's CSS already styles, the same title id,
 * and the same navigate/select/empty/error behaviour the un-tested original
 * had.
 */
describe('FolderPickerModal (plugin management)', () => {
  beforeEach(() => {
    browseMock.mockReset();
  });

  test('renders with the original plugin-management classnames', () => {
    browseMock.mockReturnValue({
      data: { path: '/tmp', entries: [{ name: 'project', isDirectory: true }] },
    });

    render(<FolderPickerModal onSelect={vi.fn()} onClose={vi.fn()} />);

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
    const onSelect = vi.fn();
    const onClose = vi.fn();

    render(<FolderPickerModal onSelect={onSelect} onClose={onClose} />);

    fireEvent.click(screen.getByText('project'));
    expect(browseMock).toHaveBeenCalledWith('/tmp/project');
    expect(screen.getByText('No subdirectories')).toBeTruthy();

    fireEvent.click(screen.getByText('Select This Folder'));
    expect(onSelect).toHaveBeenCalledWith('/tmp/project');
    expect(onClose).toHaveBeenCalledOnce();
  });

  test('surfaces a browse error the same way as before', () => {
    browseMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error('Permission denied'),
    });

    render(<FolderPickerModal onSelect={vi.fn()} onClose={vi.fn()} />);

    const message = screen.getByText('Permission denied');
    expect(message.className).toBe(
      'plugins__modal-message plugins__message--error',
    );
  });
});
