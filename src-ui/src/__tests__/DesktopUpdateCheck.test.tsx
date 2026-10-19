/** @vitest-environment jsdom */
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  desktopUpdateFixture,
  installFakeNativeUpdater,
} from '../components/desktop-update/__tests__/fakeNativeUpdater';
import { DesktopUpdateCheck } from '../views/settings/DesktopUpdateCheck';

const native = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: native.listen }));
vi.mock('../platform/PlatformProfileContext', () => ({
  usePlatformProfile: () => ({
    isDesktop: true,
    target: 'macos',
    supervisesBundledServer: true,
  }),
}));
vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://127.0.0.1:4141' }),
}));
vi.mock('../platform/useBundledServerStatus', () => ({
  useBundledServerStatus: () => ({
    ownership: 'sidecar',
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

async function mount(
  fixture: Parameters<typeof desktopUpdateFixture>[0],
  commandResults?: Parameters<typeof installFakeNativeUpdater>[2],
) {
  const fake = installFakeNativeUpdater(
    native,
    desktopUpdateFixture(fixture),
    commandResults,
  );
  render(<DesktopUpdateCheck />);
  await waitFor(() =>
    expect(screen.queryByText(/Reading the desktop/)).toBeNull(),
  );
  return fake;
}

describe('Desktop app updates settings card', () => {
  test('shows the persisted policy and saves a change natively', async () => {
    const fake = await mount('available');
    const select = screen.getByLabelText(
      'Automatic download',
    ) as HTMLSelectElement;
    expect(select.value).toBe('after-24h');
    expect(
      [...select.options].map((option) => [option.value, option.textContent]),
    ).toEqual([
      ['never', 'Never'],
      ['after-24h', 'After 24 hours'],
      ['immediately', 'Immediately'],
    ]);
    fireEvent.change(select, { target: { value: 'never' } });
    await waitFor(() =>
      expect(native.invoke).toHaveBeenCalledWith('desktop_update_set_policy', {
        policy: 'never',
      }),
    );
    // The select follows the native state, not the click.
    expect(select.value).toBe('after-24h');
    act(() =>
      fake.emit({
        ...desktopUpdateFixture('available'),
        policy: 'never',
        autoDownloadAt: null,
      }),
    );
    expect(select.value).toBe('never');
    expect(screen.getByRole('status').textContent).toMatch(
      /It downloads when you choose\./,
    );
  });

  test('a policy the native side could not save is reported', async () => {
    await mount('available', {
      desktop_update_set_policy: () =>
        Promise.reject(new Error('write desktop update settings: denied')),
    });
    fireEvent.change(screen.getByLabelText('Automatic download'), {
      target: { value: 'immediately' },
    });
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Station could not save the automatic download setting.',
    );
    expect(
      screen.getByText('write desktop update settings: denied'),
    ).not.toBeNull();
  });

  test('a manual check is requested and its failure disclosed', async () => {
    const fake = await mount('upToDate');
    fireEvent.click(
      screen.getByRole('button', { name: 'Check for desktop app updates' }),
    );
    await waitFor(() =>
      expect(fake.commands()).toEqual(['desktop_update_check']),
    );
    act(() => fake.emit(desktopUpdateFixture('checking')));
    expect(
      screen.getByRole('status', { name: 'Checking for desktop app updates' }),
    ).not.toBeNull();
    expect(
      (
        screen.getByRole('button', {
          name: /Check for desktop app updates/,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    act(() => fake.emit(desktopUpdateFixture('checkFailed')));
    expect(screen.getByRole('alert').textContent).toBe(
      'Could not check for desktop app updates.',
    );
    expect(screen.getByText('error sending request for url')).not.toBeNull();
  });

  test('shows download progress and only confirms before restarting', async () => {
    const fake = await mount('available');
    fireEvent.click(screen.getByRole('button', { name: 'Download update' }));
    await waitFor(() =>
      expect(fake.commands()).toEqual(['desktop_update_download']),
    );
    act(() => fake.emit(desktopUpdateFixture('downloading')));
    const progress = screen.getByRole('progressbar', {
      name: 'Downloading Station 0.1.12',
    }) as HTMLProgressElement;
    expect(progress.value).toBe(42);
    expect(screen.getByText(/40\.1 MB of 95\.4 MB/)).not.toBeNull();
    act(() => fake.emit(desktopUpdateFixture('ready')));
    fireEvent.click(screen.getByRole('button', { name: 'Restart to update…' }));
    expect(
      screen.getByRole('dialog', {
        name: 'Restart Station to install 0.1.12?',
      }),
    ).not.toBeNull();
    expect(fake.commands()).toEqual(['desktop_update_download']);
  });

  test('an unconfigured build offers no check, download or policy', async () => {
    await mount('disabled');
    expect(screen.getByRole('status').textContent).toMatch(
      /has no desktop update channel/,
    );
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByLabelText('Automatic download')).toBeNull();
  });

  test('download and install failures are disclosed with their text', async () => {
    const fake = await mount('downloadFailed');
    expect(screen.getByRole('alert').textContent).toBe(
      'The download did not complete.',
    );
    expect(
      screen.getByRole('button', { name: 'Retry download' }),
    ).not.toBeNull();
    act(() => fake.emit(desktopUpdateFixture('installFailed')));
    expect(screen.getByRole('alert').textContent).toBe(
      'The update did not install, and Station did not restart.',
    );
  });
});
