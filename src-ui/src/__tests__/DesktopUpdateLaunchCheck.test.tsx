/** @vitest-environment jsdom */
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

let isDesktop = true;

const check = vi.fn();
const downloadAndInstall = vi.fn();
const relaunch = vi.fn();

vi.mock('@tauri-apps/plugin-updater', () => ({
  check: (...args: unknown[]) => check(...args),
}));
vi.mock('@tauri-apps/plugin-process', () => ({
  relaunch: (...args: unknown[]) => relaunch(...args),
}));
vi.mock('../platform/PlatformProfileContext', () => ({
  usePlatformProfile: () => ({ isDesktop }),
}));

const { DesktopUpdateLaunchCheck } = await import(
  '../components/DesktopUpdateLaunchCheck'
);
const { BannerHost } = await import('../components/notifications/BannerHost');
const { BANNER_IDS, bannerStore } = await import('../contexts/banner-store');

/**
 * Update state is chrome: it must reach the user through the shell's banner
 * slot, mirroring `CoreUpdateLaunchCheck.test.tsx`.
 */
function renderWithChrome() {
  return render(
    <>
      <DesktopUpdateLaunchCheck />
      <BannerHost />
    </>,
  );
}

describe('DesktopUpdateLaunchCheck', () => {
  beforeEach(() => {
    isDesktop = true;
    check.mockReset();
    downloadAndInstall.mockReset();
    relaunch.mockReset();
    bannerStore.clear();
  });

  afterEach(() => {
    bannerStore.clear();
  });

  test('renders nothing outside the desktop native shell', async () => {
    isDesktop = false;
    renderWithChrome();
    await waitFor(() => expect(check).not.toHaveBeenCalled());
    expect(bannerStore.getSnapshot()).toHaveLength(0);
  });

  test('presents the banner with the version when an update is available', async () => {
    check.mockResolvedValue({ version: '2026.8.28', downloadAndInstall });
    renderWithChrome();
    expect((await screen.findByRole('status')).textContent).toContain(
      'Station 2026.8.28 is available.',
    );
  });

  test('renders nothing when no update is available', async () => {
    check.mockResolvedValue(null);
    renderWithChrome();
    await waitFor(() => expect(check).toHaveBeenCalledOnce());
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('stays quiet on a failed check — indistinguishable from no update channel', async () => {
    check.mockRejectedValue(new Error('offline'));
    renderWithChrome();
    await waitFor(() => expect(check).toHaveBeenCalledOnce());
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(bannerStore.getSnapshot()).toHaveLength(0);
  });

  test('install calls downloadAndInstall then relaunch, in order', async () => {
    const calls: string[] = [];
    downloadAndInstall.mockImplementation(async () => {
      calls.push('downloadAndInstall');
    });
    relaunch.mockImplementation(async () => {
      calls.push('relaunch');
    });
    check.mockResolvedValue({ version: '2026.8.28', downloadAndInstall });
    renderWithChrome();

    fireEvent.click(
      await screen.findByRole('button', { name: 'Install and restart' }),
    );

    await waitFor(() => expect(relaunch).toHaveBeenCalledOnce());
    expect(calls).toEqual(['downloadAndInstall', 'relaunch']);
  });

  test('shows an honest error state when install fails', async () => {
    downloadAndInstall.mockRejectedValue(new Error('signature check failed'));
    check.mockResolvedValue({ version: '2026.8.28', downloadAndInstall });
    renderWithChrome();

    fireEvent.click(
      await screen.findByRole('button', { name: 'Install and restart' }),
    );

    // Two banners now stack (the update-available notice and the new
    // install-failure alert); the host caps the visible stack, so expand it
    // before asserting on both.
    await waitFor(() =>
      expect(screen.getByTestId('banner-stack-cap')).toBeTruthy(),
    );
    fireEvent.click(screen.getByTestId('banner-stack-cap'));
    const host = screen.getByTestId('banner-host');

    expect(within(host).getByRole('alert').textContent).toContain(
      'signature check failed',
    );
    expect(relaunch).not.toHaveBeenCalled();
    // The update-available banner stays up alongside the error — the update
    // is still there even though the last install attempt failed.
    expect(within(host).getByRole('status').textContent).toContain(
      'Station 2026.8.28 is available.',
    );
  });

  test('re-presents an install failure on retry even after the user dismissed the same message', async () => {
    // Regression for station#575 review HIGH-1: `bannerStore` durably
    // suppresses a re-`present`ed (id, occurrence) pair after the user
    // dismisses it. Keying the failure banner's occurrence on the error
    // message ALONE meant a genuine retry that failed with the identical
    // message (the common case — the same signature/network problem)
    // presented nothing, durably across restarts: install-attempted=1,
    // failureBannerShown=false, no way back short of clearing storage.
    downloadAndInstall.mockRejectedValue(new Error('signature check failed'));
    check.mockResolvedValue({ version: '2026.8.28', downloadAndInstall });
    renderWithChrome();

    fireEvent.click(
      await screen.findByRole('button', { name: 'Install and restart' }),
    );
    await waitFor(() => expect(downloadAndInstall).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(
        bannerStore
          .getSnapshot()
          .some(
            (banner) => banner.id === BANNER_IDS.desktopUpdateInstallFailure,
          ),
      ).toBe(true),
    );

    // Dismiss exactly the way the banner host's own dismiss control does.
    bannerStore.dismiss(BANNER_IDS.desktopUpdateInstallFailure, {
      reason: 'user',
    });
    await waitFor(() =>
      expect(
        bannerStore
          .getSnapshot()
          .some(
            (banner) => banner.id === BANNER_IDS.desktopUpdateInstallFailure,
          ),
      ).toBe(false),
    );

    // Retry — the same underlying failure, the same message.
    fireEvent.click(
      await screen.findByRole('button', { name: 'Install and restart' }),
    );
    await waitFor(() => expect(downloadAndInstall).toHaveBeenCalledTimes(2));

    await waitFor(() =>
      expect(
        bannerStore
          .getSnapshot()
          .some(
            (banner) => banner.id === BANNER_IDS.desktopUpdateInstallFailure,
          ),
      ).toBe(true),
    );
  });
});
