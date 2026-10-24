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
import { MOBILE_MEDIA_QUERY } from '../../../hooks/useIsMobile';
import { TerminalPanel } from '../TerminalPanel';

const { fetchTerminalPort, credentialProvider, assertRawEgress, station } =
  vi.hoisted(() => ({
    fetchTerminalPort: vi.fn(),
    assertRawEgress: vi.fn(),
    credentialProvider: {
      getCredential: (): string | undefined => undefined,
      getProtocolVersion: (): number | undefined => undefined,
    },
    station: { apiBase: 'http://localhost' },
  }));

vi.mock('@kontourai/station-sdk', () => ({
  assertClientRawEgressAllowed: assertRawEgress,
  executeCodingCommand: vi.fn(),
  fetchTerminalPort,
}));
vi.mock('../../../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({
    apiBase: station.apiBase,
    connectionId: 'direct-1',
    credentialProvider,
  }),
}));
vi.mock('../../../hooks/useIsMobile', async (original) => ({
  ...(await original<typeof import('../../../hooks/useIsMobile')>()),
  useIsMobile: () => false,
}));

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
    dataListener: ((data: string) => void) | null = null;
    onData = vi.fn((listener: (data: string) => void) => {
      this.dataListener = listener;
      return { dispose: vi.fn() };
    });
    onSelectionChange = vi.fn((listener: () => void) => {
      this.selectionListener = listener;
      return { dispose: vi.fn() };
    });
    hasSelection = vi.fn(() => Boolean(this.selection));
    getSelection = vi.fn(() => this.selection);
    options: { theme?: Record<string, string> } & Record<string, unknown>;

    constructor(options: Record<string, unknown> = {}) {
      this.options = { ...options };
      FakeTerminal.instances.push(this);
    }

    select(text: string) {
      this.selection = text;
      this.selectionListener?.();
    }
  }

  class FakeFitAddon {
    static instances: FakeFitAddon[] = [];
    static dimensions = { cols: 80, rows: 24 };
    constructor() {
      FakeFitAddon.instances.push(this);
    }
    proposeDimensions = vi.fn(() => FakeFitAddon.dimensions);
    fit = vi.fn(() =>
      Object.assign(FakeTerminal.instances.at(-1)!, FakeFitAddon.dimensions),
    );
  }

  return { FakeTerminal, FakeFitAddon };
});
const originalScrollTo = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  'scrollTo',
);

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

  constructor(
    readonly url: string,
    readonly protocols?: string | string[],
  ) {
    FakeWebSocket.instances.push(this);
  }
}

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  constructor(readonly callback: () => void) {
    FakeResizeObserver.instances.push(this);
  }
  observe = vi.fn();
  disconnect = vi.fn();
}

beforeEach(() => {
  assertRawEgress.mockReset().mockImplementation(() => undefined);
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
    configurable: true,
    value: vi.fn(),
  });
  fetchTerminalPort.mockResolvedValue(4310);
  FakeWebSocket.instances = [];
  FakeWebSocket.liveCwd = '/workspace/live';
  FakeTerminal.instances = [];
  FakeFitAddon.instances = [];
  FakeFitAddon.dimensions = { cols: 80, rows: 24 };
  FakeResizeObserver.instances = [];
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
  station.apiBase = 'http://localhost';
  credentialProvider.getCredential = () => undefined;
  activeChatsStore.removeChat('chat-a');
  chatDraftsStore.clear('chat-a');
  navigationStore.setActiveChat(null);
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  if (originalScrollTo)
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', originalScrollTo);
  else
    delete (HTMLElement.prototype as unknown as { scrollTo?: unknown })
      .scrollTo;
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

// The glyph size follows the app's one mobile breakpoint, including its
// landscape-phone clause, rather than a width-only copy of it.
test.each([
  { device: 'a phone held sideways', mobile: true, fontSize: 14 },
  { device: 'a desktop', mobile: false, fontSize: 12 },
])('renders larger glyphs only on a phone: $device', ({ mobile, fontSize }) => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: mobile && query === MOBILE_MEDIA_QUERY,
  }));
  renderTerminal();
  expect(FakeTerminal.instances[0]?.options?.fontSize).toBe(fontSize);
});

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

test('routine context updates keep the connected shell while a changed credential reconnects it', async () => {
  renderTerminal();
  const { socket, terminal } = await connectTerminal();
  act(() => navigationStore.setActiveChat('chat-a'));
  expect(socket.close).not.toHaveBeenCalled();
  expect(terminal.dispose).not.toHaveBeenCalled();
  expect(FakeWebSocket.instances).toHaveLength(1);

  credentialProvider.getCredential = () => 'changed-current-credential';
  act(() => navigationStore.setActiveChat(null));
  await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
  expect(socket.close).toHaveBeenCalledTimes(1);
});

test('retains terminal output after a lost connection and reconnects its identity without replaying typed commands', async () => {
  renderTerminal();
  const { socket, terminal } = await connectTerminal();
  act(() => terminal.dataListener?.('echo once\r'));
  act(() => {
    socket.readyState = 3;
    socket.onclose?.({ code: 1006 } as CloseEvent);
  });
  expect(screen.getByRole('alert').textContent).toMatch(/connection lost/i);
  expect(screen.getByRole('application', { name: 'Terminal' })).toBeTruthy();
  expect(terminal.dispose).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Reconnect terminal' }));
  await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
  const replacement = FakeWebSocket.instances[1]!;
  act(() => replacement.onopen?.());
  expect(replacement.send.mock.calls.map(([raw]) => JSON.parse(raw))).toEqual([
    expect.objectContaining({
      type: 'open',
      projectSlug: 'project-a',
      terminalId: 'terminal-one',
    }),
  ]);
  expect(
    replacement.send.mock.calls.some(
      ([raw]) => JSON.parse(raw).type === 'data',
    ),
  ).toBe(false);
});

test('ignores data and exit events for any session other than its own', async () => {
  renderTerminal();
  const { socket, terminal } = await connectTerminal();
  const deliver = (message: Record<string, unknown>) =>
    act(() =>
      socket.onmessage?.({ data: JSON.stringify(message) } as MessageEvent),
    );

  deliver({
    type: 'data',
    sessionId: 'project-b:terminal-two',
    data: 'foreign-shell-output',
  });
  deliver({
    type: 'exited',
    sessionId: 'project-b:terminal-two',
    exitCode: 0,
    signal: null,
  });

  expect(terminal.write).not.toHaveBeenCalledWith('foreign-shell-output');
  expect(terminal.write).not.toHaveBeenCalledWith(
    expect.stringContaining('[terminal exited]'),
  );
  expect(screen.queryByText('The shell has exited.')).toBeNull();

  // Positive control: the panel's own session still reaches the terminal.
  deliver({
    type: 'data',
    sessionId: 'project-a:terminal-one',
    data: 'own-shell-output',
  });
  expect(terminal.write).toHaveBeenCalledWith('own-shell-output');
  deliver({
    type: 'exited',
    sessionId: 'project-a:terminal-one',
    exitCode: 0,
    signal: null,
  });
  expect(terminal.write).toHaveBeenCalledWith(
    expect.stringContaining('[terminal exited]'),
  );
});

test('does not query a terminal port or open a raw socket when route policy blocks egress', async () => {
  assertRawEgress.mockImplementationOnce(() => {
    throw new Error(
      'Browser broker routes do not support direct terminal connections yet. Select a direct Station connection to use this feature.',
    );
  });

  renderTerminal();

  expect((await screen.findByRole('alert')).textContent).toContain(
    'Browser broker routes do not support direct terminal connections',
  );
  expect(fetchTerminalPort).not.toHaveBeenCalled();
  expect(FakeWebSocket.instances).toHaveLength(0);
});

test('rechecks route binding after terminal port lookup before opening the socket', async () => {
  let releasePort!: (port: number) => void;
  fetchTerminalPort.mockImplementationOnce(
    () => new Promise<number>((resolve) => (releasePort = resolve)),
  );
  assertRawEgress.mockImplementationOnce(() => undefined);
  assertRawEgress.mockImplementationOnce(() => {
    throw new Error(
      'Browser broker routes do not support direct terminal connections yet. Select a direct Station connection to use this feature.',
    );
  });

  renderTerminal();
  await waitFor(() => expect(fetchTerminalPort).toHaveBeenCalledTimes(1));
  releasePort(4310);

  expect((await screen.findByRole('alert')).textContent).toContain(
    'Browser broker routes do not support direct terminal connections',
  );
  expect(assertRawEgress).toHaveBeenCalledTimes(2);
  expect(FakeWebSocket.instances).toHaveLength(0);
});

test('closes a socket selected before a route change without sending terminal open content', async () => {
  assertRawEgress.mockImplementationOnce(() => undefined);
  assertRawEgress.mockImplementationOnce(() => undefined);
  assertRawEgress.mockImplementationOnce(() => {
    throw new Error('The selected Station authority is no longer available.');
  });
  renderTerminal();
  await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));

  const socket = FakeWebSocket.instances[0]!;
  socket.onopen?.();

  expect(socket.close).toHaveBeenCalled();
  expect(
    socket.send.mock.calls.some(
      ([raw]) => JSON.parse(raw as string).type === 'open',
    ),
  ).toBe(false);
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

test('sends a remote Station credential only in the first frame, never in the socket URL or subprotocols', async () => {
  const credential = 'sentinel-station-credential-7f3a';
  station.apiBase = 'https://station.example.test';
  credentialProvider.getCredential = () => credential;
  renderTerminal();

  await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
  const socket = FakeWebSocket.instances[0]!;
  socket.onopen?.();

  expect(socket.url).toBe('wss://station.example.test:4310');
  expect(socket.url).not.toContain(credential);
  expect(JSON.stringify(socket.protocols ?? null)).not.toContain(credential);
  // The control: the credential did resolve, and went in-band.
  expect(JSON.parse(socket.send.mock.calls[0]![0])).toMatchObject({
    type: 'auth',
    credential,
  });
});

test('repaints the canvas from the terminal variables when the root theme changes', async () => {
  // The real cascade shape: the variables differ per root attribute, and the
  // terminal must re-read them, since xterm paints a canvas CSS cannot reach.
  const sheet = document.createElement('style');
  sheet.textContent = `
    .coding-terminal { --terminal-background: #1a1a2e; --terminal-foreground: #e0e0e0; }
    [data-theme="light"] .coding-terminal { --terminal-background: #ffffff; --terminal-foreground: #24292f; }
    [data-color-theme="latte"] .coding-terminal { --terminal-background: #eff1f5; }
  `;
  document.head.append(sheet);
  const root = document.documentElement;
  root.setAttribute('data-theme', 'dark');
  try {
    renderTerminal();
    const { terminal } = await connectTerminal();
    expect(terminal.options.theme).toMatchObject({
      background: '#1a1a2e',
      foreground: '#e0e0e0',
    });

    await act(async () => {
      root.setAttribute('data-theme', 'light');
    });
    await waitFor(() =>
      expect(terminal.options.theme).toMatchObject({
        background: '#ffffff',
        foreground: '#24292f',
      }),
    );

    await act(async () => {
      root.setAttribute('data-color-theme', 'latte');
    });
    await waitFor(() =>
      expect(terminal.options.theme?.background).toBe('#eff1f5'),
    );
  } finally {
    sheet.remove();
    root.removeAttribute('data-color-theme');
    root.setAttribute('data-theme', 'dark');
  }
});

test('coalesces resize bursts, skips unchanged cells, and cancels pending work on unmount', async () => {
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++frameId, callback);
    return frameId;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  const flush = () =>
    act(() => {
      const pending = [...frames.values()];
      frames.clear();
      pending.forEach((callback) => callback(0));
    });
  const mounted = renderTerminal();
  const { socket } = await connectTerminal();
  const observer = FakeResizeObserver.instances.at(-1)!;
  const fit = FakeFitAddon.instances.at(-1)!.fit;
  flush();
  fit.mockClear();
  socket.send.mockClear();
  observer.callback();
  observer.callback();
  observer.callback();
  expect(frames.size).toBe(1);
  flush();
  expect(fit).not.toHaveBeenCalled();
  expect(socket.send).not.toHaveBeenCalled();
  FakeFitAddon.dimensions = { cols: 90, rows: 30 };
  observer.callback();
  observer.callback();
  flush();
  expect(fit).toHaveBeenCalledTimes(1);
  expect(socket.send.mock.calls.map(([raw]) => JSON.parse(raw))).toEqual([
    { type: 'resize', sessionId: 'project-a:terminal-one', cols: 90, rows: 30 },
  ]);
  observer.callback();
  flush();
  expect(socket.send).toHaveBeenCalledTimes(1);
  observer.callback();
  mounted.unmount();
  expect(frames.size).toBe(0);
});
