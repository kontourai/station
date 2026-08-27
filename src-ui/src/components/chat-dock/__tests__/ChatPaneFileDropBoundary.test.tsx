/** @vitest-environment jsdom */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import {
  ChatPaneFileDropBoundary,
  isChatPaneFileDropEnabled,
} from '../ChatPaneFileDropBoundary';

function transfer(files: File[]): DataTransfer {
  return {
    types: ['Files'],
    files,
    items: [],
  } as unknown as DataTransfer;
}

describe('ChatPaneFileDropBoundary', () => {
  test('the production pane root accepts its first external descendant entry and receives one bubbled drop', async () => {
    const selectFiles = vi.fn(async () => {});
    const childClick = vi.fn();
    render(
      <ChatPaneFileDropBoundary
        enabled
        onActivity={vi.fn()}
        onFocusWithinChange={vi.fn()}
        reportError={vi.fn()}
        resetKey="dock|open"
        selectFiles={selectFiles}
      >
        <button type="button" onClick={childClick}>
          Composer child
        </button>
      </ChatPaneFileDropBoundary>,
    );
    screen.getByRole('region', { name: 'Chat dock' });
    const child = screen.getByRole('button', { name: 'Composer child' });
    const dataTransfer = transfer([new File(['x'], 'note.txt')]);
    fireEvent.dragEnter(child, { dataTransfer, relatedTarget: null });
    const overlay = screen.getByTestId('chat-pane-file-drop-overlay');
    expect(overlay.textContent).toBe('Drop 1 file to attach');
    expect(overlay.className).toContain('chat-dock__file-drop-overlay');
    fireEvent.click(child);
    expect(childClick).toHaveBeenCalledOnce();

    fireEvent.drop(child, { dataTransfer });
    await waitFor(() => expect(selectFiles).toHaveBeenCalledOnce());
    expect(selectFiles).toHaveBeenCalledWith([
      expect.objectContaining({ name: 'note.txt' }),
    ]);
  });

  test('an empty no-session pane neither overlays nor consumes or stages file drops', () => {
    const selectFiles = vi.fn(async () => {});
    const reportError = vi.fn();
    render(
      <ChatPaneFileDropBoundary
        enabled={isChatPaneFileDropEnabled({
          hasAttachmentOwner: false,
          isPaneOpen: true,
          isCollapsedDragPreview: false,
        })}
        onActivity={vi.fn()}
        onFocusWithinChange={vi.fn()}
        reportError={reportError}
        resetKey="dock|open|no-session"
        selectFiles={selectFiles}
      >
        <div>No active session</div>
      </ChatPaneFileDropBoundary>,
    );

    const pane = screen.getByRole('region', { name: 'Chat dock' });
    const dataTransfer = transfer([new File(['x'], 'note.txt')]);

    expect(
      fireEvent.dragEnter(pane, { dataTransfer, relatedTarget: null }),
    ).toBe(true);
    expect(screen.queryByTestId('chat-pane-file-drop-overlay')).toBeNull();
    expect(fireEvent.drop(pane, { dataTransfer })).toBe(true);
    expect(selectFiles).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();
  });

  test('an active sending or disabled composer remains an eligible attachment owner', async () => {
    const selectFiles = vi.fn(async () => {});
    render(
      <ChatPaneFileDropBoundary
        enabled={isChatPaneFileDropEnabled({
          hasAttachmentOwner: true,
          isPaneOpen: true,
          isCollapsedDragPreview: false,
        })}
        onActivity={vi.fn()}
        onFocusWithinChange={vi.fn()}
        reportError={vi.fn()}
        resetKey="dock|open|sending"
        selectFiles={selectFiles}
      >
        <div>Sending</div>
      </ChatPaneFileDropBoundary>,
    );

    const pane = screen.getByRole('region', { name: 'Chat dock' });
    const dataTransfer = transfer([new File(['x'], 'note.txt')]);
    fireEvent.dragEnter(pane, { dataTransfer, relatedTarget: null });
    expect(screen.getByTestId('chat-pane-file-drop-overlay')).toBeTruthy();
    fireEvent.drop(pane, { dataTransfer });
    await waitFor(() => expect(selectFiles).toHaveBeenCalledOnce());
  });

  test('the production ChatDock callsite derives ownership from its view model', () => {
    const chatDock = readFileSync(
      join(__dirname, '..', 'ChatDock.tsx'),
      'utf8',
    );

    expect(chatDock).toMatch(
      /enabled=\{isChatPaneFileDropEnabled\(\{\s*hasAttachmentOwner: activeSessionForHook !== null,\s*isPaneOpen,\s*isCollapsedDragPreview,\s*\}\)\}/,
    );
  });
});
