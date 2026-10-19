/** @vitest-environment jsdom */
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { DesktopUpdateControl } from '../DesktopUpdateControl';
import {
  desktopUpdateFixture,
  installFakeNativeUpdater,
} from './fakeNativeUpdater';

const native = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: native.listen }));

// The confirmation's own facts; its contents are covered by
// DesktopUpdateRestartDialog.test.tsx.
vi.mock('../../../platform/PlatformProfileContext', () => ({
  usePlatformProfile: () => ({ supervisesBundledServer: true }),
}));
vi.mock('../../../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://127.0.0.1:4141' }),
}));
vi.mock('../../../platform/useBundledServerStatus', () => ({
  useBundledServerStatus: () => ({
    ownership: 'service',
    apiBase: 'http://127.0.0.1:4141',
  }),
}));
vi.mock('@kontourai/station-sdk', () => ({
  useOrchestrationSessionsQuery: () => ({
    data: [],
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
  }),
}));

beforeEach(() => vi.resetAllMocks());
afterEach(() => vi.restoreAllMocks());

async function mount(fixture: Parameters<typeof desktopUpdateFixture>[0]) {
  const fake = installFakeNativeUpdater(native, desktopUpdateFixture(fixture));
  const view = render(<DesktopUpdateControl />);
  await waitFor(() => expect(fake.listenerCount()).toBe(1));
  await waitFor(() =>
    expect(native.invoke).toHaveBeenCalledWith(
      'desktop_update_state',
      undefined,
    ),
  );
  return { fake, view };
}

describe('DesktopUpdateControl', () => {
  test.each([
    'disabled',
    'idle',
    'checking',
    'upToDate',
    'checkFailed',
  ] as const)('shows nothing in chrome while %s', async (fixture) => {
    const { view } = await mount(fixture);
    // Give the pulled snapshot a chance to render.
    await act(async () => undefined);
    expect(view.container.innerHTML).toBe('');
  });

  test('offers a download for an available update and starts it on click', async () => {
    const { fake } = await mount('available');
    const button = await screen.findByRole('button', {
      name: 'Download update: Station 0.1.12',
    });
    expect(button.textContent).toBe('Download update');
    fireEvent.click(button);
    await waitFor(() =>
      expect(fake.commands()).toEqual(['desktop_update_download']),
    );
  });

  test('shows byte progress pushed by the native side, then Restart', async () => {
    const { fake } = await mount('available');
    await screen.findByRole('button', { name: /Download update/ });
    act(() => fake.emit(desktopUpdateFixture('downloading')));
    const progress = await screen.findByRole('progressbar', {
      name: 'Downloading Station 0.1.12',
    });
    expect(progress.getAttribute('aria-valuenow')).toBe('42');
    expect(progress.textContent).toBe('Downloading 42%');

    const unknownSize = desktopUpdateFixture('downloading');
    if (unknownSize.phase.status !== 'downloading') throw new Error('fixture');
    unknownSize.phase.totalBytes = null;
    act(() => fake.emit(unknownSize));
    expect(progress.getAttribute('aria-valuenow')).toBeNull();
    expect(progress.textContent).toBe('Downloading 40.1 MB');

    act(() => fake.emit(desktopUpdateFixture('ready')));
    expect(
      await screen.findByRole('button', {
        name: 'Restart to update to Station 0.1.12',
      }),
    ).not.toBeNull();
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  test('a failed download offers a retry', async () => {
    const { fake } = await mount('downloadFailed');
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Retry download: Station 0.1.12',
      }),
    );
    await waitFor(() =>
      expect(fake.commands()).toEqual(['desktop_update_download']),
    );
  });

  test('Restart only opens the confirmation; Restart now installs', async () => {
    const { fake } = await mount('ready');
    fireEvent.click(
      await screen.findByRole('button', { name: /Restart to update/ }),
    );
    const dialog = await screen.findByRole('dialog', {
      name: 'Restart Station to install 0.1.12?',
    });
    expect(dialog).not.toBeNull();
    // Opening the confirmation installs nothing.
    expect(fake.commands()).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: 'Later' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(fake.commands()).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: /Restart to update/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Restart now' }));
    await waitFor(() =>
      expect(fake.commands()).toEqual(['desktop_update_install']),
    );
  });

  test('an event that lands while the snapshot is in flight wins', async () => {
    let releasePull!: () => void;
    const fake = installFakeNativeUpdater(native, desktopUpdateFixture('idle'));
    const answer = native.invoke.getMockImplementation()!;
    native.invoke.mockImplementation(async (command: string) => {
      if (command !== 'desktop_update_state') return answer(command);
      const stale = desktopUpdateFixture('idle');
      await new Promise<void>((resolve) => {
        releasePull = resolve;
      });
      return stale;
    });
    render(<DesktopUpdateControl />);
    await waitFor(() => expect(fake.listenerCount()).toBe(1));
    await waitFor(() => expect(releasePull).toBeTypeOf('function'));
    act(() => fake.emit(desktopUpdateFixture('ready')));
    await act(async () => releasePull());
    expect(
      screen.getByRole('button', { name: /Restart to update/ }),
    ).not.toBeNull();
  });
});

test('an event older than one already applied is dropped', async () => {
  const { fake } = await mount('available');
  act(() => fake.emit(desktopUpdateFixture('ready')));
  await screen.findByRole('button', { name: /Restart to update/ });
  // A late progress event from before the download finished.
  act(() =>
    fake.emitAsIs({ ...desktopUpdateFixture('downloading'), sequence: 1 }),
  );
  expect(screen.queryByRole('progressbar')).toBeNull();
  expect(
    screen.getByRole('button', { name: /Restart to update/ }),
  ).not.toBeNull();
});
