/**
 * @vitest-environment jsdom
 */

import { agentId } from '@kontourai/station-contracts/agent-identity';
import type { GitStatusResult } from '@kontourai/station-sdk';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  ActiveWorkContextFrame,
  ActiveWorkModalBoundary,
  changedFileEntry,
  collectAttachedContext,
} from '../components/chat-dock/ActiveWorkContextFrame';
import type { ChatSession } from '../types';

afterEach(cleanup);

const session: ChatSession = {
  id: 'task-333',
  agentSlug: agentId('codex'),
  agentName: 'Codex',
  title: 'Contextual active work',
  source: 'manual',
  sourceId: undefined,
  messages: [
    {
      role: 'user',
      content: 'Use the issue',
      attachments: [
        {
          id: 'issue',
          name: 'Issue #333',
          type: 'text/plain',
          size: 20,
          data: 'issue',
        },
      ],
    },
  ],
  input: '',
  attachments: [
    {
      id: 'context',
      name: 'CONTEXT.md',
      type: 'text/markdown',
      size: 42,
      data: 'context',
    },
  ],
  queuedMessages: [],
  status: 'idle',
  createdAt: 1,
  updatedAt: 2,
  hasUnread: false,
  inputHistory: [],
  projectSlug: 'station',
  projectName: 'Station',
};

const gitStatus: GitStatusResult = {
  isRepo: true,
  branch: 'feat/contextual-active-work',
  changes: [' M src-ui/src/App.tsx', 'R  old.ts -> new.ts'],
  staged: 1,
  unstaged: 1,
  untracked: 0,
  lastCommit: null,
  ahead: 0,
  behind: 0,
};

describe('ActiveWorkContextFrame', () => {
  test('derives real changed-file paths and deduplicated attached context', () => {
    expect(changedFileEntry(' M src-ui/src/App.tsx')).toEqual({
      displayPath: 'src-ui/src/App.tsx',
      editorPath: 'src-ui/src/App.tsx',
      status: 'M',
    });
    expect(changedFileEntry('R  old.ts -> new.ts')).toEqual({
      displayPath: 'old.ts -> new.ts',
      editorPath: null,
      status: 'R',
    });
    expect(changedFileEntry(' M "docs/unsafe path.md"').editorPath).toBeNull();
    expect(changedFileEntry(' M ../outside.ts').editorPath).toBeNull();
    expect(collectAttachedContext(session).map((item) => item.name)).toEqual([
      'CONTEXT.md',
      'Issue #333',
    ]);
  });

  test('shows sourced task, branch, changed files, attachments, and explicit unavailable checks', () => {
    const onOpenProjectContext = vi.fn();
    render(
      <ActiveWorkContextFrame
        panel="context"
        isMobile={false}
        session={session}
        gitStatus={gitStatus}
        canOpenFiles
        onClose={vi.fn()}
        onOpenFile={vi.fn()}
        onOpenProjectContext={onOpenProjectContext}
      />,
    );

    expect(screen.getByText('Contextual active work')).toBeTruthy();
    expect(screen.getByText('feat/contextual-active-work')).toBeTruthy();
    expect(screen.getByText('CONTEXT.md')).toBeTruthy();
    expect(screen.getByText('Issue #333')).toBeTruthy();
    expect(screen.getByText('Checks').nextElementSibling?.textContent).toBe(
      'Unavailable',
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Open project context' }),
    );
    expect(onOpenProjectContext).toHaveBeenCalledOnce();
  });

  test('shows honest unknown states and opens real editor file paths', () => {
    const onOpenFile = vi.fn();
    const { rerender } = render(
      <ActiveWorkContextFrame
        panel="files"
        isMobile={false}
        session={session}
        gitStatus={null}
        canOpenFiles
        onClose={vi.fn()}
        onOpenFile={onOpenFile}
        onOpenProjectContext={vi.fn()}
      />,
    );
    expect(screen.getByText('Changed-file status unavailable')).toBeTruthy();
    expect(
      screen.getByText('Changed-file status unavailable').closest('.empty'),
    ).toBeTruthy();

    rerender(
      <ActiveWorkContextFrame
        panel="files"
        isMobile={false}
        session={session}
        gitStatus={gitStatus}
        canOpenFiles
        onClose={vi.fn()}
        onOpenFile={onOpenFile}
        onOpenProjectContext={vi.fn()}
      />,
    );
    fireEvent.click(
      screen.getByRole('button', { name: /Open src-ui\/src\/App.tsx/ }),
    );
    expect(onOpenFile).toHaveBeenCalledWith('src-ui/src/App.tsx');
    const ambiguous = screen.getByRole('button', {
      name: 'Changed file old.ts -> new.ts',
    }) as HTMLButtonElement;
    expect(ambiguous.disabled).toBe(true);
    expect(ambiguous.title).toBe(
      'Editor navigation is unavailable for this path',
    );
  });

  test('uses the canonical empty state for a clean working tree', () => {
    const cleanStatus = { ...gitStatus, changes: [] };
    const { container } = render(
      <ActiveWorkContextFrame
        panel="files"
        isMobile={false}
        session={session}
        gitStatus={cleanStatus}
        canOpenFiles
        onClose={vi.fn()}
        onOpenFile={vi.fn()}
        onOpenProjectContext={vi.fn()}
      />,
    );

    expect(container.querySelector('.active-work-frame__empty')).toBeNull();
    expect(
      screen.getByText('Working tree is clean').closest('.empty'),
    ).toBeTruthy();
  });

  test('mobile enters and contains focus, then restores its trigger on close', () => {
    const onClose = vi.fn();
    const animationFrame: { callback: FrameRequestCallback | null } = {
      callback: null,
    };
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      animationFrame.callback = callback;
      return 1;
    });
    const trigger = document.createElement('button');
    trigger.textContent = 'Task context trigger';
    document.body.append(trigger);
    trigger.focus();
    const { unmount } = render(
      <ActiveWorkContextFrame
        panel="context"
        isMobile
        session={session}
        gitStatus={gitStatus}
        canOpenFiles
        visualViewportStyle={{
          '--responsive-visual-viewport-height': '360px',
          '--responsive-visual-viewport-top': '12px',
        }}
        onClose={onClose}
        onOpenFile={vi.fn()}
        onOpenProjectContext={vi.fn()}
      />,
    );

    const dialog = screen.getByRole('dialog', { name: 'Task context' });
    expect(dialog.classList.contains('responsive-surface-panel')).toBe(true);
    expect(
      dialog.parentElement?.classList.contains('responsive-surface-overlay'),
    ).toBe(true);
    const close = screen.getByRole('button', { name: 'Close task context' });
    const project = screen.getByRole('button', {
      name: 'Open project context',
    });
    expect(document.activeElement).toBe(close);
    project.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(project);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
    unmount();
    expect(document.activeElement).not.toBe(trigger);
    animationFrame.callback?.(0);
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  test('mobile backdrop is a semantic dismiss button that preserves pointer close', () => {
    const onClose = vi.fn();
    render(
      <ActiveWorkContextFrame
        panel="context"
        isMobile
        session={session}
        gitStatus={gitStatus}
        canOpenFiles
        onClose={onClose}
        onOpenFile={vi.fn()}
        onOpenProjectContext={vi.fn()}
      />,
    );

    const dismiss = screen.getByRole('button', {
      name: 'Dismiss task context',
    }) as HTMLButtonElement;
    expect(dismiss.type).toBe('button');
    fireEvent.mouseDown(dismiss);
    expect(onClose).toHaveBeenCalledOnce();
  });

  test('mobile backdrop closes once for pointer and native button activation', () => {
    const onPointerClose = vi.fn();
    const pointerView = render(
      <ActiveWorkContextFrame
        panel="context"
        isMobile
        session={session}
        gitStatus={gitStatus}
        canOpenFiles
        onClose={onPointerClose}
        onOpenFile={vi.fn()}
        onOpenProjectContext={vi.fn()}
      />,
    );
    const pointerDismiss = screen.getByRole('button', {
      name: 'Dismiss task context',
    });
    fireEvent.mouseDown(pointerDismiss);
    fireEvent.click(pointerDismiss);
    expect(onPointerClose).toHaveBeenCalledOnce();
    pointerView.unmount();

    for (const key of ['Enter', ' ']) {
      const onKeyboardClose = vi.fn();
      const keyboardView = render(
        <ActiveWorkContextFrame
          panel="context"
          isMobile
          session={session}
          gitStatus={gitStatus}
          canOpenFiles
          onClose={onKeyboardClose}
          onOpenFile={vi.fn()}
          onOpenProjectContext={vi.fn()}
        />,
      );
      const keyboardDismiss = screen.getByRole('button', {
        name: 'Dismiss task context',
      });
      keyboardDismiss.focus();
      fireEvent.keyDown(keyboardDismiss, { key });
      // Browsers dispatch click for Enter and Space on native buttons.
      fireEvent.click(keyboardDismiss);
      expect(onKeyboardClose).toHaveBeenCalledOnce();
      keyboardView.unmount();
    }
  });

  /**
   * archive#1206 gap 3. This sheet hand-rolled the same
   * `if (returnFocus?.isConnected) returnFocus.focus` as the shared frame and
   * imports only `ResponsiveDialogCloseButton`, so #1187's ancestor fallback
   * never reached it — a trigger removed while the sheet is open still dropped
   * focus to `<body>`. It now goes through `@kontourai/station-shared/return-focus`.
   */
  test('mobile falls back to the nearest surviving ancestor when the trigger is gone', () => {
    const animationFrame: { callback: FrameRequestCallback | null } = {
      callback: null,
    };
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      animationFrame.callback = callback;
      return 1;
    });
    const list = document.createElement('div');
    const row = document.createElement('div');
    const trigger = document.createElement('button');
    row.append(trigger);
    list.append(row);
    document.body.append(list);
    trigger.focus();

    render(
      <ActiveWorkContextFrame
        panel="context"
        isMobile
        session={session}
        gitStatus={gitStatus}
        canOpenFiles
        onClose={vi.fn()}
        onOpenFile={vi.fn()}
        onOpenProjectContext={vi.fn()}
      />,
    );
    row.remove();

    fireEvent.keyDown(document, { key: 'Escape' });
    animationFrame.callback?.(0);

    expect(document.activeElement).toBe(list);
    expect(document.activeElement).not.toBe(document.body);
    expect(list.getAttribute('tabindex')).toBe('-1');
    list.remove();
  });

  test('mobile modal isolates the complete dock background without hiding the sheet', () => {
    const { rerender } = render(
      <>
        <ActiveWorkModalBoundary active>
          <header>Dock header</header>
          <nav>Session tabs</nav>
          <div>Project context triggers</div>
          <main>Conversation</main>
        </ActiveWorkModalBoundary>
        <ActiveWorkContextFrame
          panel="context"
          isMobile
          session={session}
          gitStatus={gitStatus}
          canOpenFiles
          onClose={vi.fn()}
          onOpenFile={vi.fn()}
          onOpenProjectContext={vi.fn()}
        />
      </>,
    );

    const background = screen.getByText('Dock header').parentElement;
    const dialog = screen.getByRole('dialog', { name: 'Task context' });
    expect(background?.hasAttribute('inert')).toBe(true);
    expect(background?.getAttribute('aria-hidden')).toBe('true');
    expect(background?.contains(screen.getByText('Session tabs'))).toBe(true);
    expect(
      background?.contains(screen.getByText('Project context triggers')),
    ).toBe(true);
    expect(background?.contains(screen.getByText('Conversation'))).toBe(true);
    expect(background?.contains(dialog)).toBe(false);
    expect(dialog.hasAttribute('inert')).toBe(false);
    expect(dialog.getAttribute('aria-hidden')).toBeNull();

    rerender(
      <ActiveWorkModalBoundary active={false}>
        <header>Dock header</header>
      </ActiveWorkModalBoundary>,
    );
    const restored = screen.getByText('Dock header').parentElement;
    expect(restored?.hasAttribute('inert')).toBe(false);
    expect(restored?.getAttribute('aria-hidden')).toBeNull();
  });
});
