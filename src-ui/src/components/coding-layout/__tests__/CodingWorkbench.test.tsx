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
import { createPortal } from 'react-dom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { requestCenterChatPage } from '../../../app-shell/chat-placement';
import { NavigationProvider } from '../../../contexts/NavigationContext';
import { navigationStore } from '../../../contexts/navigation-store';
import { writeCodingSessionPanels } from '../../../lib/coding-panels-record';
import { deviceSettingsStore } from '../../../lib/device-settings-store';
import { createFilePreviewPaneInstance } from '../../../workspace-panes/filePreviewPaneInstance';
import { usePaneHeadSlots } from '../../../workspace-panes/PaneHeadSlots';
import { useRegionChromeSlots } from '../../../workspace-panes/RegionChromeSlots';
import type { WorkspacePaneHostOpenAction } from '../../../workspace-panes/WorkspacePaneHostOpenContext';
import { workspacePaneHostScopeKey } from '../../../workspace-panes/workspacePaneHostNavigation';
import { WORKSPACE_PANE_OPENED } from '../../../workspace-panes/workspacePaneHostOpenOutcome';
import { ActionOverflowMenu } from '../../ActionOverflowMenu';
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
  /** The bar slots the workbench hands Chat's toolbar (#3046). */
  chatSlots: null as null | {
    leading: HTMLElement | null;
    trailing: HTMLElement | null;
    namesPane?: boolean;
  },
  /** What the inbox's "Needs you" lane holds, as Chat would publish it. */
  needsYou: 0,
  /** How many times Chat has rendered: geometry must not render it. */
  chatRenders: 0,
}));

// Station's one Chat controller is its own subject; here it is the page's
// occupant, with the composer textarea the stack focuses on request.
vi.mock('../../chat-dock/ChatDock', () => ({
  ChatWorkspacePane: (props: {
    onPresentationTitleChange?: (title: string) => void;
    onInboxNeedsYouChange?: (count: number) => void;
  }) => {
    const { onPresentationTitleChange, onInboxNeedsYouChange } = props;
    harness.chatProps = props;
    harness.chatRenders += 1;
    const slots = useRegionChromeSlots();
    harness.chatSlots = slots;
    useEffect(() => {
      harness.chatMounts += 1;
    }, []);
    useEffect(() => {
      onInboxNeedsYouChange?.(harness.needsYou);
    }, [onInboxNeedsYouChange]);
    useEffect(() => {
      onPresentationTitleChange?.(harness.chatTitle);
    }, [onPresentationTitleChange]);
    return (
      <div data-testid="center-chat">
        <div className="chat-input">
          <textarea aria-label="Message" />
        </div>
        <aside className="chat-dock-inbox">inbox</aside>
        {slots?.trailing
          ? createPortal(
              <button type="button" aria-label="New chat">
                <svg aria-hidden="true" />
              </button>,
              slots.trailing,
            )
          : null}
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
// The Browser launcher is its own subject; here it is the flyout's content.
vi.mock('../../../workspace-panes/BrowserPreviewPaneLauncher', () => ({
  BrowserPreviewPaneLauncher: () => (
    <form>
      <input aria-label="Address" />
    </form>
  ),
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
  /** Which panes the reader may remove (the host's close). */
  closable?: (instance: WorkspacePaneInstance) => boolean;
  /** The pane host's content; a stub when the test does not care. */
  children?: ReactNode;
}

function Stack({
  centerChat = true,
  hostOpen = null,
  wide = false,
  terminal,
  renderTerminal,
  closable,
  children,
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
      closable={closable}
    >
      {children ?? <div data-testid="pane-host">pane host</div>}
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
  harness.chatSlots = null;
  harness.needsYou = 0;
  harness.chatRenders = 0;
  harness.shortcuts.clear();
  harness.showSurface.mockReset();
  deviceSettingsStore.reset('codingPanels');
  deviceSettingsStore.reset('inboxOpen');
  navigationStore.navigate(ROUTE, {
    pane: null,
    paneScope: null,
    chat: null,
    dock: null,
    previewPath: null,
    previewLineStart: null,
    previewLineEnd: null,
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

  test('⌘[ and ⌘] are Back and Forward; Escape is the layout’s own, and the composer’s inside it', async () => {
    renderStack();
    expect(harness.shortcuts.get('codingStack.back')).toMatchObject({
      key: '[',
      modifiers: ['cmd'],
    });
    expect(harness.shortcuts.get('codingStack.forward')).toMatchObject({
      key: ']',
      modifiers: ['cmd'],
    });
    // One Escape, the stack's (the registry never offers Escape to a
    // shortcut while a field has focus, so the composer keeps its own).
    expect(
      [...harness.shortcuts.entries()].filter(
        ([, entry]) => entry.key === 'Escape',
      ),
    ).toEqual([
      ['codingStack.escape', expect.objectContaining({ modifiers: [] })],
    ]);

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
      within(
        screen.getByRole('menu', { name: 'More actions for Files' }),
      ).getByRole('menuitem', { name: 'Remove pane' }),
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

    // A drag drafts to the room's custom property, relative to the press,
    // and commits once on release, clamped.
    fireEvent.pointerDown(side, {
      button: 0,
      pointerId: 1,
      clientX: 600,
      clientY: 10,
    });
    fireEvent.pointerMove(side, { pointerId: 1, clientX: 100, clientY: 10 });
    expect(pages.style.getPropertyValue('--coding-side-width')).toBe('536px');
    expect(side.getAttribute('aria-valuenow')).toBe('456');
    fireEvent.pointerUp(side, { pointerId: 1, clientX: 100, clientY: 10 });
    expect(side.getAttribute('aria-valuenow')).toBe('536');
    expect(remembered('~')?.sideWidth).toBe(536);

    fireEvent.click(railItem('Terminal'));
    await act(async () => undefined);
    const lower = screen.getByRole('separator', {
      name: 'Resize Terminal panel',
    });
    expect(lower.getAttribute('aria-valuemin')).toBe('160');
    // jsdom's 768px viewport: 768 - 8 - 240.
    expect(lower.getAttribute('aria-valuemax')).toBe('520');
    // Three tenths of jsdom's 768px: 230.
    expect(lower.getAttribute('aria-valuenow')).toBe('230');
    fireEvent.keyDown(lower, { key: 'ArrowUp' });
    expect(lower.getAttribute('aria-valuenow')).toBe('246');
    expect(pages.style.getPropertyValue('--coding-lower-height')).toBe('246px');
    fireEvent.keyDown(lower, { key: 'ArrowLeft' });
    expect(lower.getAttribute('aria-valuenow')).toBe('246');
    expect(remembered('~')?.terminalHeight).toBe(246);
    fireEvent.keyDown(lower, { key: 'Enter' });
    expect(lower.getAttribute('aria-valuenow')).toBe('230');
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

describe('CodingWorkbench — one quiet bar, the inbox beside a tool, and names (#3046, #3047)', () => {
  test('the bar hands Chat its two slots and says it names the pane; a drill-in page offers none', async () => {
    const wideView = renderStack({ wide: true });
    expect(harness.chatSlots?.namesPane).toBe(true);
    const bar = window.document.querySelector('.coding-workbench__bar')!;
    // Chat's toolbar lands IN the bar, beside the breadcrumb, not in a
    // second row under it.
    const newChat = screen.getByRole('button', { name: 'New chat' });
    expect(bar.contains(newChat)).toBe(true);
    expect(newChat.textContent).toBe('');
    expect(
      bar.querySelectorAll('.coding-workbench__crumb-current'),
    ).toHaveLength(1);
    // The breadcrumb is the one title.
    expect(
      within(bar as HTMLElement).getAllByText(harness.chatTitle),
    ).toHaveLength(1);

    // On a drill-in page (below the fold) the bar is the pane's: no slot.
    wideView.unmount();
    renderStack({ wide: false });
    await drillInto('Diff');
    expect(harness.chatSlots?.leading).toBeNull();
    expect(harness.chatSlots?.trailing).toBeNull();
  });

  test('a tool that would crowd the transcript folds the inbox for its stay and unfolds it when the tool closes', async () => {
    // jsdom's 1024px room: 1068 - 44 - 8 - 440 - 245 (the inbox's own rule)
    // leaves the transcript 331, under its 640 floor.
    renderStack({ wide: true });
    expect(deviceSettingsStore.get('inboxOpen')).toBe(true);
    await drillInto('Diff');
    expect(deviceSettingsStore.get('inboxOpen')).toBe(false);
    // Folded by the layout, not chosen: the record names the layout, so a
    // reload knows whose fold it is, and never a choice.
    expect(remembered('~')?.inbox).toBe('layout');
    await drillInto('Files');
    expect(deviceSettingsStore.get('inboxOpen')).toBe(false);
    await drillInto('Files');
    expect(deviceSettingsStore.get('inboxOpen')).toBe(true);
    expect(remembered('~')?.inbox).toBeNull();
  });

  test('a room with space for both leaves the inbox alone', async () => {
    const width = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', {
      value: 2200,
      configurable: true,
      writable: true,
    });
    try {
      renderStack({ wide: true });
      await drillInto('Diff');
      expect(deviceSettingsStore.get('inboxOpen')).toBe(true);
    } finally {
      Object.defineProperty(window, 'innerWidth', {
        value: width,
        configurable: true,
        writable: true,
      });
    }
  });

  test('the reader’s own fold or unfold while a tool is open is their choice for the session, and is never overridden', async () => {
    navigationStore.navigate(ROUTE, { chat: 'conv-choice' });
    renderStack({ wide: true });
    await drillInto('Diff');
    expect(deviceSettingsStore.get('inboxOpen')).toBe(false);
    // The reader expands the chat list (the dock menu's own write).
    act(() => deviceSettingsStore.set('inboxOpen', true));
    await act(async () => undefined);
    expect(remembered('conv-choice')?.inbox).toBe(true);
    // Switching the tool does not fold it again; closing does not "restore".
    await drillInto('Files');
    expect(deviceSettingsStore.get('inboxOpen')).toBe(true);
    await drillInto('Files');
    expect(deviceSettingsStore.get('inboxOpen')).toBe(true);
    await drillInto('Diff');
    expect(deviceSettingsStore.get('inboxOpen')).toBe(true);
    // And the other way: folded by hand stays folded after the tool closes.
    act(() => deviceSettingsStore.set('inboxOpen', false));
    await act(async () => undefined);
    expect(remembered('conv-choice')?.inbox).toBe(false);
    await drillInto('Diff');
    expect(deviceSettingsStore.get('inboxOpen')).toBe(false);
  });

  test('a rail item is named by its label and tipped with what the label abbreviates', () => {
    render(
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
          paneDetail={(instance) =>
            instance.instanceId === files.instanceId ? 'src/app/files.ts' : null
          }
          badges={{ [diff.descriptorId]: 2 }}
          hostOpen={null}
          onOpenCatalog={vi.fn()}
        >
          <div />
        </CodingWorkbench>
      </NavigationProvider>,
    );
    // The tip is drawn on the body while the item is hovered or focused
    // (the rail scrolls, and would clip a tip of its own).
    const tip = (name: string) => {
      fireEvent.focusIn(railItem(name));
      const shown = screen.getByRole('tooltip');
      expect(shown.parentElement).toBe(window.document.body);
      const text = shown.textContent;
      fireEvent.focusOut(railItem(name));
      expect(screen.queryByRole('tooltip')).toBeNull();
      return text;
    };
    expect(tip('Files')).toBe('src/app/files.ts');
    expect(railItem('Files').getAttribute('aria-label')).toBe('Files');
    expect(tip('Diff, 2 changed files')).toBe('Diff, 2 changed files');
  });
});

describe('CodingWorkbench — the folded inbox’s edge, and the fold judged again on resize', () => {
  // Pointer-only (the bar's inbox toggle is the one accessible control), so
  // it is found by its test id, not by a role.
  const edge = () => screen.queryByTestId('coding-inbox-edge');
  const withViewportWidth = (width: number) =>
    Object.defineProperty(window, 'innerWidth', {
      value: width,
      configurable: true,
      writable: true,
    });

  test('a folded inbox leaves a strip on the Chat column’s edge, named, badged with the Needs-you count, and absent while the inbox is open', async () => {
    harness.needsYou = 2;
    renderStack({ wide: true });
    expect(edge()).toBeNull();
    await drillInto('Diff');
    expect(deviceSettingsStore.get('inboxOpen')).toBe(false);
    const strip = edge()!;
    // The count is in its tooltip; the name a screen reader hears is the
    // bar toggle's, so the strip itself is hidden from it.
    expect(strip.getAttribute('aria-hidden')).toBe('true');
    expect(chatPage().contains(strip)).toBe(true);
    expect(
      strip.querySelector('.coding-workbench__inbox-edge-count')?.textContent,
    ).toBe('2');
    expect(
      strip.parentElement?.querySelector('[role="tooltip"]')?.textContent,
    ).toBe('Show inbox, 2 need you');
    // A Needs-you count is what lifts the strip's rule to the accent.
    expect(
      strip.classList.contains('coding-workbench__inbox-edge--needs-you'),
    ).toBe(true);
  });

  test('with nothing needing the reader the strip’s rule stays neutral (no accent class)', async () => {
    harness.needsYou = 0;
    renderStack({ wide: true });
    await drillInto('Diff');
    const strip = edge()!;
    expect(
      strip.parentElement?.querySelector('[role="tooltip"]')?.textContent,
    ).toBe('Show inbox');
    expect(strip.classList.contains('coding-workbench__inbox-edge')).toBe(true);
    expect(
      strip.classList.contains('coding-workbench__inbox-edge--needs-you'),
    ).toBe(false);
  });

  test('the edge is a pointer-only shortcut, out of the tab order, whose click is the reader’s own choice', async () => {
    navigationStore.navigate(ROUTE, { chat: 'conv-edge' });
    renderStack({ wide: true });
    await drillInto('Diff');
    const strip = edge()!;
    expect(strip.tagName).toBe('BUTTON');
    // Not a second stop for a keyboard: the bar's toggle is that control.
    expect(strip.tabIndex).toBe(-1);
    expect(strip.getAttribute('aria-hidden')).toBe('true');
    // A click opens the inbox and is remembered as the reader's choice:
    // closing the tool does not fold it back.
    fireEvent.click(strip);
    await act(async () => undefined);
    expect(deviceSettingsStore.get('inboxOpen')).toBe(true);
    expect(edge()).toBeNull();
    expect(remembered('conv-edge')?.inbox).toBe(true);
    await drillInto('Files');
    expect(deviceSettingsStore.get('inboxOpen')).toBe(true);
  });

  test('below the fold, and on a coarse pointer, there is no edge', async () => {
    deviceSettingsStore.set('inboxOpen', false);
    renderStack({ wide: false });
    expect(edge()).toBeNull();
  });

  test('a window dragged narrower folds the inbox once it rests; widened again, it comes back; the reader’s choice is never fought', async () => {
    vi.useFakeTimers();
    const width = window.innerWidth;
    try {
      withViewportWidth(2200);
      renderStack({ wide: true });
      await drillInto('Diff');
      expect(deviceSettingsStore.get('inboxOpen')).toBe(true);

      withViewportWidth(1024);
      act(() => {
        window.dispatchEvent(new Event('resize'));
      });
      // Not yet: the room has to rest first.
      expect(deviceSettingsStore.get('inboxOpen')).toBe(true);
      act(() => {
        vi.advanceTimersByTime(200);
      });
      expect(deviceSettingsStore.get('inboxOpen')).toBe(false);

      withViewportWidth(2200);
      act(() => {
        window.dispatchEvent(new Event('resize'));
      });
      act(() => {
        vi.advanceTimersByTime(200);
      });
      expect(deviceSettingsStore.get('inboxOpen')).toBe(true);
      expect(remembered('~')?.inbox).toBeNull();

      // The reader folds it by hand: a wider window does not unfold it.
      act(() => deviceSettingsStore.set('inboxOpen', false));
      expect(remembered('~')?.inbox).toBe(false);
      withViewportWidth(2600);
      act(() => {
        window.dispatchEvent(new Event('resize'));
      });
      act(() => {
        vi.advanceTimersByTime(200);
      });
      expect(deviceSettingsStore.get('inboxOpen')).toBe(false);
      // And unfolds it by hand on a window too narrow for both: a narrower
      // window still does not fold it again.
      act(() => deviceSettingsStore.set('inboxOpen', true));
      expect(remembered('~')?.inbox).toBe(true);
      withViewportWidth(1024);
      act(() => {
        window.dispatchEvent(new Event('resize'));
      });
      act(() => {
        vi.advanceTimersByTime(200);
      });
      expect(deviceSettingsStore.get('inboxOpen')).toBe(true);
    } finally {
      withViewportWidth(width);
      vi.useRealTimers();
    }
  });
});

describe('CodingWorkbench — review round: file links, the fold’s owner, geometry out of Chat, the Terminal across the fold', () => {
  const linkIntent = () =>
    act(() =>
      navigationStore.setLayout('demo', 'coding', {
        openFilePreviewIntent: { projectSlug: 'demo', path: 'src/app.ts' },
      }),
    );

  test('a file link opens beside Chat whatever tool is there — Diff, Files, or nothing — and never twice', async () => {
    const open = vi.fn(() => WORKSPACE_PANE_OPENED);
    renderStack({ wide: true, hostOpen: { open } });
    // Nothing open.
    linkIntent();
    await act(async () => undefined);
    expect(open).toHaveBeenCalledTimes(1);
    expect(new URLSearchParams(window.location.search).has('previewPath')).toBe(
      false,
    );
    // Diff beside Chat.
    await drillInto('Diff');
    linkIntent();
    await act(async () => undefined);
    expect(open).toHaveBeenCalledTimes(2);
    // Files beside Chat: a link is not the pane's own row.
    await drillInto('Files');
    linkIntent();
    await act(async () => undefined);
    expect(open).toHaveBeenCalledTimes(3);
    // The Files pane's own row write is the pane's to open.
    act(() =>
      navigationStore.setLayout('demo', 'coding', {
        openFilePreviewIntent: { projectSlug: 'demo', path: 'src/own.ts' },
        from: 'pane',
      }),
    );
    await act(async () => undefined);
    expect(open).toHaveBeenCalledTimes(3);
    expect(new URLSearchParams(window.location.search).get('previewPath')).toBe(
      'src/own.ts',
    );
  });

  test('a link to a file whose preview is already open shows that preview instead of a second one', async () => {
    const open = vi.fn(() => WORKSPACE_PANE_OPENED);
    const preview: WorkspacePaneInstance = {
      ...files,
      instanceId: 'file-preview:abc' as WorkspacePaneInstance['instanceId'],
      stateKey: 'file-preview:abc' as WorkspacePaneInstance['stateKey'],
    };
    render(
      <NavigationProvider>
        <CodingWorkbench
          projectId="project-uuid"
          projectSlug="demo"
          centerChat
          wide
          location={{ page: 'drill-in', paneId: diff.instanceId }}
          scope={scope}
          instances={[...instances, preview]}
          hostDocument={() => document}
          paneLabel={(instance) =>
            instance.instanceId === preview.instanceId
              ? 'app.ts'
              : label(instance)
          }
          paneDetail={(instance) =>
            instance.instanceId === preview.instanceId ? 'src/app.ts' : null
          }
          hostOpen={{ open }}
          onOpenCatalog={vi.fn()}
        >
          <div />
        </CodingWorkbench>
      </NavigationProvider>,
    );
    const index = navigationStore.getHistoryIndex();
    linkIntent();
    await act(async () => undefined);
    expect(open).not.toHaveBeenCalled();
    expect(urlPane()).toBe(preview.instanceId);
    expect(navigationStore.getHistoryIndex()).toBe(index);
    expect(new URLSearchParams(window.location.search).has('previewPath')).toBe(
      false,
    );
  });

  test('a fold the layout made survives a remount: arriving on the tool and closing it unfolds the inbox', async () => {
    navigationStore.navigate(ROUTE, { chat: 'conv-fold' });
    const view = renderStack({ wide: true });
    await drillInto('Diff');
    expect(deviceSettingsStore.get('inboxOpen')).toBe(false);
    expect(remembered('conv-fold')?.inbox).toBe('layout');
    // The reload: a fresh mount on the same URL (`?pane=diff`), the device
    // setting still false and the record still naming the layout.
    view.unmount();
    renderStack({ wide: true });
    await act(async () => undefined);
    expect(deviceSettingsStore.get('inboxOpen')).toBe(false);
    await drillInto('Diff');
    expect(deviceSettingsStore.get('inboxOpen')).toBe(true);
    expect(remembered('conv-fold')?.inbox).toBeNull();
  });

  test('a fold the layout made is undone on a return that finds the tool closed', async () => {
    // Left the layout with the inbox folded for a tool, then the tool was
    // closed elsewhere (another tab, a stale record): the return unfolds.
    deviceSettingsStore.set('inboxOpen', false);
    deviceSettingsStore.set('codingPanels', {
      version: 1,
      sessions: {
        'conv-left': {
          side: null,
          sideWidth: null,
          terminalOpen: false,
          terminalHeight: null,
          inbox: 'layout',
          at: 1,
        },
      },
    });
    navigationStore.navigate(ROUTE, { chat: 'conv-left' });
    renderStack({ wide: true });
    await act(async () => undefined);
    expect(deviceSettingsStore.get('inboxOpen')).toBe(true);
    expect(remembered('conv-left')?.inbox).toBeNull();
  });

  test('the reader’s standing choice is applied when their session arrives or returns', async () => {
    deviceSettingsStore.set('codingPanels', {
      version: 1,
      sessions: {
        'conv-closed': {
          side: diff.instanceId,
          sideWidth: null,
          terminalOpen: false,
          terminalHeight: null,
          inbox: false,
          at: 1,
        },
        'conv-open': {
          side: diff.instanceId,
          sideWidth: null,
          terminalOpen: false,
          terminalHeight: null,
          inbox: true,
          at: 2,
        },
      },
    });
    navigationStore.navigate(ROUTE, { chat: 'conv-closed' });
    renderStack({ wide: true });
    await act(async () => undefined);
    expect(deviceSettingsStore.get('inboxOpen')).toBe(false);
    act(() => navigationStore.setActiveChat('conv-open'));
    await act(async () => undefined);
    expect(deviceSettingsStore.get('inboxOpen')).toBe(true);
    act(() => navigationStore.setActiveChat('conv-closed'));
    await act(async () => undefined);
    expect(deviceSettingsStore.get('inboxOpen')).toBe(false);
    // Applied by the layout, not recorded over: the choices stand as made.
    expect(remembered('conv-open')?.inbox).toBe(true);
    expect(remembered('conv-closed')?.inbox).toBe(false);
  });

  test('a separator drag of thirty moves and a window resize do not render Chat; a press that does not travel is not a resize', async () => {
    vi.useFakeTimers();
    try {
      renderStack({ wide: true, terminal });
      await drillInto('Diff');
      const pages = window.document.querySelector<HTMLElement>(
        '.coding-workbench__pages',
      )!;
      const side = screen.getByRole('separator', { name: 'Resize Diff panel' });
      const before = harness.chatRenders;
      fireEvent.pointerDown(side, {
        button: 0,
        pointerId: 1,
        clientX: 600,
        clientY: 10,
      });
      for (let step = 1; step <= 30; step += 1)
        fireEvent.pointerMove(side, {
          pointerId: 1,
          clientX: 600 - step * 2,
          clientY: 10,
        });
      // The frames went to the room's custom property, not through React.
      expect(pages.style.getPropertyValue('--coding-side-width')).toBe('500px');
      expect(side.getAttribute('aria-valuenow')).toBe('440');
      fireEvent.pointerUp(side, { pointerId: 1, clientX: 540, clientY: 10 });
      expect(side.getAttribute('aria-valuenow')).toBe('500');
      expect(remembered('~')?.sideWidth).toBe(500);
      expect(harness.chatRenders - before).toBeLessThanOrEqual(1);

      // A resize's ticks render the workbench, not Chat.
      const during = harness.chatRenders;
      for (let tick = 0; tick < 5; tick += 1) {
        Object.defineProperty(window, 'innerWidth', {
          value: 1600 + tick * 10,
          configurable: true,
          writable: true,
        });
        act(() => {
          window.dispatchEvent(new Event('resize'));
        });
      }
      act(() => {
        vi.advanceTimersByTime(200);
      });
      expect(harness.chatRenders).toBe(during);

      // A press and release without travel commits nothing.
      fireEvent.pointerDown(side, {
        button: 0,
        pointerId: 2,
        clientX: 300,
        clientY: 10,
      });
      fireEvent.pointerMove(side, { pointerId: 2, clientX: 301, clientY: 10 });
      fireEvent.pointerUp(side, { pointerId: 2, clientX: 301, clientY: 10 });
      expect(remembered('~')?.sideWidth).toBe(500);
      expect(side.getAttribute('aria-valuenow')).toBe('500');
    } finally {
      Object.defineProperty(window, 'innerWidth', {
        value: 1024,
        configurable: true,
        writable: true,
      });
      vi.useRealTimers();
    }
  });

  test('crossing to below the fold with the lower Terminal open makes the Terminal the page, in place', async () => {
    const view = renderStack({ wide: true, terminal });
    fireEvent.click(railItem('Terminal'));
    await act(async () => undefined);
    expect(lowerPanel()?.getAttribute('data-active')).toBe('true');
    const index = navigationStore.getHistoryIndex();
    view.rerender(
      <NavigationProvider>
        <Stack wide={false} terminal={terminal} />
      </NavigationProvider>,
    );
    await act(async () => undefined);
    expect(urlPane()).toBe(terminal.instanceId);
    expect(navigationStore.getHistoryIndex()).toBe(index);
    expect(crumbs()).toEqual(['Inbox', harness.chatTitle, 'Terminal']);
    // No lower panel below the fold: the host draws the Terminal there.
    expect(lowerPanel()).toBeNull();
  });
});

describe('CodingWorkbench — design audit round: the flyout, Escape, the way back, the rail', () => {
  const pressEscape = () =>
    harness.shortcuts.get('codingStack.escape')!.handler();

  test('Escape never leaves the layout: it closes the panel the reader is in, returns a drill-in to the conversation, and is consumed with nothing to close (U6/D5)', async () => {
    renderStack({ wide: true, terminal });
    // Nothing open: consumed, so the app's route-level "up" never fires.
    expect(pressEscape()).not.toBe(false);
    expect(window.location.pathname).toBe(ROUTE);

    fireEvent.click(railItem('Diff'), { detail: 0 });
    await act(async () => undefined);
    expect(window.document.activeElement).toBe(
      within(sidePanel()).getByRole('heading', { name: 'Diff' }),
    );
    expect(pressEscape()).not.toBe(false);
    await act(async () => undefined);
    expect(sidePanel().getAttribute('data-active')).toBe('false');
    expect(window.document.activeElement).toBe(railItem('Diff'));
    expect(window.location.pathname).toBe(ROUTE);

    // In the lower panel, with a side panel also open: the one the reader
    // is in closes, the other stays.
    await drillInto('Files');
    fireEvent.click(railItem('Terminal'), { detail: 0 });
    await act(async () => undefined);
    expect(window.document.activeElement).toBe(
      within(lowerPanel()!).getByRole('heading', { name: 'Terminal' }),
    );
    pressEscape();
    await act(async () => undefined);
    expect(lowerPanel()?.getAttribute('data-active')).toBe('false');
    expect(sidePanel().getAttribute('data-active')).toBe('true');
    expect(window.document.activeElement).toBe(railItem('Terminal'));
  });

  test('below the fold, Escape on a drill-in is the way back to the conversation', async () => {
    renderStack();
    await drillInto('Files');
    expect(drillInPage().getAttribute('data-active')).toBe('true');
    expect(pressEscape()).not.toBe(false);
    await historyBackSettled();
    expect(chatPage().getAttribute('data-active')).toBe('true');
    expect(window.location.pathname).toBe(ROUTE);
    // On the conversation with nothing to close: still the layout's.
    expect(pressEscape()).not.toBe(false);
  });

  test('the bar starts with a control that skips to the rail, which is last in the tab order', () => {
    renderStack({ wide: true });
    const bar = window.document.querySelector('.coding-workbench__bar')!;
    const skip = within(bar as HTMLElement).getByRole('button', {
      name: 'Skip to views',
    });
    expect(bar.querySelector('button')).toBe(skip);
    const railNode = rail();
    expect(
      bar.compareDocumentPosition(railNode) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      sidePanel().compareDocumentPosition(railNode) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    fireEvent.click(skip);
    expect(window.document.activeElement).toBe(
      within(railNode).getAllByRole('button')[0],
    );
    expect(window.document.activeElement?.getAttribute('data-rail-item')).toBe(
      diff.instanceId,
    );
  });

  test('the Browser flyout renders on the body, fixed beside its trigger, not inside the scrolling rail (D1)', async () => {
    render(
      <NavigationProvider>
        <CodingWorkbench
          projectId="project-uuid"
          projectSlug="demo"
          centerChat
          wide
          location={{ page: 'chat', paneId: null }}
          scope={scope}
          instances={instances}
          hostDocument={() => document}
          paneLabel={label}
          hostOpen={{ open: vi.fn(() => WORKSPACE_PANE_OPENED) }}
          onOpenCatalog={vi.fn()}
          browserPreviewAvailability={{
            state: 'available',
            reason: { code: 'ready', source: 'resolver' },
          }}
        >
          <div />
        </CodingWorkbench>
      </NavigationProvider>,
    );
    const trigger = within(rail()).getByRole('button', {
      name: 'Open Browser pane',
    });
    expect(screen.queryByRole('region', { name: 'Browser' })).toBeNull();
    // A pointer click focuses the button it lands on; jsdom's does not.
    trigger.focus();
    fireEvent.click(trigger);
    await act(async () => undefined);
    const flyout = screen.getByRole('region', { name: 'Browser' });
    expect(rail().contains(flyout)).toBe(false);
    expect(flyout.parentElement).toBe(window.document.body);
    expect(flyout.style.position).toBe('fixed');
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(trigger.getAttribute('aria-controls')).toBe(flyout.id);
    // Focus moves into it; Escape closes it and returns to the trigger.
    expect(window.document.activeElement).toBe(
      within(flyout).getByRole('textbox', { name: 'Address' }),
    );
    fireEvent.keyDown(flyout, { key: 'Escape' });
    await act(async () => undefined);
    expect(screen.queryByRole('region', { name: 'Browser' })).toBeNull();
    expect(window.document.activeElement).toBe(trigger);
  });

  test('a File Preview beside Chat offers the way back to Files in its head; other panels do not (U5)', async () => {
    const preview = createFilePreviewPaneInstance(
      { version: '1.0', projectSlug: 'demo', path: 'src/app.ts', wrap: true },
      'project-uuid',
      'c'.repeat(32),
    )!;
    const held = [files, diff, preview];
    const name = (instance: WorkspacePaneInstance) =>
      instance.instanceId === preview.instanceId ? 'app.ts' : label(instance);
    const Subject = ({ wide }: { wide: boolean }) => {
      const selection = useCodingStackSelection();
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
          centerChat
          wide={wide}
          location={location}
          scope={scope}
          instances={held}
          hostDocument={() => document}
          paneLabel={name}
          hostOpen={null}
          onOpenCatalog={vi.fn()}
        >
          <div />
        </CodingWorkbench>
      );
    };
    render(
      <NavigationProvider>
        <Subject wide />
      </NavigationProvider>,
    );
    fireEvent.click(railItem('app.ts'));
    await act(async () => undefined);
    expect(
      within(sidePanel()).getByRole('heading', { name: 'app.ts' }),
    ).toBeTruthy();
    const back = within(sidePanel()).getByRole('button', {
      name: 'Back to Files',
    });
    fireEvent.click(back, { detail: 0 });
    await act(async () => undefined);
    expect(
      within(sidePanel()).getByRole('heading', { name: 'Files' }),
    ).toBeTruthy();
    expect(
      within(sidePanel()).queryByRole('button', { name: /^Back to/ }),
    ).toBeNull();
    expect(railItem('Files').getAttribute('aria-pressed')).toBe('true');
  });
});

describe('CodingWorkbench — delta review: one ⋯ per head, Escape’s reach, the fold through an arrival', () => {
  const pressEscape = () =>
    harness.shortcuts.get('codingStack.escape')!.handler();

  /** A pane with an overflow of its own, as File Preview has. */
  function PaneWithOverflow() {
    const slots = usePaneHeadSlots();
    const take = slots?.takeHostActions;
    useEffect(() => {
      if (!take) return;
      take(true);
      return () => take(false);
    }, [take]);
    if (!slots?.trailing) return null;
    return createPortal(
      <ActionOverflowMenu
        label="More file actions"
        actions={[
          { key: 'own', label: 'Copy path', onSelect: () => undefined },
          ...(slots.hostActions ?? []),
        ]}
      />,
      slots.trailing,
    );
  }

  test('a closable pane with its own overflow beside Chat has one ⋯ in the head, carrying the host’s Remove pane; a pane without one gets the host’s ⋯', async () => {
    const close = vi.fn(async () => undefined);
    const view = renderStack({
      wide: true,
      hostOpen: { open: vi.fn(() => WORKSPACE_PANE_OPENED), close },
      closable: (instance) => instance.instanceId === files.instanceId,
      children: <PaneWithOverflow />,
    });
    await drillInto('Files');
    const head = sidePanel().querySelector('.coding-workbench__panel-head')!;
    const triggers = within(head as HTMLElement).getAllByRole('button', {
      name: /More/,
    });
    expect(triggers.map((button) => button.getAttribute('aria-label'))).toEqual(
      ['More file actions'],
    );
    expect(
      head.querySelectorAll('[aria-haspopup="menu"], .action-overflow__trigger')
        .length,
    ).toBe(1);
    fireEvent.click(triggers[0]!);
    const menu = screen.getByRole('menu', { name: 'More file actions' });
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent?.trim()),
    ).toEqual(['Copy path', 'Remove pane']);
    fireEvent.click(
      within(menu).getByRole('menuitem', { name: 'Remove pane' }),
    );
    expect(close).toHaveBeenCalledWith(files.instanceId);
    // The × is still the panel's own: it hides, it does not remove.
    expect(
      within(sidePanel()).getByRole('button', { name: 'Close Files' }),
    ).toBeTruthy();

    // A pane that draws no overflow: the head offers the host's rows itself.
    view.rerender(
      <NavigationProvider>
        <Stack
          wide
          hostOpen={{ open: vi.fn(() => WORKSPACE_PANE_OPENED), close }}
          closable={(instance) => instance.instanceId === files.instanceId}
        >
          <div data-testid="pane-host">pane host</div>
        </Stack>
      </NavigationProvider>,
    );
    await act(async () => undefined);
    expect(
      within(sidePanel()).getByRole('button', {
        name: 'More actions for Files',
      }),
    ).toBeTruthy();
  });

  test('Escape acts only from inside the open panel or on its rail item: from the composer, the bar or another rail item it is consumed and nothing closes', async () => {
    renderStack({ wide: true, terminal });
    fireEvent.click(railItem('Diff'), { detail: 1 });
    await act(async () => undefined);
    expect(sidePanel().getAttribute('data-active')).toBe('true');

    screen.getByRole('textbox', { name: 'Message' }).focus();
    expect(pressEscape()).not.toBe(false);
    await act(async () => undefined);
    expect(sidePanel().getAttribute('data-active')).toBe('true');

    screen.getByRole('button', { name: 'Skip to views' }).focus();
    expect(pressEscape()).not.toBe(false);
    await act(async () => undefined);
    expect(sidePanel().getAttribute('data-active')).toBe('true');

    railItem('Files').focus();
    expect(pressEscape()).not.toBe(false);
    await act(async () => undefined);
    expect(sidePanel().getAttribute('data-active')).toBe('true');

    railItem('Diff').focus();
    expect(pressEscape()).not.toBe(false);
    await act(async () => undefined);
    expect(sidePanel().getAttribute('data-active')).toBe('false');

    // The lower panel likewise: its own rail item closes it, the side's
    // does not touch it.
    fireEvent.click(railItem('Terminal'), { detail: 1 });
    await act(async () => undefined);
    railItem('Files').focus();
    pressEscape();
    await act(async () => undefined);
    expect(lowerPanel()?.getAttribute('data-active')).toBe('true');
    railItem('Terminal').focus();
    pressEscape();
    await act(async () => undefined);
    expect(lowerPanel()?.getAttribute('data-active')).toBe('false');
  });

  test('a session arriving with a remembered tool and the layout’s fold keeps the fold: no unfold-and-refold, no inbox write', async () => {
    deviceSettingsStore.set('inboxOpen', false);
    deviceSettingsStore.set(
      'codingPanels',
      writeCodingSessionPanels(
        deviceSettingsStore.get('codingPanels'),
        '~',
        { side: diff.instanceId, inbox: 'layout' },
        Date.now(),
      ),
    );
    const writes: unknown[] = [];
    const set = deviceSettingsStore.set.bind(deviceSettingsStore);
    const spy = vi
      .spyOn(deviceSettingsStore, 'set')
      .mockImplementation((key, value) => {
        if (key === 'inboxOpen') writes.push(value);
        return set(key, value);
      });
    try {
      renderStack({ wide: true });
      await act(async () => undefined);
      await act(async () => {
        await vi.waitFor(() =>
          expect(sidePanel().getAttribute('data-active')).toBe('true'),
        );
      });
      expect(writes).toEqual([]);
      expect(deviceSettingsStore.get('inboxOpen')).toBe(false);
      expect(remembered('~')?.inbox).toBe('layout');
      // Closing the tool is still the unfold.
      await drillInto('Diff');
      expect(deviceSettingsStore.get('inboxOpen')).toBe(true);
      expect(writes).toEqual([true]);
    } finally {
      spy.mockRestore();
    }
  });
});
