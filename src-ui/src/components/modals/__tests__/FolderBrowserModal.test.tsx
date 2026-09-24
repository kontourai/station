/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const browseMock = vi.fn();

vi.mock('@kontourai/station-sdk', () => ({
  useFileSystemBrowseQuery: (path?: string) => browseMock(path),
}));

import { FolderBrowserModal } from '../FolderBrowserModal';

describe('FolderBrowserModal', () => {
  beforeEach(() => {
    browseMock.mockReset();
  });

  test('navigates into a subdirectory on click', () => {
    browseMock.mockImplementation((path?: string) => {
      if (path === '/tmp/project') {
        return {
          data: {
            path: '/tmp/project',
            entries: [{ name: 'src', isDirectory: true }],
          },
        };
      }
      return {
        data: {
          path: '/tmp',
          entries: [{ name: 'project', isDirectory: true }],
        },
      };
    });

    render(
      <FolderBrowserModal
        onSelect={vi.fn()}
        onClose={vi.fn()}
        initialPath="/tmp"
      />,
    );

    fireEvent.click(screen.getByText('project'));

    expect(browseMock).toHaveBeenCalledWith('/tmp/project');
    expect(screen.getByText('src')).toBeTruthy();
  });

  test('goes up a level via the ".." row', () => {
    browseMock.mockImplementation((path?: string) => {
      if (path === '/tmp') {
        return {
          data: {
            path: '/tmp',
            entries: [{ name: 'project', isDirectory: true }],
          },
        };
      }
      return {
        data: {
          path: '/tmp/project',
          entries: [{ name: 'src', isDirectory: true }],
        },
      };
    });

    render(
      <FolderBrowserModal
        onSelect={vi.fn()}
        onClose={vi.fn()}
        initialPath="/tmp/project"
      />,
    );

    expect(screen.getByText('..')).toBeTruthy();
    fireEvent.click(screen.getByText('..'));

    expect(browseMock).toHaveBeenCalledWith('/tmp');
    expect(screen.getByText('project')).toBeTruthy();
  });

  test('omits the ".." row at the filesystem root', () => {
    browseMock.mockReturnValue({
      data: { path: '/', entries: [{ name: 'Users', isDirectory: true }] },
    });

    render(
      <FolderBrowserModal
        onSelect={vi.fn()}
        onClose={vi.fn()}
        initialPath="/"
      />,
    );

    expect(screen.queryByText('..')).toBeNull();
  });

  // Windows navigation is server-driven: the server owns the path semantics
  // (the UI may be browsing a remote Windows host from any client). These
  // cases pin the contract that replaced the POSIX-only `..` regex, which
  // could not climb backslash paths at all.
  test('navigates a Windows listing via the server-provided parent and entry paths', () => {
    browseMock.mockImplementation((path?: string) => {
      if (path === 'C:\\') {
        return {
          data: {
            path: 'C:\\',
            parent: '\\',
            selectable: true,
            entries: [
              { name: 'Projects', isDirectory: true, path: 'C:\\Projects' },
            ],
          },
        };
      }
      return {
        data: {
          path: 'C:\\Projects',
          parent: 'C:\\',
          selectable: true,
          entries: [
            { name: 'src', isDirectory: true, path: 'C:\\Projects\\src' },
          ],
        },
      };
    });

    render(
      <FolderBrowserModal
        onSelect={vi.fn()}
        onClose={vi.fn()}
        initialPath={'C:\\Projects'}
      />,
    );

    fireEvent.click(screen.getByText('..'));
    expect(browseMock).toHaveBeenCalledWith('C:\\');

    // Drives and children carry their own full paths — no client-side join.
    fireEvent.click(screen.getByText('Projects'));
    expect(browseMock).toHaveBeenCalledWith('C:\\Projects');
  });

  test('renders the Windows drive level: no "..", labelled, unselectable, drives navigate', () => {
    browseMock.mockReturnValue({
      data: {
        path: '\\',
        parent: null,
        label: 'This PC',
        selectable: false,
        entries: [
          { name: 'C:', isDirectory: true, path: 'C:\\' },
          { name: 'D:', isDirectory: true, path: 'D:\\' },
        ],
      },
    });

    render(
      <FolderBrowserModal
        onSelect={vi.fn()}
        onClose={vi.fn()}
        initialPath={'\\'}
      />,
    );

    expect(screen.queryByText('..')).toBeNull();
    const location = screen.getByText('This PC');
    expect(location.getAttribute('aria-current')).toBe('location');

    const selectButton = screen.getByRole('button', {
      name: 'Select This Folder',
    });
    expect(selectButton).toHaveProperty('disabled', true);

    fireEvent.click(screen.getByText('D:'));
    expect(browseMock).toHaveBeenCalledWith('D:\\');
  });

  // Older servers predate `parent`/per-entry `path`; the local fallback must
  // still climb backslash paths correctly (this is the exact regression that
  // made the Windows picker unable to leave the starting folder).
  test('derives ".." locally for older servers on Windows paths', () => {
    browseMock.mockReturnValue({
      data: {
        path: 'C:\\Users\\brian',
        entries: [{ name: 'dev', isDirectory: true }],
      },
    });

    render(
      <FolderBrowserModal
        onSelect={vi.fn()}
        onClose={vi.fn()}
        initialPath={'C:\\Users\\brian'}
      />,
    );

    fireEvent.click(screen.getByText('..'));
    expect(browseMock).toHaveBeenCalledWith('C:\\Users');

    // Legacy entries are joined with the listing's own separator.
    fireEvent.click(screen.getByText('dev'));
    expect(browseMock).toHaveBeenCalledWith('C:\\Users\\brian\\dev');
  });

  test('treats a Windows drive root as the top for older servers', () => {
    browseMock.mockReturnValue({
      data: { path: 'C:\\', entries: [] },
    });

    render(
      <FolderBrowserModal
        onSelect={vi.fn()}
        onClose={vi.fn()}
        initialPath={'C:\\'}
      />,
    );

    expect(screen.queryByText('..')).toBeNull();
  });

  test('selecting the resolved folder calls onSelect and onClose', () => {
    browseMock.mockReturnValue({
      data: { path: '/tmp', entries: [{ name: 'project', isDirectory: true }] },
    });
    const onSelect = vi.fn();
    const onClose = vi.fn();

    render(
      <FolderBrowserModal
        onSelect={onSelect}
        onClose={onClose}
        initialPath="/tmp"
      />,
    );

    fireEvent.click(screen.getByText('Select This Folder'));

    expect(onSelect).toHaveBeenCalledWith('/tmp');
    expect(onClose).toHaveBeenCalledOnce();
  });

  test('marks the resolved path as the current location for assistive tech', () => {
    browseMock.mockReturnValue({
      data: { path: '/tmp', entries: [] },
    });

    render(
      <FolderBrowserModal
        onSelect={vi.fn()}
        onClose={vi.fn()}
        initialPath="/tmp"
      />,
    );

    const code = screen.getByText('/tmp');
    expect(code.getAttribute('aria-current')).toBe('location');
  });

  test('arrow keys move roving focus between rows without activating them', () => {
    browseMock.mockReturnValue({
      data: {
        path: '/tmp',
        entries: [
          { name: 'alpha', isDirectory: true },
          { name: 'beta', isDirectory: true },
        ],
      },
    });

    render(
      <FolderBrowserModal
        onSelect={vi.fn()}
        onClose={vi.fn()}
        initialPath="/tmp"
      />,
    );

    const parentRow = screen.getByText('..').closest('button')!;
    const alphaRow = screen.getByText('alpha').closest('button')!;
    const betaRow = screen.getByText('beta').closest('button')!;

    // Roving tabindex: only the first row is a tab stop until focus moves.
    expect(parentRow.tabIndex).toBe(0);
    expect(alphaRow.tabIndex).toBe(-1);
    expect(betaRow.tabIndex).toBe(-1);

    fireEvent.keyDown(parentRow, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(alphaRow);
    expect(alphaRow.tabIndex).toBe(0);
    expect(parentRow.tabIndex).toBe(-1);

    fireEvent.keyDown(alphaRow, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(betaRow);

    fireEvent.keyDown(betaRow, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(alphaRow);

    // Browsing (real navigation) requires an activation event (click), not a
    // mere arrow-key focus move — the directory query must not re-fire.
    expect(browseMock).not.toHaveBeenCalledWith('/tmp/alpha');
  });

  test('renders the empty state when a directory has no subdirectories', () => {
    browseMock.mockReturnValue({
      data: { path: '/tmp/empty', entries: [] },
    });

    render(
      <FolderBrowserModal
        onSelect={vi.fn()}
        onClose={vi.fn()}
        initialPath="/tmp/empty"
      />,
    );

    expect(screen.getByText('No subdirectories')).toBeTruthy();
  });

  test('renders the error state', () => {
    browseMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error('Permission denied'),
    });

    render(
      <FolderBrowserModal
        onSelect={vi.fn()}
        onClose={vi.fn()}
        initialPath="/root"
      />,
    );

    expect(screen.getByText('Permission denied')).toBeTruthy();
  });

  test('renders a loading skeleton instead of entries while the query is in flight', () => {
    browseMock.mockReturnValue({ data: undefined, isLoading: true });

    render(
      <FolderBrowserModal
        onSelect={vi.fn()}
        onClose={vi.fn()}
        initialPath="/tmp"
      />,
    );

    expect(
      screen.queryByRole('button', { name: /Select This Folder/ }),
    ).toBeTruthy();
    expect(screen.queryByText('..')).toBeNull();
  });

  test('applies caller-supplied classnames (plugin management parity)', () => {
    browseMock.mockReturnValue({
      data: { path: '/tmp', entries: [{ name: 'project', isDirectory: true }] },
    });

    render(
      <FolderBrowserModal
        onSelect={vi.fn()}
        onClose={vi.fn()}
        initialPath="/tmp"
        titleId="folder-picker-title"
        classNames={{
          panel: 'plugins__modal plugins__folder-modal',
          entry: 'plugins__folder-entry',
          selectButton: 'plugins__folder-select-btn',
        }}
      />,
    );

    expect(screen.getByText('project').closest('button')?.className).toBe(
      'plugins__folder-entry',
    );
    expect(screen.getByText('Select This Folder').className).toBe(
      'plugins__folder-select-btn',
    );
    expect(document.querySelector('.plugins__folder-modal')).toBeTruthy();
  });
});
