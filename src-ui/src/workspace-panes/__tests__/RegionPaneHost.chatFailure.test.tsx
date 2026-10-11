/** @vitest-environment jsdom */

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { useSyncExternalStore } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { RegionShells } from '../../app-shell/RegionShells';
import { ambientChatPaneFailureContext } from '../../components/chat-dock/chatPaneFailureContext';
import { activeChatsStore } from '../../contexts/active-chats-store';
import { navigationStore } from '../../contexts/navigation-store';
import { RegionModelProvider } from '../../contexts/RegionModelContext';
import { RegionPaneHost } from '../RegionPaneHost';

/**
 * A Chat pane whose renderer throws, through the production dock host
 * (`RegionPaneHost` → `WorkspacePaneHost` dock presentation →
 * `WorkspacePaneFrame`'s boundary → the controller's failure state) and the
 * production Chat failure context (`ambientChatPaneFailureContext`, reading
 * the real navigation and active-chats stores).
 *
 * The phone showed "Chat could not open." flush against the screen edge with
 * a bare "Retry pane" button: no conversation, no reason, no details, and no
 * way out when the crash is specific to the open conversation — the URL's
 * `chat` parameter reopens that same conversation on every retry.
 */

vi.mock('../../contexts/DeviceSettingsContext', () => ({
  useDeviceSettings: () => ({ chatDockHeight: 320, chatDockWidth: 400 }),
  useDeviceSettingsActions: () => ({ setDeviceSetting: () => {} }),
}));

// `DockShell`'s own chrome reads this hook; the failure context deliberately
// reads the navigation STORE instead, which stays real here.
vi.mock('../../contexts/NavigationContext', () => ({
  useNavigation: () => ({
    dockMode: 'bottom',
    isDockOpen: true,
    isDockMaximized: false,
    pathname: '/',
    setDockState: () => {},
    setDockMode: () => {},
    collapseMaximizedDock: () => {},
  }),
}));

vi.mock('../../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://test.local' }),
  useHostRequestAuthorityScope: () => null,
}));

vi.mock('../../contexts/ProjectsContext', () => ({
  useProjects: () => ({
    projects: [],
    isLoading: false,
    isConfirmedLoaded: true,
  }),
  useProject: () => ({ project: undefined, isLoading: false }),
}));

vi.mock('../../hooks/useKeyboardShortcut', () => ({
  useKeyboardShortcut: () => {},
  useShortcutDisplay: () => '',
}));

vi.mock('../../components/chat-dock/ChatDock', () => ({
  ChatDock: () => null,
  renderAmbientChatPane: () => <ConversationSpecificCrash />,
}));

const STORE_KEY = 'chat-failure-store-key';
const CONVERSATION_ID = 'conversation-that-crashes';
const TITLE = 'Are you running the latest version? Run ls -la';
const CRASH = "Cannot read properties of undefined (reading 'capabilities')";

/** Throws while its conversation is the open one, like a conversation-specific crash. */
function ConversationSpecificCrash() {
  const activeChat = useSyncExternalStore(
    navigationStore.subscribe,
    () => navigationStore.getSnapshot().activeChat,
  );
  if (activeChat === CONVERSATION_ID) {
    throw new TypeError(CRASH);
  }
  return <p data-testid="chat-list">Your chats</p>;
}

beforeEach(() => {
  Object.defineProperty(globalThis.navigator, 'locks', {
    configurable: true,
    value: {
      request: async (
        _name: string,
        _options: unknown,
        callback: (lock: object | null) => void | Promise<void>,
      ) => callback({}),
    },
  });
  window.localStorage.clear();
  // React reports every caught render error to the console; the failure is
  // the subject here, so keep the run readable.
  vi.spyOn(console, 'error').mockImplementation(() => {});
  activeChatsStore.removeChat(STORE_KEY);
  activeChatsStore.initChat(STORE_KEY, {
    agentSlug: 'opencode',
    agentName: 'OpenCode',
    title: TITLE,
    conversationId: CONVERSATION_ID,
  });
  navigationStore.setActiveChat(CONVERSATION_ID);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  activeChatsStore.removeChat(STORE_KEY);
  navigationStore.setActiveChat(null);
  window.localStorage.clear();
  delete (globalThis.navigator as { locks?: unknown }).locks;
});

test('deferred Chat renderer failures keep the region pane recovery actions', async () => {
  navigationStore.setActiveChat(null);
  render(
    <RegionModelProvider>
      <RegionShells />
    </RegionModelProvider>,
  );
  await act(async () => {
    await vi.dynamicImportSettled();
  });
  await screen.findByTestId('chat-list');
  act(() => navigationStore.setActiveChat(CONVERSATION_ID));
  const failure = await screen.findByRole('region', {
    name: 'Chat unavailable',
  });
  expect(within(failure).getByText(TITLE)).toBeTruthy();
  expect(
    within(failure).getByRole('button', { name: 'Close this chat' }),
  ).toBeTruthy();
  expect(
    within(failure).getByRole('button', { name: 'Minimize' }),
  ).toBeTruthy();
  fireEvent.click(
    within(failure).getByRole('button', { name: 'Close this chat' }),
  );
  await screen.findByTestId('chat-list');
});

test('a crashed Chat pane names the conversation, shows the error, and goes back to the chat list', async () => {
  navigationStore.setActiveChat(null);
  render(
    <RegionPaneHost
      renderChatPane={() => <ConversationSpecificCrash />}
      chatPaneFailureContext={ambientChatPaneFailureContext}
    />,
  );
  // Let the host hydrate (it persists its document once it holds the lease)
  // before the crash, as on a phone that reopens a conversation into a
  // running dock: the failure is then the HOST's record, not only the
  // frame boundary's.
  await screen.findByTestId('chat-list');
  await waitFor(() => {
    expect(
      Object.keys(window.localStorage).some((key) =>
        key.startsWith('station:workspace-pane-host:'),
      ),
    ).toBe(true);
  });
  act(() => navigationStore.setActiveChat(CONVERSATION_ID));

  const failure = await screen.findByRole('region', {
    name: 'Chat unavailable',
  });
  expect(failure.className).toContain(
    'workspace-pane-host--chromeless-failure',
  );
  // The failure is the heading; what failed is secondary to it.
  expect(
    within(failure).getByRole('heading', { name: 'Chat couldn’t open' }),
  ).toBeTruthy();
  // Which conversation failed, not just which pane, labelled as the chat.
  const name = within(failure).getByText(TITLE);
  expect(name.className).toBe('workspace-pane-failure__subject-name');
  expect(
    name.previousElementSibling?.textContent,
    'the name is labelled as the chat',
  ).toBe('Chat');
  // The raw details sit inside the failure card, under its actions.
  expect(
    within(failure)
      .getByRole('button', { name: 'Try again' })
      .closest('.workspace-pane-failure__card')
      ?.querySelector('details'),
  ).not.toBeNull();
  // The error the boundary caught, kept behind a disclosure rather than
  // discarded.
  const details = within(failure)
    .getByText('Technical details')
    .closest('details');
  expect(details, 'raw details sit behind a disclosure').not.toBeNull();
  expect(details?.open).toBe(false);
  expect(details?.textContent).toContain(`TypeError: ${CRASH}`);
  // Frames keep file names, never the machine's paths or origins.
  expect(details?.textContent).not.toMatch(/\/(?:Users|home|private)\//);
  expect(details?.textContent).not.toMatch(/[a-z]+:\/\//);

  // A plain retry reopens the same conversation and fails again.
  fireEvent.click(within(failure).getByRole('button', { name: 'Try again' }));
  expect(
    await screen.findByRole('region', { name: 'Chat unavailable' }),
  ).toBeTruthy();
  expect(screen.queryByTestId('chat-list')).toBeNull();

  // Close clears the open conversation and remounts the pane without it.
  fireEvent.click(screen.getByRole('button', { name: 'Close this chat' }));
  await waitFor(() => {
    expect(screen.queryByTestId('chat-list')).not.toBeNull();
  });
  expect(navigationStore.getSnapshot().activeChat).toBeNull();
  expect(screen.queryByRole('region', { name: 'Chat unavailable' })).toBeNull();
});

test('with no conversation open the failure offers only the retry', async () => {
  navigationStore.setActiveChat(null);
  let crash = true;
  function CrashOnce() {
    if (crash) throw new Error('first render failed');
    return <p data-testid="recovered">Chat</p>;
  }
  render(
    <RegionPaneHost
      renderChatPane={() => <CrashOnce />}
      chatPaneFailureContext={ambientChatPaneFailureContext}
    />,
  );

  const failure = await screen.findByRole('region', {
    name: 'Chat unavailable',
  });
  expect(
    within(failure).queryByRole('button', { name: 'Close this chat' }),
  ).toBeNull();
  expect(within(failure).queryByText(TITLE)).toBeNull();

  crash = false;
  fireEvent.click(within(failure).getByRole('button', { name: 'Try again' }));
  await waitFor(() => {
    expect(screen.queryByTestId('recovered')).not.toBeNull();
  });
});

test('the failure keeps naming, and acting on, the chat that failed', async () => {
  const OTHER = 'another-conversation';
  render(
    <RegionPaneHost
      renderChatPane={() => <ConversationSpecificCrash />}
      chatPaneFailureContext={ambientChatPaneFailureContext}
    />,
  );
  const failure = await screen.findByRole('region', {
    name: 'Chat unavailable',
  });
  expect(within(failure).getByText(TITLE)).toBeTruthy();

  // Another chat is opened elsewhere while the failure is on screen.
  act(() => navigationStore.setActiveChat(OTHER));
  expect(
    within(screen.getByRole('region', { name: 'Chat unavailable' })).getByText(
      TITLE,
    ),
    'the failure is not relabelled by a later selection',
  ).toBeTruthy();

  // Close only ever closes the failed chat: the newer selection survives,
  // and the pane remounts on it.
  fireEvent.click(screen.getByRole('button', { name: 'Close this chat' }));
  await waitFor(() => {
    expect(screen.queryByTestId('chat-list')).not.toBeNull();
  });
  expect(navigationStore.getSnapshot().activeChat).toBe(OTHER);
});

test('the failure can minimize the dock its header would have collapsed', async () => {
  navigationStore.setDockState(true, true);
  render(
    <RegionPaneHost
      renderChatPane={() => <ConversationSpecificCrash />}
      chatPaneFailureContext={ambientChatPaneFailureContext}
    />,
  );
  await screen.findByRole('region', { name: 'Chat unavailable' });
  fireEvent.click(screen.getByRole('button', { name: 'Minimize' }));
  expect(new URL(window.location.href).searchParams.get('dock')).toBeNull();
  expect(new URL(window.location.href).searchParams.get('maximize')).toBeNull();
});
