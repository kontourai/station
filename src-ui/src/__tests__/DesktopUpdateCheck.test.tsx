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
  render(
    <QueryClientProvider client={client}>
      <DesktopUpdateCheck />
    </QueryClientProvider>,
  );
  fireEvent.click(
    screen.getByRole('button', { name: 'Check for Desktop Updates' }),
  );
}

test('checks the native channel and installs before relaunching', async () => {
  check.mockResolvedValue({
    version: '0.1.11-nightly.2443.1',
    downloadAndInstall,
  });
  mount();
  fireEvent.click(
    await screen.findByRole('button', { name: 'Install and restart' }),
  );
  await waitFor(() => expect(relaunch).toHaveBeenCalledOnce());
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

test('failed installation never relaunches and can be retried', async () => {
  check.mockResolvedValue({ version: 'next', downloadAndInstall });
  downloadAndInstall
    .mockRejectedValueOnce(new Error('signature invalid'))
    .mockResolvedValueOnce(undefined);
  mount();
  fireEvent.click(
    await screen.findByRole('button', { name: 'Install and restart' }),
  );
  await screen.findByRole('alert');
  expect(relaunch).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Install and restart' }));
  await waitFor(() => expect(relaunch).toHaveBeenCalledOnce());
});
