/** @vitest-environment jsdom */

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  ActiveChatsProvider,
  activeChatsStore,
} from '../../../contexts/ActiveChatsContext';
import { chatDraftsStore } from '../../../contexts/chat-drafts-store';
import {
  NavigationProvider,
  navigationStore,
} from '../../../contexts/NavigationContext';
import { TerminalPanel } from '../TerminalPanel';

const { fetchTerminalPort, credentialProvider } = vi.hoisted(() => ({
  fetchTerminalPort: vi.fn(),
  credentialProvider: { getCredential: () => null },
}));

vi.mock('@kontourai/station-sdk', () => ({
  executeCodingCommand: vi.fn(),
  fetchTerminalPort,
}));
vi.mock('../../../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({
    apiBase: 'http://localhost',
    credentialProvider,
  }),
}));
vi.mock('../../../hooks/useIsMobile', () => ({ useIsMobile: () => false }));

const { FakeFitAddon, FakeTerminal } = vi.hoisted(() => {
  class FakeTerminal {
    static instances: FakeTerminal[] = [];
    cols = 80;
    rows = 24;
    selection = '';
    selectionListener: (() => void) | null = null;
    loadAddon = vi.fn();
    open = vi.fn();
    write = vi.fn();
    dispose = vi.fn();
    focus = vi.fn();
    onData = vi.fn(() => ({ dispose: vi.fn() }));
    onSelectionChange = vi.fn((listener: () => void) => {
      this.selectionListener = listener;
      return { dispose: vi.fn() };
    });
    hasSelection = vi.fn(() => Boolean(this.selection));
    getSelection = vi.fn(() => this.selection);

    constructor() {
      FakeTerminal.instances.push(this);
    }

    select(text: string) {
      this.selection = text;
      this.selectionListener?.();
    }
  }

  class FakeFitAddon {
    fit = vi.fn();
  }

  return { FakeTerminal, FakeFitAddon };
});

vi.mock('@xterm/xterm', () => ({ Terminal: FakeTerminal }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: FakeFitAddon }));

class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readonly send = vi.fn((raw: string) => {
    const message = JSON.parse(raw);
    if (message.type !== 'cwd') return;
    queueMicrotask(() => {
      this.onmessage?.({
        data: JSON.stringify({
          type: 'cwd',
          requestId: message.requestId,
          cwd: FakeWebSocket.liveCwd,
        }),
      } as MessageEvent);
    });
  });
  readonly close = vi.fn(() => {
    this.readyState = 3;
    this.onclose?.({ code: 1000 } as CloseEvent);
  });
  readyState = FakeWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  static liveCwd = '/workspace/live';

  constructor(_url: string) {
    FakeWebSocket.instances.push(this);
  }
}

class FakeResizeObserver {
  observe = vi.fn();
  disconnect = vi.fn();
}

beforeEach(() => {
  fetchTerminalPort.mockResolvedValue(4310);
  FakeWebSocket.instances = [];
  FakeWebSocket.liveCwd = '/workspace/live';
  FakeTerminal.instances = [];
  activeChatsStore.removeChat('chat-a');
  chatDraftsStore.clear('chat-a');
  activeChatsStore.initChat('chat-a');
  navigationStore.setActiveChat('chat-a');
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
});

afterEach(() => {
  cleanup();
  activeChatsStore.removeChat('chat-a');
  chatDraftsStore.clear('chat-a');
  navigationStore.setActiveChat(null);
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function renderTerminal() {
  return render(
    <NavigationProvider>
      <ActiveChatsProvider>
        <TerminalPanel
          projectSlug="project-a"
          workingDir="/workspace"
          terminalId="terminal-one"
        />
      </ActiveChatsProvider>
    </NavigationProvider>,
  );
}

async function connectTerminal() {
  await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
  const socket = FakeWebSocket.instances[0]!;
  socket.onopen?.();
  socket.onmessage?.({
    data: JSON.stringify({
      type: 'snapshot',
      sessionId: 'project-a:terminal-one',
      history: '',
    }),
  } as MessageEvent);
  return { socket, terminal: FakeTerminal.instances[0]! };
}

test('renderer unmount detaches its WebSocket without sending a terminal close command', async () => {
  const rendered = renderTerminal();

  const { socket } = await connectTerminal();

  rendered.unmount();

  expect(socket.close).toHaveBeenCalledTimes(1);
  expect(
    socket.send.mock.calls.map(([message]) => JSON.parse(message as string)),
  ).not.toContainEqual(
    expect.objectContaining({
      type: 'close',
      sessionId: 'project-a:terminal-one',
    }),
  );
});

test('scans one selection spanning two PTY reads without redacting the live terminal', async () => {
  renderTerminal();
  const { terminal } = await connectTerminal();
  const credential = ['ghp_', 'a'.repeat(36)].join('');
  const firstRead = `token=${credential.slice(0, 12)}`;
  const secondRead = credential.slice(12);

  terminal.write(firstRead);
  terminal.write(secondRead);
  await act(() => terminal.select(`${firstRead}${secondRead}`));

  expect(screen.getByRole('button', { name: 'Send to chat' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Send to chat' }));

  expect((await screen.findByRole('alert')).textContent).toContain(
    'Selection contains a credential',
  );
  expect(terminal.write).toHaveBeenCalledWith(firstRead);
  expect(terminal.write).toHaveBeenCalledWith(secondRead);
  expect(chatDraftsStore.get('chat-a')).toBe('');
  expect(activeChatsStore.getSnapshot()['chat-a']?.input).toBe('');
});

test('appends a fenced live-CWD selection to the real composer draft without dispatching a chat turn', async () => {
  const dispatch = vi.fn();
  vi.stubGlobal('fetch', dispatch);
  activeChatsStore.updateChat('chat-a', { input: 'Keep this existing draft.' });
  chatDraftsStore.set('chat-a', 'Keep this existing draft.');
  renderTerminal();
  const { socket, terminal } = await connectTerminal();

  await act(() => terminal.select('build failed'));
  fireEvent.click(screen.getByRole('button', { name: 'Send to chat' }));

  const expected = [
    'Keep this existing draft.',
    '',
    'Terminal output (working directory: "/workspace/live"):',
    '```',
    'build failed',
    '```',
  ].join('\n');
  await waitFor(() => expect(chatDraftsStore.get('chat-a')).toBe(expected));
  expect(activeChatsStore.getSnapshot()['chat-a']?.input).toBe(expected);
  expect(dispatch).not.toHaveBeenCalled();
  expect(
    socket.send.mock.calls.map(([raw]) => JSON.parse(raw as string).type),
  ).not.toContain('data');
});

test('copies the complete terminal selection', async () => {
  const writeText = vi.fn(async () => undefined);
  Object.assign(navigator, { clipboard: { writeText } });
  renderTerminal();
  const { terminal } = await connectTerminal();

  await act(() => terminal.select('copy exactly this'));
  fireEvent.click(screen.getByRole('button', { name: 'Copy' }));

  await waitFor(() =>
    expect(writeText).toHaveBeenCalledWith('copy exactly this'),
  );
});
