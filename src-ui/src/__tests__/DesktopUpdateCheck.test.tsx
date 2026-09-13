/** @vitest-environment jsdom */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { DesktopUpdateCheck } from '../views/settings/DesktopUpdateCheck';

const { check, downloadAndInstall, relaunch } = vi.hoisted(() => ({
  check: vi.fn(),
  downloadAndInstall: vi.fn(),
  relaunch: vi.fn(),
}));
vi.mock('@tauri-apps/plugin-updater', () => ({ check }));
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch }));

beforeEach(() => vi.resetAllMocks());

function mount() {
  const client = new QueryClient();
  const view = render(
    <QueryClientProvider client={client}>
      <DesktopUpdateCheck />
    </QueryClientProvider>,
  );
  fireEvent.click(
    screen.getByRole('button', { name: 'Check for Desktop Updates' }),
  );
  return view;
}

test('releases replaced native update handles and the final handle on unmount', async () => {
  const closeFirst = vi.fn();
  const closeSecond = vi.fn();
  check
    .mockResolvedValueOnce({
      version: 'first',
      downloadAndInstall,
      close: closeFirst,
    })
    .mockResolvedValueOnce({
      version: 'second',
      downloadAndInstall,
      close: closeSecond,
    });
  const view = mount();
  await screen.findByText('Station first is available.');
  fireEvent.click(
    screen.getByRole('button', { name: 'Check for Desktop Updates' }),
  );
  await screen.findByText('Station second is available.');
  await waitFor(() => expect(closeFirst).toHaveBeenCalledOnce());
  expect(closeSecond).not.toHaveBeenCalled();
  view.unmount();
  await waitFor(() => expect(closeSecond).toHaveBeenCalledOnce());
});

test('releases an update returned after Settings has unmounted', async () => {
  let resolveCheck!: (value: unknown) => void;
  check.mockReturnValue(
    new Promise((resolve) => {
      resolveCheck = resolve;
    }),
  );
  const close = vi.fn();
  const view = mount();
  await waitFor(() => expect(check).toHaveBeenCalledOnce());
  view.unmount();
  resolveCheck({ version: 'late', downloadAndInstall, close });
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
});

test('unmount does not close a native handle while installation is pending', async () => {
  let finish!: () => void;
  downloadAndInstall.mockReturnValue(
    new Promise<void>((resolve) => {
      finish = resolve;
    }),
  );
  const close = vi.fn();
  check.mockResolvedValue({ version: 'next', downloadAndInstall, close });
  const view = mount();
  fireEvent.click(
    await screen.findByRole('button', { name: 'Install and restart' }),
  );
  await waitFor(() => expect(downloadAndInstall).toHaveBeenCalledOnce());
  view.unmount();
  expect(close).not.toHaveBeenCalled();
  finish();
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(relaunch).toHaveBeenCalledOnce();
});

test('checks the native channel and installs before relaunching', async () => {
  check.mockResolvedValue({
    version: '0.1.11-nightly.2443.1',
    downloadAndInstall,
    close: vi.fn(),
  });
  mount();
  fireEvent.click(
    await screen.findByRole('button', { name: 'Install and restart' }),
  );
  await waitFor(() => expect(relaunch).toHaveBeenCalledOnce());
  expect(check).toHaveBeenCalledWith({ timeout: 15_000 });
  expect(downloadAndInstall).toHaveBeenCalledOnce();
  expect(downloadAndInstall.mock.invocationCallOrder[0]).toBeLessThan(
    relaunch.mock.invocationCallOrder[0],
  );
});

test('reports a failed channel check and allows a successful retry', async () => {
  check.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(null);
  mount();
  expect((await screen.findByRole('alert')).textContent).toContain(
    'Could not check',
  );
  fireEvent.click(
    screen.getByRole('button', { name: 'Check for Desktop Updates' }),
  );
  expect((await screen.findByRole('status')).textContent).toContain(
    'up to date',
  );
  expect(screen.queryByRole('alert')).toBeNull();
});

test('a check failure discloses its real diagnostic text without classifying it', async () => {
  check.mockRejectedValue(new Error('updater stream broken: TLS cert expired'));
  mount();
  expect((await screen.findByRole('alert')).textContent).toBe(
    'Could not check for desktop app updates. Try again or view technical details.',
  );
  // The UI cannot tell offline from no-channel from a bad signature, so it
  // must not claim any of them (D6 replaces the old classified copy).
  expect(
    screen.queryByText(/may not have an update channel configured/),
  ).toBeNull();
  expect(screen.queryByText(/Check your connection/)).toBeNull();
  // The caught message survives verbatim inside the disclosure.
  fireEvent.click(screen.getByText('Technical details'));
  expect(
    screen.getByText('updater stream broken: TLS cert expired'),
  ).toBeTruthy();
});

test('a non-Error check failure is captured verbatim, not classified', async () => {
  check.mockRejectedValue('updater plugin missing');
  mount();
  await screen.findByRole('alert');
  // The adapter stringifies whatever it caught; the UI discloses it without
  // inventing a classification the adapter never made.
  fireEvent.click(screen.getByText('Technical details'));
  expect(screen.getByText('updater plugin missing')).toBeTruthy();
});

test('failed installation never relaunches and can be retried', async () => {
  check.mockResolvedValue({
    version: 'next',
    downloadAndInstall,
    close: vi.fn(),
  });
  downloadAndInstall
    .mockRejectedValueOnce(new Error('signature invalid'))
    .mockResolvedValueOnce(undefined);
  mount();
  fireEvent.click(
    await screen.findByRole('button', { name: 'Install and restart' }),
  );
  await screen.findByRole('alert');
  // D7: a failed install claims neither success nor restart, and it shows the
  // real error instead of a generic retry line.
  expect(screen.getByRole('alert').textContent).toBe(
    'The desktop update did not complete. View technical details before retrying.',
  );
  expect(screen.queryByText(/restarted successfully/i)).toBeNull();
  expect(screen.queryByText(/installed successfully/i)).toBeNull();
  expect(relaunch).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('Technical details'));
  expect(screen.getByText('signature invalid')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Install and restart' }));
  await waitFor(() => expect(relaunch).toHaveBeenCalledOnce());
});
