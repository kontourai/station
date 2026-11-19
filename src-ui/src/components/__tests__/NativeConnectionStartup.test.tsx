/** @vitest-environment jsdom */

import { act, cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, expect, test, vi } from 'vitest';

vi.mock('../../platform/PlatformProfileContext', () => ({
  usePlatformProfile: () => ({ isMobile: true }),
}));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

test('a stalled pairing chunk leaves the phone welcome behind a reload action', async () => {
  vi.useFakeTimers();
  vi.resetModules();
  const { NativeConnectionStartup } = await import(
    '../NativeConnectionStartup'
  );
  type PairingModule = {
    default: ({ children }: { children: ReactNode }) => ReactNode;
  };
  let resolveModule!: (module: PairingModule) => void;
  const module = new Promise<PairingModule>((resolve) => {
    resolveModule = resolve;
  });
  const load = vi.fn(() => module);
  render(
    <NativeConnectionStartup load={load} nonMobileRecovery={null}>
      <button type="button">Enter a pairing code</button>
    </NativeConnectionStartup>,
  );
  expect(load).toHaveBeenCalledOnce();
  expect(
    screen.queryByRole('button', { name: 'Enter a pairing code' }),
  ).toBeNull();
  await act(async () => vi.advanceTimersByTimeAsync(30_000));
  expect(screen.getByRole('alert').textContent).toBe(
    'Station pairing controls didn’t load.',
  );
  expect(screen.getByRole('button', { name: 'Reload Station' })).toBeTruthy();

  await act(async () => resolveModule({ default: ({ children }) => children }));
  expect(
    screen.queryByRole('button', { name: 'Enter a pairing code' }),
  ).toBeNull();
});
