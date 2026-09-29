/** @vitest-environment jsdom */

import {
  createWorkspaceCodingDiffPaneInstance,
  createWorkspaceCodingFileBrowserPaneInstance,
} from '@kontourai/station-contracts/workspace-coding-panels';
import type { WorkspacePaneInstance } from '@kontourai/station-contracts/workspace-pane';
import { createWorkspacePaneHostBaselineDocument } from '@kontourai/station-contracts/workspace-pane-host';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { requestCenterChatPage } from '../../../app-shell/chat-placement';
import { NavigationProvider } from '../../../contexts/NavigationContext';
import { navigationStore } from '../../../contexts/navigation-store';
import type { WorkspacePaneHostOpenAction } from '../../../workspace-panes/WorkspacePaneHostOpenContext';
import { workspacePaneHostScopeKey } from '../../../workspace-panes/workspacePaneHostNavigation';
import { WORKSPACE_PANE_OPENED } from '../../../workspace-panes/workspacePaneHostOpenOutcome';
import { CodingWorkbench } from '../CodingWorkbench';
import {
  resolveCodingStackLocation,
  useCodingStackSelection,
} from '../codingStackPage';

const harness = vi.hoisted(() => ({
  isMobile: false,
  chatTitle: 'Fix the flaky login test',
  shortcuts: new Map<
    string,
    { key: string; modifiers: string[]; handler: () => void }
  >(),
  showSurface: vi.fn(),
  chatProps: null as null | Record<string, unknown>,
}));

// Station's one Chat controller is its own subject; here it is the page's
// occupant, with the composer textarea the stack focuses on request.
vi.mock('../../chat-dock/ChatDock', () => ({
  ChatWorkspacePane: (props: {
    onPresentationTitleChange?: (title: string) => void;
  }) => {
    const { onPresentationTitleChange } = props;
    harness.chatProps = props;
    useEffect(() => {
      onPresentationTitleChange?.(harness.chatTitle);
    }, [onPresentationTitleChange]);
    return (
      <div data-testid="center-chat">
        <div className="chat-input">
          <textarea aria-label="Message" />
        </div>
      </div>
    );
  },
}));
vi.mock('../../../hooks/useKeyboardShortcut', () => ({
  useKeyboardShortcut: (
    id: string,
    key: string,
    modifiers: string[],
    _description: string,
    handler: () => void,
  ) => {
    harness.shortcuts.set(id, { key, modifiers, handler });
  },
}));
vi.mock('../../../contexts/KeyboardShortcutsContext', async (original) => ({
  ...(await original<
    typeof import('../../../contexts/KeyboardShortcutsContext')
  >()),
  useKeyboardShortcuts: () => ({ isMac: true }),
}));
vi.mock('../../../hooks/useIsMobile', async (original) => ({
  ...(await original<typeof import('../../../hooks/useIsMobile')>()),
  useIsMobile: () => harness.isMobile,
}));
vi.mock('../../../contexts/useShowSurface', () => ({
  useShowSurface: () => harness.showSurface,
}));

const ROUTE = '/projects/demo/layouts/coding';
const scope = {
  kind: 'project' as const,
  projectId: 'project-uuid',
  layoutId: 'layout:coding',
};
const scopeKey = workspacePaneHostScopeKey(scope);
const files = createWorkspaceCodingFileBrowserPaneInstance('project-uuid')!;
const diff = createWorkspaceCodingDiffPaneInstance('project-uuid')!;
const instances: WorkspacePaneInstance[] = [files, diff];
const document = createWorkspacePaneHostBaselineDocument(
  'builtin-coding-coding',
  scope,
  instances,
)!;
const label = (instance: WorkspacePaneInstance) =>
  instance.instanceId === files.instanceId ? 'Files' : 'Diff';

function Stack({
  centerChat = true,
  hostOpen = null,
}: {
  centerChat?: boolean;
  hostOpen?: WorkspacePaneHostOpenAction | null;
}) {
  const selection = useCodingStackSelection();
  const location = resolveCodingStackLocation(
    scope,
    instances,
    selection.pane,
    selection.paneScope,
  );
  return (
    <CodingWorkbench
      projectId="project-uuid"
      projectSlug="demo"
      centerChat={centerChat}
      location={location}
      scope={scope}
      instances={instances}
      hostDocument={() => document}
      paneLabel={label}
      hostOpen={hostOpen}
      onOpenCatalog={vi.fn()}
    >
      <div data-testid="pane-host">pane host</div>
    </CodingWorkbench>
  );
}

function renderStack(props?: {
  centerChat?: boolean;
  hostOpen?: WorkspacePaneHostOpenAction | null;
}) {
  return render(
    <NavigationProvider>
      <Stack {...props} />
    </NavigationProvider>,
  );
}

const chatPage = () =>
  window.document.querySelector('.coding-workbench__page--chat')!;
const drillInPage = () =>
  window.document.querySelector('.coding-workbench__page--drill-in')!;
const crumbs = () =>
  within(screen.getByRole('list', { name: 'Breadcrumb' }))
    .getAllByRole('listitem')
    .map((item) => item.textContent);
const backButton = () =>
  screen.getByRole('button', { name: 'Back' }) as HTMLButtonElement;
const forwardButton = () =>
  screen.getByRole('button', { name: 'Forward' }) as HTMLButtonElement;

async function drillInto(name: 'Files' | 'Diff') {
  fireEvent.click(screen.getByRole('button', { name: 'Views' }));
  fireEvent.click(
    within(screen.getByRole('region', { name: 'Views' })).getByRole('button', {
      name,
    }),
  );
  await act(async () => undefined);
}

async function historyBackSettled() {
  const index = navigationStore.getHistoryIndex();
  await act(async () => {
    await vi.waitFor(() =>
      expect(navigationStore.getHistoryIndex()).toBeLessThan(index),
    );
  });
}

beforeEach(() => {
  harness.isMobile = false;
  harness.shortcuts.clear();
  harness.showSurface.mockReset();
  navigationStore.navigate(ROUTE, {
    pane: null,
    paneScope: null,
    chat: null,
    dock: null,
  });
});

afterEach(() => {
  window.localStorage.clear();
});

describe('CodingWorkbench — the Coding layout as a navigation stack', () => {
  test('lands on the Chat page: Chat is the page, the pane host is hidden and inert', () => {
    renderStack();

    expect(screen.getByTestId('center-chat')).toBeTruthy();
    expect(chatPage().getAttribute('data-active')).toBe('true');
    expect(drillInPage().getAttribute('data-active')).toBe('false');
    expect(drillInPage().hasAttribute('inert')).toBe(true);
    expect(drillInPage().getAttribute('aria-hidden')).toBe('true');
    expect(crumbs()).toEqual([harness.chatTitle]);
    expect(backButton().disabled).toBe(true);
    expect(forwardButton().disabled).toBe(true);
  });

  test('a drill-in is a pushed history entry; Back returns to the conversation and Forward re-enters', async () => {
    renderStack();
    const chatIndex = navigationStore.getHistoryIndex();

    await drillInto('Diff');

    expect(navigationStore.getHistoryIndex()).toBe(chatIndex + 1);
    expect(new URLSearchParams(window.location.search).get('pane')).toBe(
      diff.instanceId,
    );
    expect(new URLSearchParams(window.location.search).get('paneScope')).toBe(
      scopeKey,
    );
    expect(drillInPage().getAttribute('data-active')).toBe('true');
    expect(drillInPage().getAttribute('data-enter')).toBe('push');
    // Hidden behind the pane, the conversation is not in the foreground:
    // its toasts must reach the reader.
    expect(harness.chatProps).toMatchObject({ onScreen: false });
    expect(chatPage().hasAttribute('inert')).toBe(true);
    expect(crumbs()).toEqual([harness.chatTitle, 'Diff']);
    // The conversation stays mounted behind the pane (its draft, its scroll).
    expect(
      window.document.querySelector('[data-testid="center-chat"]'),
    ).not.toBeNull();

    expect(backButton().disabled).toBe(false);
    fireEvent.click(backButton());
    await historyBackSettled();

    expect(navigationStore.getHistoryIndex()).toBe(chatIndex);
    expect(chatPage().getAttribute('data-active')).toBe('true');
    expect(chatPage().getAttribute('data-enter')).toBe('pop');
    expect(harness.chatProps).toMatchObject({ onScreen: true });
    expect(crumbs()).toEqual([harness.chatTitle]);
    expect(forwardButton().disabled).toBe(false);

    fireEvent.click(forwardButton());
    await act(async () => {
      await vi.waitFor(() =>
        expect(navigationStore.getHistoryIndex()).toBe(chatIndex + 1),
      );
    });
    expect(drillInPage().getAttribute('data-active')).toBe('true');
    expect(crumbs()).toEqual([harness.chatTitle, 'Diff']);
  });

  test('Back on a drill-in reached from outside the layout goes UP to the Chat page', async () => {
    navigationStore.navigate('/elsewhere');
    navigationStore.navigate(ROUTE, {
      pane: files.instanceId,
      paneScope: scopeKey,
    });
    renderStack();
    expect(crumbs()).toEqual([harness.chatTitle, 'Files']);
    const index = navigationStore.getHistoryIndex();

    fireEvent.click(backButton());
    await act(async () => undefined);

    // Not a history.back() out of the layout: a push to the parent page.
    expect(window.location.pathname).toBe(ROUTE);
    expect(navigationStore.getHistoryIndex()).toBe(index + 1);
    expect(chatPage().getAttribute('data-active')).toBe('true');
  });

  test('⌘[ and ⌘] are Back and Forward (never Escape, which the composer owns)', async () => {
    renderStack();
    expect(harness.shortcuts.get('codingStack.back')).toMatchObject({
      key: '[',
      modifiers: ['cmd'],
    });
    expect(harness.shortcuts.get('codingStack.forward')).toMatchObject({
      key: ']',
      modifiers: ['cmd'],
    });
    expect(
      [...harness.shortcuts.values()].some((entry) => entry.key === 'Escape'),
    ).toBe(false);

    await drillInto('Files');
    act(() => harness.shortcuts.get('codingStack.back')?.handler());
    await historyBackSettled();
    expect(chatPage().getAttribute('data-active')).toBe('true');

    act(() => harness.shortcuts.get('codingStack.forward')?.handler());
    await act(async () => {
      await vi.waitFor(() =>
        expect(drillInPage().getAttribute('data-active')).toBe('true'),
      );
    });
  });

  test('choosing another conversation is a sibling move: no history entry, same page', async () => {
    renderStack();
    const index = navigationStore.getHistoryIndex();
    // What the inbox's row selection writes (`focusSession` → `setActiveChat`).
    act(() => navigationStore.setActiveChat('conversation-b'));
    expect(navigationStore.getHistoryIndex()).toBe(index);
    expect(chatPage().getAttribute('data-active')).toBe('true');
  });

  test('a conversation focused from elsewhere while a pane shows brings the conversation back', async () => {
    renderStack();
    await drillInto('Diff');
    act(() => navigationStore.setActiveChat('conversation-from-a-toast'));
    await historyBackSettled();
    expect(chatPage().getAttribute('data-active')).toBe('true');
  });

  test('"show Chat" (⌘D, showSurface) returns to the Chat page and focuses the composer', async () => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame'] });
    try {
      renderStack();
      await drillInto('Files');
      expect(requestCenterChatPage()).toBe(true);
      await historyBackSettled();
      expect(chatPage().getAttribute('data-active')).toBe('true');
      act(() => {
        vi.advanceTimersToNextFrame();
      });
      expect(window.document.activeElement).toBe(
        screen.getByRole('textbox', { name: 'Message' }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  test('a pane URL for another host, or for a layout with no pane host, is the Chat page', () => {
    expect(
      resolveCodingStackLocation(scope, instances, diff.instanceId, 'other'),
    ).toEqual({ page: 'chat', paneId: null });
    expect(
      resolveCodingStackLocation(scope, [], diff.instanceId, scopeKey),
    ).toEqual({ page: 'chat', paneId: null });
    // A pane the host has opened but not yet reported (a File Preview a click
    // just opened) is the drill-in it names, not a flash of the Chat page.
    expect(
      resolveCodingStackLocation(scope, instances, 'just-opened', scopeKey),
    ).toEqual({ page: 'drill-in', paneId: 'just-opened' });
    expect(
      resolveCodingStackLocation(scope, undefined, 'restoring', scopeKey),
    ).toEqual({ page: 'drill-in', paneId: 'restoring' });
  });

  test('on a phone, the Chat page is the maximized dock, and a drill-in closes it', async () => {
    harness.isMobile = true;
    renderStack({ centerChat: false });
    await act(async () => undefined);

    expect(screen.queryByTestId('center-chat')).toBeNull();
    expect(screen.getByText('Chat is in the dock')).toBeTruthy();
    expect(navigationStore.getSnapshot()).toMatchObject({
      isDockOpen: true,
      isDockMaximized: true,
    });

    await drillInto('Files');
    expect(navigationStore.getSnapshot().isDockOpen).toBe(false);
  });

  test('a File Preview deep link opens from the Chat page, and not again from a drill-in that wrote it', async () => {
    const open = vi.fn(() => WORKSPACE_PANE_OPENED);
    // A deep link landing on the Chat page.
    navigationStore.navigate(ROUTE, {
      previewPath: 'src/app.ts',
      previewLineStart: null,
      previewLineEnd: null,
    });
    const view = renderStack({ hostOpen: { open } });
    await act(async () => undefined);
    expect(open).toHaveBeenCalledOnce();
    expect(new URLSearchParams(window.location.search).has('previewPath')).toBe(
      false,
    );
    view.unmount();

    // The Files pane on a drill-in writes the same intent for its own row
    // and opens its preview itself.
    open.mockClear();
    navigationStore.navigate(ROUTE, {
      pane: files.instanceId,
      paneScope: scopeKey,
      previewPath: 'src/app.ts',
    });
    renderStack({ hostOpen: { open } });
    await act(async () => undefined);
    expect(open).not.toHaveBeenCalled();
  });
});
