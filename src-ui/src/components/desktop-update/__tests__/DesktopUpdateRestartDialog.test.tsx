/** @vitest-environment jsdom */
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { DesktopUpdateRestartDialog } from '../DesktopUpdateRestartDialog';
import {
  desktopUpdateFixture,
  installFakeNativeUpdater,
} from './fakeNativeUpdater';

const native = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: native.listen }));

const facts = vi.hoisted(() => ({
  supervisesBundledServer: true,
  apiBase: 'http://127.0.0.1:4141',
  bundled: null as null | Record<string, unknown>,
  sessions: {
    data: undefined as unknown,
    isError: false,
    isFetching: false,
  },
  refetch: vi.fn(),
}));
vi.mock('../../../platform/PlatformProfileContext', () => ({
  usePlatformProfile: () => ({
    supervisesBundledServer: facts.supervisesBundledServer,
  }),
}));
vi.mock('../../../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: facts.apiBase }),
}));
vi.mock('../../../platform/useBundledServerStatus', () => ({
  useBundledServerStatus: () => facts.bundled,
}));
vi.mock('@kontourai/station-sdk', () => ({
  useOrchestrationSessionsQuery: () => ({
    ...facts.sessions,
    refetch: facts.refetch,
  }),
}));

function session(
  threadId: string,
  displayTitle: string,
  hasActiveTurn: boolean,
) {
  return { threadId, displayTitle, hasActiveTurn, provider: 'claude' };
}

beforeEach(() => {
  vi.resetAllMocks();
  installFakeNativeUpdater(native, desktopUpdateFixture('ready'));
  facts.supervisesBundledServer = true;
  facts.apiBase = 'http://127.0.0.1:4141';
  facts.bundled = null;
  facts.sessions = { data: [], isError: false, isFetching: false };
});

function open(state = desktopUpdateFixture('ready')) {
  const onClose = vi.fn();
  render(<DesktopUpdateRestartDialog state={state} onClose={onClose} />);
  const dialog = screen.getByRole('dialog', {
    name: 'Restart Station to install 0.1.12?',
  });
  return { dialog, onClose };
}

describe('DesktopUpdateRestartDialog', () => {
  test('a desktop-owned server lists the running agent turns it interrupts', () => {
    facts.bundled = {
      ownership: 'sidecar',
      apiBase: 'http://127.0.0.1:4141/',
    };
    facts.sessions.data = [
      session('t-1', 'Refactor the importer', true),
      session('t-2', 'Idle chat', false),
      session('t-3', 'Write release notes', true),
    ];
    const { dialog } = open();
    const body = within(dialog);
    expect(
      body.getByText(/built-in server runs inside this app/),
    ).not.toBeNull();
    expect(
      body.getByText(
        'These 2 agent turns are running and will be interrupted:',
      ),
    ).not.toBeNull();
    const items = body.getAllByRole('listitem').map((item) => item.textContent);
    expect(items).toEqual(['Refactor the importer', 'Write release notes']);
    expect(body.queryByText(/resume/i)).toBeNull();
    expect(facts.refetch).toHaveBeenCalled();
    expect(
      body.getByText(/installs version 0.1.12 \(you have 0.1.11\)/),
    ).not.toBeNull();
  });

  test('an installed service keeps running, and no turns are listed', () => {
    facts.bundled = { ownership: 'service', apiBase: 'http://127.0.0.1:4141' };
    facts.sessions.data = [session('t-1', 'Refactor the importer', true)];
    const { dialog } = open();
    const body = within(dialog);
    expect(
      body.getByText(
        /runs as a background service on this computer\. It keeps running, and so do its agents\./,
      ),
    ).not.toBeNull();
    expect(body.queryByRole('listitem')).toBeNull();
    expect(body.queryByText(/interrupted/)).toBeNull();
  });

  test('a server outside the app keeps running', () => {
    // The desktop's own sidecar serves a different address than this window.
    facts.bundled = { ownership: 'sidecar', apiBase: 'http://127.0.0.1:5151' };
    facts.apiBase = 'https://station.example.ts.net';
    facts.sessions.data = [session('t-1', 'Remote work', true)];
    const { dialog } = open();
    expect(
      within(dialog).getByText(
        /connected to a Station server that runs outside it/,
      ),
    ).not.toBeNull();
    expect(within(dialog).queryByRole('listitem')).toBeNull();
  });

  test('an unreported server is unknown, not assumed safe', () => {
    facts.bundled = null;
    facts.sessions.data = [session('t-1', 'Refactor the importer', true)];
    const { dialog } = open();
    const body = within(dialog);
    expect(
      body.getByText(/could not confirm whether its server restarts/),
    ).not.toBeNull();
    expect(
      body.getByText('This agent turn is running and will be interrupted:'),
    ).not.toBeNull();
  });

  test('an unanswered session list is disclosed', () => {
    facts.bundled = { ownership: 'sidecar', apiBase: 'http://127.0.0.1:4141' };
    facts.sessions = { data: undefined, isError: true, isFetching: false };
    const { dialog } = open();
    expect(within(dialog).getByRole('alert').textContent).toMatch(
      /could not list running agent turns/,
    );
  });

  test('Later closes without installing; Restart now installs', async () => {
    const { onClose } = open();
    fireEvent.click(screen.getByRole('button', { name: 'Later' }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(native.invoke).not.toHaveBeenCalledWith(
      'desktop_update_install',
      undefined,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Restart now' }));
    await waitFor(() =>
      expect(native.invoke).toHaveBeenCalledWith(
        'desktop_update_install',
        undefined,
      ),
    );
  });

  test('a failed install says nothing restarted and offers Try again', () => {
    const { dialog } = open(desktopUpdateFixture('installFailed'));
    const body = within(dialog);
    expect(body.getByRole('alert').textContent).toBe(
      'The update did not install, and Station did not restart.',
    );
    expect(
      body.getByText('failed to move the new app into place'),
    ).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Try again' })).not.toBeNull();
  });

  test('while installing it cannot be dismissed', () => {
    open(desktopUpdateFixture('installing'));
    const later = screen.getByRole('button', {
      name: 'Later',
    }) as HTMLButtonElement;
    expect(later.disabled).toBe(true);
    expect(
      screen.queryByRole('button', { name: 'Close restart confirmation' }),
    ).toBeNull();
  });
});
