// @vitest-environment jsdom

/**
 * The desktop-supervised local server ("Station on this device") is always
 * listed on a supervising desktop, carrying its lifecycle state even when it is
 * not running — non-removable, non-editable, and offering a Restart control
 * while down. These tests exercise the modal list rendering of that injected
 * connection; the store-level composition lives in ConnectionStore.test.ts and
 * the injection lifecycle in ApiBaseContext.managed-loopback.test.tsx.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ConnectionStore } from '../core/ConnectionStore';
import type { InjectedConnection, StorageAdapter } from '../core/types';
import { ConnectionManagerModalContent } from '../react/ConnectionManagerModalContent';
import { ConnectionsProvider } from '../react/ConnectionsContext';

function memoryAdapter(): StorageAdapter {
  const values: Record<string, string> = {};
  return {
    get: (key) => values[key] ?? null,
    set: (key, value) => {
      values[key] = value;
    },
    remove: (key) => {
      delete values[key];
    },
  };
}

function renderModal(
  injectedConnection: InjectedConnection | null,
  onRestart?: () => void,
) {
  // Each render gets its own isolated store (no shared-singleton bleed); the
  // provider folds `injectedConnection` into it exactly as the app does.
  const store = new ConnectionStore({ storage: memoryAdapter() });
  render(
    <ConnectionsProvider store={store} injectedConnection={injectedConnection}>
      <ConnectionManagerModalContent
        onClose={vi.fn()}
        checkHealth={vi.fn(async () => false)}
        onRestartInjectedConnection={onRestart}
      />
    </ConnectionsProvider>,
  );
}

const notRunning: InjectedConnection = {
  id: 'managed-loopback',
  name: 'Station on this device',
  source: 'managed-loopback',
  status: 'failed',
};

describe('Connection Manager — injected local-server row', () => {
  it('lists the local server with its state and a Restart control when it is not running', () => {
    const onRestart = vi.fn();
    renderModal(notRunning, onRestart);

    expect(screen.getByText('Station on this device')).toBeTruthy();
    expect(screen.getByText('Failed to start')).toBeTruthy();

    const restart = screen.getByRole('button', { name: 'Restart' });
    fireEvent.click(restart);
    expect(onRestart).toHaveBeenCalledTimes(1);
  });

  it('is non-editable and non-removable (no edit/remove/check affordances)', () => {
    renderModal(notRunning, vi.fn());
    // The injected row is the only connection in the list, so the absence of
    // these controls proves the local server exposes none of them.
    expect(screen.queryByLabelText('Edit Station')).toBeNull();
    expect(screen.queryByLabelText('Forget Station')).toBeNull();
    expect(screen.queryByLabelText('Check reachability')).toBeNull();
  });

  it('surfaces each non-running lifecycle state in its own words', () => {
    renderModal({ ...notRunning, status: 'starting' }, vi.fn());
    expect(screen.getByText('Starting…')).toBeTruthy();
  });

  it('drives the status dot from the lifecycle state — failed → error dot', () => {
    renderModal(notRunning, vi.fn());
    expect(screen.getByLabelText('error')).toBeTruthy();
  });

  it('shows a neutral idle dot when the local server is stopped', () => {
    renderModal({ ...notRunning, status: 'stopped' }, vi.fn());
    expect(screen.getByLabelText('idle')).toBeTruthy();
  });

  it('shows the URL and no Restart control once the server is running', () => {
    renderModal(
      {
        id: 'managed-loopback',
        name: 'Station on this device',
        source: 'managed-loopback',
        status: 'running',
        url: 'http://127.0.0.1:3200',
      },
      vi.fn(),
    );

    expect(screen.getByText('http://127.0.0.1:3200')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Restart' })).toBeNull();
  });

  it('omits the Restart control when no restart handler is wired (web/mobile parity)', () => {
    renderModal(notRunning);
    // The state is still shown, but there is nothing to restart from here.
    expect(screen.getByText('Failed to start')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Restart' })).toBeNull();
  });
});
