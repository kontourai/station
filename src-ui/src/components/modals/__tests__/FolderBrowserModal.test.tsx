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
