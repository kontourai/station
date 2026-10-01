/** @vitest-environment jsdom */

import {
  createWorkspaceCodingDiffPaneInstance,
  createWorkspaceCodingFileBrowserPaneInstance,
  createWorkspaceCodingTerminalPaneInstance,
} from '@kontourai/station-contracts/workspace-coding-panels';
import type { WorkspacePaneInstance } from '@kontourai/station-contracts/workspace-pane';
import { createWorkspacePaneHostBaselineDocument } from '@kontourai/station-contracts/workspace-pane-host';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { type ReactNode, useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { requestCenterChatPage } from '../../../app-shell/chat-placement';
import { NavigationProvider } from '../../../contexts/NavigationContext';
import { navigationStore } from '../../../contexts/navigation-store';
import { deviceSettingsStore } from '../../../lib/device-settings-store';
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
  /** How many times Chat has mounted: the one instance must survive a panel. */
  chatMounts: 0,
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
      harness.chatMounts += 1;
    }, []);
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
const terminal = createWorkspaceCodingTerminalPaneInstance('project-uuid')!;
const label = (instance: WorkspacePaneInstance) =>
  instance.instanceId === files.instanceId
    ? 'Files'
    : instance.instanceId === terminal.instanceId
      ? 'Terminal'
      : 'Diff';

interface StackProps {
  centerChat?: boolean;
  hostOpen?: WorkspacePaneHostOpenAction | null;
  /** Past the wide fold: panels beside and below Chat (#3040). */
  wide?: boolean;
  /** The Terminal pane for the lower panel, drawn by `renderTerminal`. */
  terminal?: WorkspacePaneInstance;
  renderTerminal?: () => ReactNode;
}

function Stack({
  centerChat = true,
  hostOpen = null,
  wide = false,
  terminal,
  renderTerminal,
}: StackProps) {
  const selection = useCodingStackSelection();
  const held = terminal ? [...instances, terminal] : instances;
  const location = resolveCodingStackLocation(
    scope,
    held,
    selection.pane,
    selection.paneScope,
  );
  return (
    <CodingWorkbench
      projectId="project-uuid"
      projectSlug="demo"
      centerChat={centerChat}
      wide={wide}
      location={location}
      scope={scope}
      instances={held}
      hostDocument={() => document}
      terminal={
        terminal
          ? { instance: terminal, render: renderTerminal ?? (() => null) }
          : undefined
      }
      paneLabel={label}
      hostOpen={hostOpen}
      onOpenCatalog={vi.fn()}
    >
      <div data-testid="pane-host">pane host</div>
    </CodingWorkbench>
  );
}

function renderStack(props?: StackProps) {
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
const rail = () => screen.getByRole('navigation', { name: 'Views' });

async function drillInto(name: 'Files' | 'Diff') {
  fireEvent.click(within(rail()).getByRole('button', { name }));
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
  harness.chatMounts = 0;
  harness.shortcuts.clear();
  harness.showSurface.mockReset();
  deviceSettingsStore.reset('codingPanels');
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
    expect(crumbs()).toEqual(['Inbox', harness.chatTitle]);
    // The bar is the breadcrumb alone: Back and Forward are the browser's and
    // the chords', not buttons.
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Forward' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Views' })).toBeNull();
    // Every drill-in is an icon on the rail, named, none of them current.
    const items = within(rail()).getAllByRole('button');
    // Diff leads the rail whatever the host's document order.
    expect(items.map((item) => item.getAttribute('aria-label'))).toEqual([
      'Diff',
      'Files',
    ]);
    expect(
      items.some((item) => item.getAttribute('aria-current') === 'page'),
    ).toBe(false);
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
    expect(crumbs()).toEqual(['Inbox', harness.chatTitle, 'Diff']);
    // The conversation stays mounted behind the pane (its draft, its scroll).
    expect(
      window.document.querySelector('[data-testid="center-chat"]'),
    ).not.toBeNull();

    // The drill-in on screen is the rail's current icon.
    expect(
      within(rail())
        .getByRole('button', { name: 'Diff' })
        .getAttribute('aria-current'),
    ).toBe('page');
    // The earlier crumb goes back to the conversation.
    fireEvent.click(screen.getByRole('button', { name: harness.chatTitle }));
    await historyBackSettled();

    expect(navigationStore.getHistoryIndex()).toBe(chatIndex);
    expect(chatPage().getAttribute('data-active')).toBe('true');
    expect(chatPage().getAttribute('data-enter')).toBe('pop');
    expect(harness.chatProps).toMatchObject({ onScreen: true });
    expect(crumbs()).toEqual(['Inbox', harness.chatTitle]);

    // Back on the conversation, focus went to its composer; the chords are for
    // the reader who has left it.
    (window.document.activeElement as HTMLElement | null)?.blur();
    act(() => harness.shortcuts.get('codingStack.forward')?.handler());
    await act(async () => {
      await vi.waitFor(() =>
        expect(navigationStore.getHistoryIndex()).toBe(chatIndex + 1),
      );
    });
    expect(drillInPage().getAttribute('data-active')).toBe('true');
    expect(crumbs()).toEqual(['Inbox', harness.chatTitle, 'Diff']);
  });

  test('Back (the chord) on a drill-in reached from outside the layout goes UP to the Chat page', async () => {
    navigationStore.navigate('/elsewhere');
    navigationStore.navigate(ROUTE, {
      pane: files.instanceId,
      paneScope: scopeKey,
    });
    renderStack();
    expect(crumbs()).toEqual(['Inbox', harness.chatTitle, 'Files']);
    const index = navigationStore.getHistoryIndex();

    act(() => harness.shortcuts.get('codingStack.back')?.handler());
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

    // Back on the conversation, focus went to its composer; the chords are for
    // the reader who has left it.
    (window.document.activeElement as HTMLElement | null)?.blur();
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

  test('the Inbox crumb returns to the conversation with the inbox open', async () => {
    deviceSettingsStore.set('inboxOpen', false);
    renderStack();
    await drillInto('Files');
    fireEvent.click(screen.getByRole('button', { name: 'Inbox' }));
    await historyBackSettled();
    expect(chatPage().getAttribute('data-active')).toBe('true');
    expect(deviceSettingsStore.get('inboxOpen')).toBe(true);
  });

  function renderStatic(props: Partial<Parameters<typeof CodingWorkbench>[0]>) {
    return render(
      <NavigationProvider>
        <CodingWorkbench
          projectId="project-uuid"
          projectSlug="demo"
          centerChat
          location={{ page: 'chat', paneId: null }}
          scope={scope}
          instances={instances}
          hostDocument={() => document}
          paneLabel={label}
          hostOpen={null}
          onOpenCatalog={vi.fn()}
          {...props}
        >
          <div />
        </CodingWorkbench>
      </NavigationProvider>,
    );
  }

  test('a known changed-file count badges the Diff icon, and is part of its name', () => {
    renderStatic({ badges: { [diff.descriptorId]: 2 } });
    const icon = within(rail()).getByRole('button', {
      name: 'Diff, 2 changed files',
    });
    expect(icon.textContent).toBe('2');
    expect(
      within(rail()).getByRole('button', { name: 'Files' }).textContent,
    ).toBe('');
  });

  test('the rail ends with the pane catalog, which asks the host for its picker', () => {
    const onOpenCatalog = vi.fn();
    renderStatic({
      hostOpen: { open: vi.fn(() => WORKSPACE_PANE_OPENED) },
      onOpenCatalog,
    });
    const items = within(rail()).getAllByRole('button');
    expect(items.at(-1)?.getAttribute('aria-label')).toBe('Add pane');
    fireEvent.click(items.at(-1)!);
    expect(onOpenCatalog).toHaveBeenCalledWith({
      type: 'add',
      targetGroupId: 'root',
    });
  });

  test('a drill-in page offers its own actions behind one ⋯: close for a pane the reader opened', async () => {
    const close = vi.fn(async () => undefined);
    renderStatic({
      location: { page: 'drill-in', paneId: files.instanceId },
      hostOpen: { open: vi.fn(() => WORKSPACE_PANE_OPENED), close },
      closable: (instance) => instance.instanceId === files.instanceId,
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'More actions for Files' }),
    );
    fireEvent.click(
      within(screen.getByRole('menu', { name: 'Actions for Files' })).getByRole(
        'menuitem',
        { name: 'Close Files' },
      ),
    );
    expect(close).toHaveBeenCalledWith(files.instanceId);
  });

  test('a built-in drill-in with no pop-out has no ⋯ at all', () => {
    renderStatic({
      location: { page: 'drill-in', paneId: diff.instanceId },
      hostOpen: { open: vi.fn(() => WORKSPACE_PANE_OPENED), close: vi.fn() },
      closable: () => false,
    });
    expect(screen.queryByRole('button', { name: /More actions/ })).toBeNull();
  });

  test('persistence is said only when it is a problem', async () => {
    const view = renderStatic({ persistence: 'owned' });
    expect(screen.queryByRole('status')).toBeNull();
    view.rerender(
      <NavigationProvider>
        <CodingWorkbench
          projectId="project-uuid"
          projectSlug="demo"
          centerChat
          location={{ page: 'chat', paneId: null }}
          scope={scope}
          instances={instances}
          hostDocument={() => document}
          paneLabel={label}
          hostOpen={null}
          onOpenCatalog={vi.fn()}
          persistence="contended"
        >
          <div />
        </CodingWorkbench>
      </NavigationProvider>,
    );
    await act(async () => undefined);
    expect(screen.getByRole('status').textContent).toMatch(/another tab/);
  });

  test('the chords stand down only in an editor that owns the keys, and decline when there is nowhere to go', async () => {
    renderStack();
    await drillInto('Diff');
    const index = navigationStore.getHistoryIndex();
    const editable = window.document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    editable.tabIndex = 0;
    const input = window.document.createElement('input');
    window.document.body.append(editable, input);
    try {
      // A rich editor owns ⌘[ (outdent) and Alt+Arrow: the stack declines.
      editable.focus();
      expect(window.document.activeElement).toBe(editable);
      let result: unknown;
      act(() => {
        result = harness.shortcuts.get('codingStack.back')?.handler();
      });
      expect(result).toBe(false);
      expect(navigationStore.getHistoryIndex()).toBe(index);

      // A plain field does not: off macOS Alt+← there is the browser's Back,
      // which would leave the layout, so the stack takes the chord.
      input.focus();
      act(() => {
        result = harness.shortcuts.get('codingStack.back')?.handler();
      });
      expect(result).toBe(true);
      await historyBackSettled();
      expect(chatPage().getAttribute('data-active')).toBe('true');
    } finally {
      editable.remove();
      input.remove();
    }
    // On the Chat page with nothing behind it in the layout, Back has nothing
    // to do here, so the browser keeps its own Back.
    (window.document.activeElement as HTMLElement | null)?.blur();
    act(() => {
      navigationStore.navigate('/elsewhere');
      navigationStore.navigate(ROUTE, { pane: null, paneScope: null });
    });
    let result: unknown;
    act(() => {
      result = harness.shortcuts.get('codingStack.back')?.handler();
    });
    expect(result).toBe(false);
    act(() => {
      result = harness.shortcuts.get('codingStack.forward')?.handler();
    });
    expect(result).toBe(false);
  });

  test('a move that did not change the page cannot steal focus on a later page change', async () => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame'] });
    try {
      renderStack();
      await drillInto('Diff');
      // Drill-in to drill-in: a reader's move, but the same page kind.
      await drillInto('Files');
      const outside = window.document.createElement('input');
      window.document.body.append(outside);
      try {
        outside.focus();
        // A change the reader did not make (a sync, another writer).
        act(() =>
          navigationStore.updateParams({ pane: null, paneScope: null }),
        );
        act(() => {
          vi.advanceTimersToNextFrame();
        });
        expect(chatPage().getAttribute('data-active')).toBe('true');
        expect(window.document.activeElement).toBe(outside);
      } finally {
        outside.remove();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  test('clicking the drill-in already on screen is not a new entry', async () => {
    renderStack();
    await drillInto('Diff');
    const index = navigationStore.getHistoryIndex();
    await drillInto('Diff');
    await drillInto('Diff');
    expect(navigationStore.getHistoryIndex()).toBe(index);
  });

  test('a URL naming a pane the host no longer holds shows, and names, the pane on screen', () => {
    expect(
      resolveCodingStackLocation(
        scope,
        instances,
        'closed-preview',
        scopeKey,
        diff.instanceId,
      ),
    ).toEqual({ page: 'drill-in', paneId: diff.instanceId });
  });

  test('Back from a drill-in the reader was using moves focus to the composer and says where they are', async () => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame'] });
    try {
      renderStack();
      await drillInto('Diff');
      const inPane = window.document.createElement('button');
      drillInPage().append(inPane);
      inPane.focus();
      expect(window.document.activeElement).toBe(inPane);
      act(() => {
        (window.document.activeElement as HTMLElement).blur();
      });
      act(() => harness.shortcuts.get('codingStack.back')?.handler());
      await historyBackSettled();
      act(() => {
        vi.advanceTimersToNextFrame();
      });
      expect(window.document.activeElement).toBe(
        screen.getByRole('textbox', { name: 'Message' }),
      );
      expect(
        window.document.querySelector('[aria-live="polite"]')?.textContent,
      ).toBe(`Conversation: ${harness.chatTitle}`);
    } finally {
      vi.useRealTimers();
    }
  });

  test('drilling in moves focus to the breadcrumb naming the pane, not the whole page', async () => {
    renderStack();
    await drillInto('Diff');
    const current = within(
      screen.getByRole('list', { name: 'Breadcrumb' }),
    ).getByText('Diff');
    expect(window.document.activeElement).toBe(current);
    expect(current.getAttribute('aria-current')).toBe('page');
  });
});

const sidePanel = () =>
  window.document.querySelector<HTMLElement>(
    '.coding-workbench__page--drill-in',
  )!;
const lowerPanel = () =>
  window.document.querySelector<HTMLElement>('.coding-workbench__lower');
const urlPane = () => new URLSearchParams(window.location.search).get('pane');
const railItem = (name: string) => within(rail()).getByRole('button', { name });
const remembered = (sessionKey: string) =>
  deviceSettingsStore.get('codingPanels').sessions[sessionKey];

describe('CodingWorkbench — panels beside and below Chat past the wide fold (#3040, #3051)', () => {
  test('a rail pick opens the tool beside Chat: Chat stays the page, visible and the same instance; the entry is replaced, not pushed', async () => {
    renderStack({ wide: true });
    const mounts = harness.chatMounts;
    expect(mounts).toBe(1);
    const index = navigationStore.getHistoryIndex();
    expect(sidePanel().getAttribute('data-active')).toBe('false');
    expect(railItem('Diff').getAttribute('aria-pressed')).toBe('false');

    await drillInto('Diff');

    expect(urlPane()).toBe(diff.instanceId);
    expect(navigationStore.getHistoryIndex()).toBe(index);
    expect(chatPage().getAttribute('data-active')).toBe('true');
    expect(chatPage().hasAttribute('inert')).toBe(false);
    expect(harness.chatProps).toMatchObject({ onScreen: true });
    expect(sidePanel().getAttribute('data-active')).toBe('true');
    expect(sidePanel().hasAttribute('inert')).toBe(false);
    expect(screen.getByTestId('pane-host')).toBeTruthy();
    expect(harness.chatMounts).toBe(mounts);
    // The rail item is a toggle naming the panel it controls; the crumbs
    // stay the conversation's (Chat is the page).
    expect(railItem('Diff').getAttribute('aria-pressed')).toBe('true');
    expect(railItem('Diff').getAttribute('aria-controls')).toBe(sidePanel().id);
    expect(railItem('Diff').hasAttribute('aria-current')).toBe(false);
    expect(crumbs()).toEqual(['Inbox', harness.chatTitle]);
    expect(
      within(sidePanel()).getByRole('heading', { name: 'Diff' }),
    ).toBeTruthy();

    // Another item switches the panel; the same item closes it. Neither is
    // a history entry, and Chat is still the one instance.
    await drillInto('Files');
    expect(urlPane()).toBe(files.instanceId);
    expect(railItem('Diff').getAttribute('aria-pressed')).toBe('false');
    expect(railItem('Files').getAttribute('aria-pressed')).toBe('true');
    expect(navigationStore.getHistoryIndex()).toBe(index);

    await drillInto('Files');
    expect(urlPane()).toBeNull();
    expect(sidePanel().getAttribute('data-active')).toBe('false');
    expect(sidePanel().hasAttribute('inert')).toBe(true);
    expect(railItem('Files').getAttribute('aria-pressed')).toBe('false');
    expect(navigationStore.getHistoryIndex()).toBe(index);
    expect(harness.chatMounts).toBe(mounts);
    // Closed, the pane stays mounted for its state.
    expect(screen.getByTestId('pane-host')).toBeTruthy();
  });

  test('below the fold the same pick is the drill-in it always was', async () => {
    renderStack({ wide: false });
    const index = navigationStore.getHistoryIndex();
    await drillInto('Diff');
    expect(navigationStore.getHistoryIndex()).toBe(index + 1);
    expect(chatPage().getAttribute('data-active')).toBe('false');
    expect(railItem('Diff').getAttribute('aria-current')).toBe('page');
    expect(railItem('Diff').hasAttribute('aria-pressed')).toBe(false);
  });

  test('the Terminal opens in the lower panel, alongside a tool beside Chat, and is drawn only once opened', async () => {
    const renderTerminal = vi.fn(() => (
      <div data-testid="lower-terminal">terminal</div>
    ));
    renderStack({ wide: true, terminal, renderTerminal });
    const index = navigationStore.getHistoryIndex();
    expect(lowerPanel()).toBeNull();
    expect(renderTerminal).not.toHaveBeenCalled();

    await drillInto('Diff');
    fireEvent.click(railItem('Terminal'));
    await act(async () => undefined);

    expect(lowerPanel()?.getAttribute('data-active')).toBe('true');
    expect(screen.getByTestId('lower-terminal')).toBeTruthy();
    expect(railItem('Terminal').getAttribute('aria-pressed')).toBe('true');
    expect(railItem('Terminal').getAttribute('aria-controls')).toBe(
      lowerPanel()?.id,
    );
    // Both at once: the side tool is untouched, and the Terminal is no
    // entry and no URL.
    expect(sidePanel().getAttribute('data-active')).toBe('true');
    expect(urlPane()).toBe(diff.instanceId);
    expect(navigationStore.getHistoryIndex()).toBe(index);
    expect(chatPage().getAttribute('data-active')).toBe('true');
    expect(
      screen
        .getByRole('separator', { name: 'Resize Terminal panel' })
        .getAttribute('aria-orientation'),
    ).toBe('horizontal');

    // Closed: hidden and inert, still mounted.
    fireEvent.click(railItem('Terminal'));
    await act(async () => undefined);
    expect(lowerPanel()?.getAttribute('data-active')).toBe('false');
    expect(lowerPanel()?.hasAttribute('inert')).toBe(true);
    expect(screen.getByTestId('lower-terminal')).toBeTruthy();
    expect(sidePanel().getAttribute('data-active')).toBe('true');
  });

  test('a URL naming the Terminal on a wide screen opens it below and clears the side', async () => {
    navigationStore.navigate(ROUTE, {
      chat: 'conv-t',
      pane: terminal.instanceId,
      paneScope: scopeKey,
    });
    renderStack({ wide: true, terminal });
    await act(async () => undefined);
    expect(urlPane()).toBeNull();
    expect(lowerPanel()?.getAttribute('data-active')).toBe('true');
    expect(sidePanel().getAttribute('data-active')).toBe('false');
    expect(remembered('conv-t')?.terminalOpen).toBe(true);
  });

  test('the separators resize by keyboard within bounds that keep Chat its floor, and reset', async () => {
    renderStack({ wide: true, terminal });
    await drillInto('Diff');
    const pages = window.document.querySelector<HTMLElement>(
      '.coding-workbench__pages',
    )!;
    const side = screen.getByRole('separator', { name: 'Resize Diff panel' });
    expect(side.getAttribute('aria-orientation')).toBe('vertical');
    expect(side.getAttribute('aria-valuemin')).toBe('320');
    // jsdom's 1024px viewport with the 44px rail: 1068 - 44 - 8 - 480.
    expect(side.getAttribute('aria-valuemax')).toBe('536');
    expect(side.getAttribute('aria-valuenow')).toBe('440');
    expect(pages.style.getPropertyValue('--coding-side-width')).toBe('440px');

    fireEvent.keyDown(side, { key: 'ArrowLeft' });
    expect(side.getAttribute('aria-valuenow')).toBe('456');
    expect(pages.style.getPropertyValue('--coding-side-width')).toBe('456px');
    fireEvent.keyDown(side, { key: 'ArrowLeft', shiftKey: true });
    expect(side.getAttribute('aria-valuenow')).toBe('520');
    fireEvent.keyDown(side, { key: 'End' });
    expect(side.getAttribute('aria-valuenow')).toBe('536');
    fireEvent.keyDown(side, { key: 'ArrowLeft' });
    expect(side.getAttribute('aria-valuenow')).toBe('536');
    fireEvent.keyDown(side, { key: 'Home' });
    expect(side.getAttribute('aria-valuenow')).toBe('320');
    fireEvent.keyDown(side, { key: 'ArrowRight' });
    expect(side.getAttribute('aria-valuenow')).toBe('320');
    fireEvent.keyDown(side, { key: 'Enter' });
    expect(side.getAttribute('aria-valuenow')).toBe('440');
    fireEvent.keyDown(side, { key: 'ArrowRight' });
    fireEvent.doubleClick(side);
    expect(side.getAttribute('aria-valuenow')).toBe('440');
    // Each step is the session's memory.
    fireEvent.keyDown(side, { key: 'ArrowLeft' });
    expect(remembered('~')?.sideWidth).toBe(456);

    // A drag drafts and commits once on release, clamped.
    fireEvent.pointerDown(side, {
      button: 0,
      pointerId: 1,
      clientX: 600,
      clientY: 10,
    });
    fireEvent.pointerMove(side, { pointerId: 1, clientX: 100, clientY: 10 });
    expect(side.getAttribute('aria-valuenow')).toBe('536');
    fireEvent.pointerUp(side, { pointerId: 1, clientX: 100, clientY: 10 });
    expect(remembered('~')?.sideWidth).toBe(536);

    fireEvent.click(railItem('Terminal'));
    await act(async () => undefined);
    const lower = screen.getByRole('separator', {
      name: 'Resize Terminal panel',
    });
    expect(lower.getAttribute('aria-valuemin')).toBe('160');
    // jsdom's 768px viewport: 768 - 8 - 240.
    expect(lower.getAttribute('aria-valuemax')).toBe('520');
    expect(lower.getAttribute('aria-valuenow')).toBe('280');
    fireEvent.keyDown(lower, { key: 'ArrowUp' });
    expect(lower.getAttribute('aria-valuenow')).toBe('296');
    expect(pages.style.getPropertyValue('--coding-lower-height')).toBe('296px');
    fireEvent.keyDown(lower, { key: 'ArrowLeft' });
    expect(lower.getAttribute('aria-valuenow')).toBe('296');
    expect(remembered('~')?.terminalHeight).toBe(296);
  });

  test('each session keeps its own panels: switching restores them, a new session starts closed, and the memory is the device setting on disk', async () => {
    navigationStore.navigate(ROUTE, { chat: 'conv-a' });
    const view = renderStack({ wide: true, terminal });
    const index = navigationStore.getHistoryIndex();
    await drillInto('Diff');
    fireEvent.click(railItem('Terminal'));
    await act(async () => undefined);
    expect(remembered('conv-a')).toMatchObject({
      side: diff.instanceId,
      terminalOpen: true,
    });

    // A new session (the inbox's replace): closed.
    act(() => navigationStore.setActiveChat('conv-b'));
    await act(async () => undefined);
    expect(urlPane()).toBeNull();
    expect(sidePanel().getAttribute('data-active')).toBe('false');
    expect(lowerPanel()?.getAttribute('data-active')).toBe('false');
    expect(navigationStore.getHistoryIndex()).toBe(index);
    await drillInto('Files');

    // Back to the first: its own panels, still not a history entry.
    act(() => navigationStore.setActiveChat('conv-a'));
    await act(async () => undefined);
    expect(urlPane()).toBe(diff.instanceId);
    expect(railItem('Diff').getAttribute('aria-pressed')).toBe('true');
    expect(lowerPanel()?.getAttribute('data-active')).toBe('true');
    expect(navigationStore.getHistoryIndex()).toBe(index);
    expect(remembered('conv-b')?.side).toBe(files.instanceId);

    // The memory is in the device-settings envelope, which a reload reads.
    const envelope = JSON.parse(
      window.localStorage.getItem('station-device-settings-v1') ?? '{}',
    );
    expect(envelope.values.codingPanels.sessions['conv-a']).toMatchObject({
      side: diff.instanceId,
      terminalOpen: true,
    });

    // A fresh arrival on the session with nothing in the URL restores it.
    view.unmount();
    navigationStore.navigate(ROUTE, {
      chat: 'conv-a',
      pane: null,
      paneScope: null,
    });
    renderStack({ wide: true, terminal });
    await act(async () => undefined);
    expect(urlPane()).toBe(diff.instanceId);
    expect(sidePanel().getAttribute('data-active')).toBe('true');
    expect(lowerPanel()?.getAttribute('data-active')).toBe('true');
  });

  test('opened from the keyboard, focus lands in the panel; closed, it returns to the rail item; a pointer leaves focus alone', async () => {
    renderStack({ wide: true, terminal });
    // A keyboard activation is a click with detail 0.
    fireEvent.click(railItem('Diff'), { detail: 0 });
    await act(async () => undefined);
    expect(window.document.activeElement).toBe(
      within(sidePanel()).getByRole('heading', { name: 'Diff' }),
    );
    fireEvent.click(
      within(sidePanel()).getByRole('button', { name: 'Close Diff' }),
      { detail: 0 },
    );
    await act(async () => undefined);
    expect(window.document.activeElement).toBe(railItem('Diff'));
    expect(sidePanel().getAttribute('data-active')).toBe('false');

    (window.document.activeElement as HTMLElement | null)?.blur();
    fireEvent.click(railItem('Files'), { detail: 1 });
    await act(async () => undefined);
    expect(sidePanel().getAttribute('data-active')).toBe('true');
    expect(window.document.activeElement).toBe(window.document.body);

    // The lower panel, the same way.
    fireEvent.click(railItem('Terminal'), { detail: 0 });
    await act(async () => undefined);
    expect(window.document.activeElement).toBe(
      within(lowerPanel()!).getByRole('heading', { name: 'Terminal' }),
    );
    fireEvent.click(railItem('Terminal'), { detail: 0 });
    await act(async () => undefined);
    expect(window.document.activeElement).toBe(railItem('Terminal'));
  });

  test('crossing the fold keeps Chat the one mounted instance', async () => {
    const view = renderStack({ wide: false });
    await drillInto('Diff');
    expect(chatPage().getAttribute('data-active')).toBe('false');
    const mounts = harness.chatMounts;

    view.rerender(
      <NavigationProvider>
        <Stack wide />
      </NavigationProvider>,
    );
    await act(async () => undefined);
    expect(chatPage().getAttribute('data-active')).toBe('true');
    expect(sidePanel().getAttribute('data-active')).toBe('true');
    expect(harness.chatMounts).toBe(mounts);

    view.rerender(
      <NavigationProvider>
        <Stack wide={false} />
      </NavigationProvider>,
    );
    await act(async () => undefined);
    expect(chatPage().getAttribute('data-active')).toBe('false');
    expect(crumbs()).toEqual(['Inbox', harness.chatTitle, 'Diff']);
    expect(harness.chatMounts).toBe(mounts);
  });
});
