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

type ViewSessionLike = {
  subscribe(listener: {
    output(bytes: Uint8Array, kind: 'replay' | 'live'): void;
  }): () => void;
  write(bytes: Uint8Array): boolean;
};
type ViewProps = {
  session: ViewSessionLike | null;
  fontSize?: number;
  touchKeys?: boolean;
  notices?: boolean;
  onAddToChat?(text: string): void;
};

/** What the reduced TerminalView received: its props and session output. */
const view = vi.hoisted(() => ({
  props: [] as unknown[],
  output: [] as [string, string][],
}));

// The public TerminalView, reduced to what the panel relies on: it renders
// the session it is given, as the real one does, and records what it saw.
vi.mock('@kontourai/station-sdk/terminal-view', async (original) => {
  const { useEffect } = await import('react');
  function FakeTerminalView(props: ViewProps) {
    view.props.push(props);
    useEffect(
      () =>
        props.session?.subscribe({
          output: (bytes, kind) =>
            view.output.push([new TextDecoder().decode(bytes), kind]),
        }),
      [props.session],
    );
    return null;
  }
  return {
    ...(await original<
      typeof import('@kontourai/station-sdk/terminal-view')
    >()),
    TerminalView: FakeTerminalView,
  };
});

function latestView(): ViewProps {
  const props = view.props.at(-1) as ViewProps | undefined;
  if (!props) throw new Error('TerminalView never rendered');
  return props;
}

/** Input as the view sends it: encoder bytes for the session. */
function typeInView(text: string): boolean {
  return latestView().session?.write(new TextEncoder().encode(text)) ?? false;
}

const originalScrollTo = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  'scrollTo',
);

const target = { projectId: 'project-a-id', bindingKey: 'project' };
const terminalId = '62b97fa1-b690-4d77-82b1-747dc86d3c11';

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
    configurable: true,
    value: vi.fn(),
  });
  FakeSession.instances = [];
  view.props = [];
  view.output = [];
  store.failure = undefined;
  activeChatsStore.removeChat('chat-a');
  chatDraftsStore.clear('chat-a');
  activeChatsStore.initChat('chat-a');
  navigationStore.setActiveChat('chat-a');
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
  return { session };
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
  expect(latestView().fontSize).toBe(fontSize);
});

test('renders through the public TerminalView and leaves connection notices to the panel', async () => {
  renderTerminal();
  await connectTerminal();
  const props = latestView();
  expect(props.session).not.toBeNull();
  // The panel reports connection state with its own Reconnect action.
  expect(props.notices).toBe(false);
  expect(typeof props.onAddToChat).toBe('function');
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

test('session output reaches the view, typed input reaches the store, and exit is reported', async () => {
  renderTerminal();
  const { session } = await connectTerminal();
  act(() => session.output('hello from the shell'));
  expect(view.output).toContainEqual(['hello from the shell', 'live']);
  act(() => {
    expect(typeInView('ls\r')).toBe(true);
  });
  expect(session.write).toHaveBeenCalledWith('ls\r');
  act(() => session.emit({ status: 'exited' }));
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
  const { session } = await connectTerminal();
  const credential = ['ghp_', 'a'.repeat(36)].join('');
  const firstRead = `token=${credential.slice(0, 12)}`;
  const secondRead = credential.slice(12);
  act(() => session.output(firstRead, 1));
  act(() => session.output(secondRead, 2));

  // The view hands over its one complete selection.
  await act(async () =>
    latestView().onAddToChat?.(`${firstRead}${secondRead}`),
  );

  expect((await screen.findByRole('alert')).textContent).toContain(
    'Selection contains a credential',
  );
  // The live terminal still shows exactly what the shell wrote.
  expect(view.output.map(([text]) => text)).toEqual([firstRead, secondRead]);
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
    await connectTerminal();
    const selection = `http://station-plugin.localhost/api/plugins/demo/bundle.js${query}`;
    await act(async () => latestView().onAddToChat?.(selection));
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
  const { session } = await connectTerminal();

  await act(async () => latestView().onAddToChat?.('build failed'));

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
