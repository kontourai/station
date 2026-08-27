// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ConnectionStore } from '../core/ConnectionStore';
import type { StorageAdapter } from '../core/types';
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

function renderRepair(options: { withConnection: boolean }) {
  const store = new ConnectionStore({ storage: memoryAdapter() });
  const connection = options.withConnection
    ? store.add('Living Room Mac', 'https://station.example.test')
    : null;
  if (connection) store.setActive(connection.id);
  render(
    <ConnectionsProvider store={store}>
      <ConnectionManagerModalContent
        onClose={vi.fn()}
        checkHealth={vi.fn(async () => false)}
        initialPanel="request-access"
      />
    </ConnectionsProvider>,
  );
  return { store, connection };
}

/**
 * station#3297 — "re-pairing is reachable in one tap from the indicator".
 *
 * One tap only counts if the panel it lands on is already pointed at the
 * connection that failed. An untargeted `request-access` panel is the
 * FIRST-RUN shape: it asks for a host address, which is strictly worse than
 * the list the tap was meant to skip.
 */
describe('Connection Manager opened straight into re-pairing', () => {
  it('targets the active connection, so the reader has nothing left to choose', () => {
    renderRepair({ withConnection: true });

    expect(
      screen.getByRole('heading', { name: 'Request Access' }),
    ).toBeTruthy();
    // The target is named on the panel rather than requested from the reader.
    expect(screen.getAllByText(/Living Room Mac/).length).toBeGreaterThan(0);
    // And the address entry the untargeted flow opens with is absent.
    expect(
      screen.queryByPlaceholderText(/station\.local|https?:\/\//i),
    ).toBeNull();
  });

  it('falls back to the list rather than opening a panel it cannot target', () => {
    // With no active connection there is nothing to re-pair. Opening the
    // first-run address prompt from a "re-pair me" tap would be a screen that
    // cannot do the job it was asked to do.
    renderRepair({ withConnection: false });

    expect(screen.getByRole('heading', { name: 'Stations' })).toBeTruthy();
    expect(
      screen.queryByRole('heading', { name: 'Request Access' }),
    ).toBeNull();
  });
});
