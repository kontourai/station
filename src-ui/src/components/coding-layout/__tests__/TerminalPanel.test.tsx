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

const { executeCodingCommand, store, FakeSession } = vi.hoisted(() => {
  type Listener = {
    output?(data: Uint8Array, sequence: number): void;
    reset?(): void;
    change?(session: unknown): void;
  };
  /** The renderer-facing session interface, driven by the test. */
  class FakeSession {
    static instances: FakeSession[] = [];
    terminalId: string | undefined;
    state = 'connecting';
    status: string | undefined;
    readOnly = false;
    error: { code: string; message: string } | undefined;
    listeners = new Set<Listener>();
    write = vi.fn((_data: string) => this.state === 'ready');
    resize = vi.fn();
    cwd = vi.fn(async () => '/workspace/live');
    close = vi.fn(async () => undefined);
    detach = vi.fn(() => {
      this.state = 'detached';
    });
    constructor(
      readonly target: { projectId: string; bindingKey: string },
      readonly intent: Record<string, unknown>,
    ) {
      this.terminalId = intent.terminalId as string | undefined;
      FakeSession.instances.push(this);
    }
    subscribe(listener: Listener) {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    }
    emit(patch: Partial<FakeSession>) {
      Object.assign(this, patch);
      for (const listener of this.listeners) listener.change?.(this);
    }
    output(text: string, sequence = 1) {
      for (const listener of this.listeners)
        listener.output?.(new TextEncoder().encode(text), sequence);
    }
  }
  const store = {
    failure: undefined as unknown,
    restart: vi.fn(),
    open: vi.fn(
      (target: FakeSession['target'], options: Record<string, unknown>) =>
        new FakeSession(target, { kind: 'open', ...options }),
    ),
    attach: vi.fn(
      (target: FakeSession['target'], terminalId: string) =>
        new FakeSession(target, { kind: 'attach', terminalId }),
    ),
  };
  return { executeCodingCommand: vi.fn(), store, FakeSession };
});

vi.mock('@kontourai/station-sdk', () => ({ executeCodingCommand }));
vi.mock('../terminalSessionStore', () => ({
  useTerminalSessionStore: () => store,
}));
vi.mock('../../../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://localhost', connectionId: 'direct-1' }),
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
    reset = vi.fn();
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
    written(): string {
      return this.write.mock.calls
        .map(([value]) =>
          typeof value === 'string' ? value : new TextDecoder().decode(value),
        )
        .join('');
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

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  constructor(readonly callback: () => void) {
    FakeResizeObserver.instances.push(this);
  }
  observe = vi.fn();
  disconnect = vi.fn();
}

const target = { projectId: 'project-a-id', bindingKey: 'project' };
const terminalId = '62b97fa1-b690-4d77-82b1-747dc86d3c11';

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
    configurable: true,
    value: vi.fn(),
  });
  FakeSession.instances = [];
  FakeTerminal.instances = [];
  FakeFitAddon.instances = [];
  FakeFitAddon.dimensions = { cols: 80, rows: 24 };
  FakeResizeObserver.instances = [];
  store.failure = undefined;
  activeChatsStore.removeChat('chat-a');
  chatDraftsStore.clear('chat-a');
  activeChatsStore.initChat('chat-a');
  navigationStore.setActiveChat('chat-a');
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
  if (originalScrollTo)
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', originalScrollTo);
  else
    delete (HTMLElement.prototype as unknown as { scrollTo?: unknown })
      .scrollTo;
});

function renderTerminal(
  props: Partial<Parameters<typeof TerminalPanel>[0]> = {},
) {
  return render(
    <NavigationProvider>
      <ActiveChatsProvider>
        <TerminalPanel
          projectSlug="project-a"
          workingDir="/workspace"
          target={target}
          terminalId={terminalId}
          {...props}
        />
      </ActiveChatsProvider>
    </NavigationProvider>,
  );
}

async function connectTerminal() {
  await waitFor(() => expect(FakeSession.instances).toHaveLength(1));
  const session = FakeSession.instances[0]!;
  act(() => session.emit({ state: 'ready', status: 'running' }));
  return { session, terminal: FakeTerminal.instances[0]! };
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

test('attaches an existing session by id and unmount detaches without closing it', async () => {
  const rendered = renderTerminal();
  const { session } = await connectTerminal();
  expect(store.attach).toHaveBeenCalledWith(target, terminalId);
  expect(store.open).not.toHaveBeenCalled();
  rendered.unmount();
  expect(session.detach).toHaveBeenCalledTimes(1);
  expect(session.close).not.toHaveBeenCalled();
});

test('a new tab asks the server for a session and reports its id once', async () => {
  const onOpened = vi.fn();
  renderTerminal({
    terminalId: undefined,
    viewKey: 'term-1',
    launch: { kind: 'agent', connectionId: 'claude', mode: 'code' },
    onOpened,
  });
  await waitFor(() => expect(store.open).toHaveBeenCalledTimes(1));
  // A program is named, never chosen: no executable, args or cwd leave here.
  expect(store.open).toHaveBeenCalledWith(target, {
    cols: 80,
    rows: 24,
    launch: { kind: 'agent', connectionId: 'claude', mode: 'code' },
  });
  const session = FakeSession.instances[0]!;
  act(() => session.emit({ terminalId, state: 'replaying' }));
  act(() => session.emit({ state: 'ready' }));
  expect(onOpened).toHaveBeenCalledTimes(1);
  expect(onOpened).toHaveBeenCalledWith(terminalId);
});

test('unowned saved history still yields a fresh shell', async () => {
  renderTerminal({
    terminalId: undefined,
    viewKey: 'term-1700000000000',
    legacyTerminalId: 'term-1700000000000',
  });
  await waitFor(() => expect(store.open).toHaveBeenCalledTimes(1));
  expect(store.open.mock.calls[0]![1]).toMatchObject({
    legacyTerminalId: 'term-1700000000000',
  });
  act(() =>
    FakeSession.instances[0]!.emit({
      state: 'failed',
      error: { code: 'refused', message: 'Terminal access was refused.' },
    }),
  );
  await waitFor(() => expect(store.open).toHaveBeenCalledTimes(2));
  expect(store.open.mock.calls[1]![1]).not.toHaveProperty('legacyTerminalId');
  expect(screen.queryByText('Terminal access was refused.')).toBeNull();
});

test('writes session output and typed input through the store, and reports exit', async () => {
  renderTerminal();
  const { session, terminal } = await connectTerminal();
  act(() => session.output('hello from the shell'));
  expect(terminal.written()).toContain('hello from the shell');
  act(() => terminal.dataListener?.('ls\r'));
  expect(session.write).toHaveBeenCalledWith('ls\r');
  act(() => session.emit({ status: 'exited' }));
  expect(terminal.written()).toContain('[terminal exited]');
  expect(screen.getByRole('alert').textContent).toContain(
    'The shell has exited.',
  );
});

test('a dropped connection shows reconnecting and an explicit reconnect starts a new view of the same session', async () => {
  renderTerminal();
  const { session } = await connectTerminal();
  act(() => session.emit({ state: 'reconnecting' }));
  expect(screen.getByRole('alert').textContent).toMatch(/reconnecting/i);
  act(() =>
    session.emit({
      state: 'failed',
      error: { code: 'connection-lost', message: 'Terminal unavailable.' },
    }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Reconnect terminal' }));
  await waitFor(() => expect(store.attach).toHaveBeenCalledTimes(2));
  expect(store.attach.mock.calls[1]).toEqual([target, terminalId]);
  // Reattaching never replays typed input.
  expect(FakeSession.instances[1]!.write).not.toHaveBeenCalled();
});

test('a missing PTY backend swaps to the command executor with the server reason', async () => {
  renderTerminal();
  const { session } = await connectTerminal();
  act(() =>
    session.emit({
      state: 'failed',
      error: {
        code: 'pty-unavailable',
        message: 'node-pty could not load on this host',
      },
    }),
  );
  expect((await screen.findByRole('alert')).textContent).toContain(
    'node-pty could not load on this host',
  );
  expect(screen.getByPlaceholderText('Type a command...')).toBeTruthy();
});

test('a broker route refusal is shown instead of a terminal', async () => {
  renderTerminal();
  await waitFor(() => expect(FakeSession.instances).toHaveLength(1));
  act(() =>
    FakeSession.instances[0]!.emit({
      state: 'failed',
      error: {
        code: 'raw-egress-unavailable',
        message:
          'Terminals need a direct Station connection. Select a direct connection and try again.',
      },
    }),
  );
  expect((await screen.findByRole('alert')).textContent).toContain(
    'Terminals need a direct Station connection',
  );
});

test('an attach-only view without a session id never opens a shell', async () => {
  renderTerminal({ terminalId: undefined, attachOnly: true });
  expect((await screen.findByRole('alert')).textContent).toContain(
    'This terminal session is unavailable.',
  );
  expect(store.open).not.toHaveBeenCalled();
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

test.each([
  { query: '', blocked: false },
  { query: '?port=43123&mode=debug#public', blocked: false },
  { query: `?port=43123&capability=${'C'.repeat(43)}`, blocked: true },
  { query: '?port=43123&password=private-value', blocked: true },
])(
  'native asset selection with query "$query" has credential refusal=$blocked',
  async ({ query, blocked }) => {
    renderTerminal();
    const { terminal } = await connectTerminal();
    const selection = `http://station-plugin.localhost/api/plugins/demo/bundle.js${query}`;
    await act(() => terminal.select(selection));
    fireEvent.click(screen.getByRole('button', { name: 'Send to chat' }));
    if (blocked) {
      expect((await screen.findByRole('alert')).textContent).toContain(
        'Selection contains a credential',
      );
      expect(chatDraftsStore.get('chat-a')).toBe('');
      expect(activeChatsStore.getSnapshot()['chat-a']?.input).toBe('');
    } else {
      await waitFor(() =>
        expect(chatDraftsStore.get('chat-a')).toContain(selection),
      );
      expect(activeChatsStore.getSnapshot()['chat-a']?.input).toContain(
        selection,
      );
      expect(screen.queryByRole('alert')).toBeNull();
    }
  },
);

test('appends a fenced live-CWD selection to the real composer draft without dispatching a chat turn', async () => {
  const dispatch = vi.fn();
  vi.stubGlobal('fetch', dispatch);
  activeChatsStore.updateChat('chat-a', { input: 'Keep this existing draft.' });
  chatDraftsStore.set('chat-a', 'Keep this existing draft.');
  renderTerminal();
  const { session, terminal } = await connectTerminal();

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
  // The working directory came from the session, and nothing was typed.
  expect(session.cwd).toHaveBeenCalledTimes(1);
  expect(session.write).not.toHaveBeenCalled();
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

test('coalesces resize bursts into the latest size once per frame and cancels pending work on unmount', async () => {
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
  const { session } = await connectTerminal();
  const observer = FakeResizeObserver.instances.at(-1)!;
  const fit = FakeFitAddon.instances.at(-1)!.fit;
  flush();
  fit.mockClear();
  session.resize.mockClear();
  observer.callback();
  observer.callback();
  observer.callback();
  expect(frames.size).toBe(1);
  flush();
  expect(fit).not.toHaveBeenCalled();
  FakeFitAddon.dimensions = { cols: 90, rows: 30 };
  observer.callback();
  observer.callback();
  flush();
  expect(fit).toHaveBeenCalledTimes(1);
  expect(session.resize).toHaveBeenLastCalledWith(90, 30);
  expect(session.resize).toHaveBeenCalledTimes(2);
  observer.callback();
  mounted.unmount();
  expect(frames.size).toBe(0);
});
