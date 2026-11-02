/** @vitest-environment jsdom */

import { createWorkspaceTerminalPaneInstance } from '@kontourai/station-contracts/workspace-terminal-pane';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ActiveChatsProvider } from '../../contexts/ActiveChatsContext';
import { NavigationProvider } from '../../contexts/NavigationContext';
import { TerminalSessionPane } from '../TerminalSessionPane';
import { createTerminalPaneStatePreparation } from '../terminalPaneOccurrence';

/**
 * The pane a related terminal open places (docs/design/terminal.md,
 * "Plugins"): it attaches to exactly the session its stored record names, on
 * the Station's own session store, and without the viewer's
 * `terminal:operate` it only watches.
 */

const { store, FakeSession } = vi.hoisted(() => {
  type Listener = {
    output?(data: Uint8Array, sequence: number): void;
    change?(session: unknown): void;
  };
  class FakeSession {
    static instances: FakeSession[] = [];
    terminalId: string | undefined;
    state = 'connecting';
    status: string | undefined;
    readOnly = false;
    error: undefined;
    listeners = new Set<Listener>();
    write = vi.fn((_data: string) => true);
    resize = vi.fn();
    cwd = vi.fn(async () => '/workspace');
    detach = vi.fn();
    constructor(
      readonly target: { projectId: string; bindingKey: string },
      terminalId: string,
    ) {
      this.terminalId = terminalId;
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
    output(text: string) {
      for (const listener of this.listeners)
        listener.output?.(new TextEncoder().encode(text), 1);
    }
  }
  const store = {
    failure: undefined as unknown,
    restart: vi.fn(),
    open: vi.fn(),
    attach: vi.fn(
      (target: FakeSession['target'], terminalId: string) =>
        new FakeSession(target, terminalId),
    ),
  };
  return { store, FakeSession };
});

const viewer = vi.hoisted(() => ({
  grant: { kind: 'operator' } as
    | { kind: 'operator' }
    | { kind: 'device'; deviceId: string; grantedScopes: string[] },
}));

vi.mock('../../components/coding-layout/terminalSessionStore', () => ({
  useTerminalSessionStore: () => store,
}));
vi.mock('../../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://localhost', connectionId: 'direct-1' }),
}));
vi.mock('../../contexts/AuthorityPersistenceContext', () => ({
  useAuthorityPersistence: () => ({
    observation: { grant: viewer.grant },
  }),
}));
vi.mock('../../contexts/ProjectsContext', () => ({
  useProject: () => ({ project: { workingDirectory: '/workspace' } }),
}));
vi.mock('../../hooks/useIsMobile', async (original) => ({
  ...(await original<typeof import('../../hooks/useIsMobile')>()),
  useIsMobile: () => false,
}));
// The relation chrome and Station fence have their own suites; here the
// record is admitted and only the session is under test.
vi.mock('../RelatedPaneStrip', () => ({
  FencedRelatedPane: ({ children }: { children: ReactNode }) => children,
  RelatedPaneStrip: () => null,
}));

type ViewSessionLike = {
  readOnly: boolean;
  subscribe(listener: { output(bytes: Uint8Array): void }): () => void;
  write(bytes: Uint8Array): boolean;
  resize(cols: number, rows: number): void;
};
const view = vi.hoisted(() => ({
  sessions: [] as (ViewSessionLike | null)[],
  output: [] as string[],
}));
vi.mock('@kontourai/station-sdk/terminal-view', async (original) => {
  const { useEffect } = await import('react');
  function FakeTerminalView({ session }: { session: ViewSessionLike | null }) {
    view.sessions.push(session);
    useEffect(
      () =>
        session?.subscribe({
          output: (bytes) => view.output.push(new TextDecoder().decode(bytes)),
        }),
      [session],
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

const ID = `terminal-pane:${'c'.repeat(32)}`;
const TERMINAL = '62b97fa1-b690-4d77-82b1-747dc86d3c11';
const PROJECT = { projectId: 'project-a-id', projectSlug: 'project-a' };

function storeRecord(binding = 'thread:t-7') {
  expect(
    createTerminalPaneStatePreparation(window.localStorage, ID, {
      version: 1,
      ...PROJECT,
      binding,
      terminalId: TERMINAL,
    }).prepare(),
  ).toBe(true);
}

function renderPane() {
  const instance = createWorkspaceTerminalPaneInstance(ID, PROJECT.projectId);
  if (!instance) throw new Error('fixture instance');
  return render(
    <NavigationProvider>
      <ActiveChatsProvider>
        <TerminalSessionPane instance={instance} />
      </ActiveChatsProvider>
    </NavigationProvider>,
  );
}

function shownSession(): ViewSessionLike {
  const session = view.sessions.at(-1);
  if (!session) throw new Error('no session shown');
  return session;
}

beforeEach(() => {
  window.localStorage.clear();
  FakeSession.instances = [];
  view.sessions = [];
  view.output = [];
  viewer.grant = { kind: 'operator' };
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

test('opening the target shows exactly the session its record names', async () => {
  storeRecord('thread:t-7');
  renderPane();
  await waitFor(() => expect(store.attach).toHaveBeenCalledTimes(1));
  expect(store.attach).toHaveBeenCalledWith(
    { projectId: PROJECT.projectId, bindingKey: 'thread:t-7' },
    TERMINAL,
  );
  expect(store.open).not.toHaveBeenCalled();
  const session = FakeSession.instances[0]!;
  act(() => session.emit({ state: 'ready', status: 'running' }));
  act(() => session.output('hello from t-7\r\n'));
  expect(view.output).toContain('hello from t-7\r\n');
});

test('with terminal:operate the viewer types into the session', async () => {
  storeRecord();
  renderPane();
  await waitFor(() => expect(FakeSession.instances).toHaveLength(1));
  const session = FakeSession.instances[0]!;
  act(() => session.emit({ state: 'ready', status: 'running' }));
  expect(shownSession().readOnly).toBe(false);
  expect(shownSession().write(new TextEncoder().encode('ls\r'))).toBe(true);
  expect(session.write).toHaveBeenCalledWith('ls\r');
});

test('without terminal:operate the pane only watches: no input and no resize', async () => {
  viewer.grant = {
    kind: 'device',
    deviceId: 'phone',
    grantedScopes: ['terminal:observe'],
  };
  storeRecord();
  renderPane();
  await waitFor(() => expect(FakeSession.instances).toHaveLength(1));
  const session = FakeSession.instances[0]!;
  act(() => session.emit({ state: 'ready', status: 'running' }));
  expect(shownSession().readOnly).toBe(true);
  expect(shownSession().write(new TextEncoder().encode('rm -rf .\r'))).toBe(
    false,
  );
  shownSession().resize(120, 40);
  expect(session.write).not.toHaveBeenCalled();
  expect(session.resize).not.toHaveBeenCalled();
  act(() => session.output('still visible\r\n'));
  expect(view.output).toContain('still visible\r\n');
});

test('a pane whose record is gone says so and attaches to nothing', () => {
  renderPane();
  expect(screen.getByText('This terminal is no longer available')).toBeTruthy();
  expect(store.attach).not.toHaveBeenCalled();
});
