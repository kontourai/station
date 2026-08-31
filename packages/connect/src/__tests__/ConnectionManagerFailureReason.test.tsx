// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ConnectionHealthCheckResult } from '../core/ConnectionHealthCoordinator';
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

const checkCompatibleHost = async () => ({
  verdict: 'compatible' as const,
  blocking: false,
  reason: 'Station is compatible with this app.',
});

function renderWith(checkHealth: () => Promise<ConnectionHealthCheckResult>) {
  const store = new ConnectionStore({ storage: memoryAdapter() });
  const connection = store.add(
    'Remote Station',
    'https://station.example.test',
  );
  store.setActive(connection.id);
  render(
    <ConnectionsProvider store={store}>
      <ConnectionManagerModalContent
        onClose={vi.fn()}
        checkHealth={vi.fn(checkHealth)}
      />
    </ConnectionsProvider>,
  );
  return { store, connection };
}

function checkReachability() {
  fireEvent.click(
    screen.getByRole('button', { name: 'More actions for Remote Station' }),
  );
  fireEvent.click(screen.getByRole('menuitem', { name: 'Check reachability' }));
}

/**
 * The reason a failed check reports is what the user is told to go and fix, so
 * it is worth pinning at the component rather than only on the probe helper.
 *
 * These also guard the truthiness derivation. A failure result is an object and
 * every object is truthy, so a plausible-looking `const ok = !!result` would
 * record success on a failed check — and no test in this suite caught that,
 * because every other test supplies a bare boolean.
 */
describe('Connection Manager — failure reason recorded from the check result', () => {
  it('records the reason a failure result carries, not a blanket "unreachable"', async () => {
    const { store, connection } = renderWith(async () => ({
      ok: false,
      reason: 'authentication-failed',
    }));

    checkReachability();

    await waitFor(() => {
      const saved = store.getAll().find((item) => item.id === connection.id);
      expect(saved?.lastError?.reason).toBe('authentication-failed');
    });
  });

  it('still records "unreachable" when the check can only say false', async () => {
    const { store, connection } = renderWith(async () => false);

    checkReachability();

    await waitFor(() => {
      const saved = store.getAll().find((item) => item.id === connection.id);
      expect(saved?.lastError?.reason).toBe('unreachable');
    });
  });

  it('does not treat a falsy-ok result object as success', async () => {
    const { store, connection } = renderWith(async () => ({
      ok: false,
      reason: 'identity-mismatch',
    }));

    checkReachability();

    await waitFor(() => {
      const saved = store.getAll().find((item) => item.id === connection.id);
      // A success would clear lastError and stamp success evidence instead.
      expect(saved?.lastError?.reason).toBe('identity-mismatch');
    });
  });

  it('treats a bare true as success and clears the error', async () => {
    const { store, connection } = renderWith(async () => true);

    checkReachability();

    await waitFor(() => {
      const saved = store.getAll().find((item) => item.id === connection.id);
      expect(saved?.lastError).toBeUndefined();
    });
  });
});

describe('Connection Manager — profile selection failures', () => {
  it('keeps the current profile and surfaces native preparation failures', async () => {
    const store = new ConnectionStore({ storage: memoryAdapter() });
    const current = store.add(
      'Current Station',
      'https://current.station.example.test',
    );
    const next = store.add('Next Station', 'https://next.station.example.test');
    store.setActive(current.id);

    render(
      <ConnectionsProvider
        store={store}
        prepareActiveConnection={async (connectionId) => {
          if (connectionId === next.id) throw new Error('access denied');
        }}
      >
        <ConnectionManagerModalContent
          onClose={vi.fn()}
          checkHealth={vi.fn(async () => true)}
        />
      </ConnectionsProvider>,
    );

    fireEvent.click(screen.getByLabelText('Select Next Station'));

    expect(
      await screen.findByText('Could not switch Stations: access denied'),
    ).toBeTruthy();
    expect(store.getActive()?.id).toBe(current.id);
  });

  it('keeps manual add visible and retryable when host preparation rejects', async () => {
    const store = new ConnectionStore({ storage: memoryAdapter() });
    const current = store.add(
      'Current Station',
      'https://current.station.example.test',
    );
    const next = 'https://next.station.example.test';
    let rejectPreparation = true;

    render(
      <ConnectionsProvider
        store={store}
        prepareActiveConnection={async () => {
          if (rejectPreparation) throw new Error('native Station unavailable');
        }}
      >
        <ConnectionManagerModalContent
          onClose={vi.fn()}
          checkHealth={vi.fn(async () => true)}
          checkCompatibility={checkCompatibleHost}
          initialPanel="add"
        />
      </ConnectionsProvider>,
    );

    const address = screen.getByPlaceholderText(
      'https://station.example.ts.net',
    );
    fireEvent.change(address, { target: { value: next } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    expect(
      await screen.findByText(
        'Could not switch Stations: native Station unavailable',
      ),
    ).toBeTruthy();
    expect(store.getActive()?.id).toBe(current.id);
    expect(screen.getByRole('button', { name: 'Add' })).toBeTruthy();

    rejectPreparation = false;
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    await screen.findByRole('button', { name: 'Request access' });
    expect(store.getActive()?.url).toBe(next);
  });
});
