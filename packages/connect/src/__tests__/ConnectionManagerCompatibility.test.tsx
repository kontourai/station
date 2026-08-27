// @vitest-environment jsdom

import type { StationCompatibilityResult } from '@kontourai/station-contracts';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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

function renderManager(
  checkCompatibility?: () => Promise<StationCompatibilityResult>,
) {
  const store = new ConnectionStore({ storage: memoryAdapter() });
  render(
    <ConnectionsProvider store={store}>
      <ConnectionManagerModalContent
        onClose={vi.fn()}
        checkHealth={vi.fn(async () => true)}
        {...(checkCompatibility
          ? { checkCompatibility: vi.fn(checkCompatibility) }
          : {})}
        initialPanel="add"
      />
    </ConnectionsProvider>,
  );
  return store;
}

function typeHost(url = 'https://station.example.test') {
  fireEvent.change(
    screen.getByPlaceholderText('https://station.example.ts.net'),
    { target: { value: url } },
  );
  fireEvent.click(screen.getByRole('button', { name: 'Add' }));
}

/**
 * The point of the pre-commit check: a host that this client cannot talk to
 * must never become a saved connection the user then has to debug. A host that
 * cannot prove the contract, or an embedding that omits the checker, is an
 * actionable block rather than a silent pre-contract escape hatch.
 */
describe('Connection Manager — compatibility verdict before the host is saved', () => {
  it('refuses to save a host that is too new for this client, and says which side to update', async () => {
    const store = renderManager(async () => ({
      verdict: 'client-too-old',
      blocking: true,
      reason: 'Update this app. Install the latest Station app on this device.',
      serverVersion: '9.9.9',
    }));

    typeHost();

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toMatch(
        /Install the latest Station app/,
      );
    });
    expect(screen.getByRole('alert').textContent).toMatch(
      /This app is too old for that host/,
    );
    expect(store.getAll()).toHaveLength(0);
  });

  it('refuses to save a host that is too old, and points at the host', async () => {
    const store = renderManager(async () => ({
      verdict: 'server-too-old',
      blocking: true,
      reason: 'Update the Station host. Upgrade Station on the host machine.',
      serverVersion: '0.1.0',
    }));

    typeHost();

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toMatch(
        /Upgrade Station on the host machine/,
      );
    });
    expect(screen.getByRole('alert').textContent).toMatch(
      /That host is too old for this app/,
    );
    expect(store.getAll()).toHaveLength(0);
  });

  it('does not save a host whose compatibility declaration is missing', async () => {
    const store = renderManager(async () => ({
      verdict: 'unknown',
      blocking: true,
      reason:
        'Station compatibility could not be verified because this host did not provide a valid compatibility declaration. Update Station on the host, then try connecting again.',
    }));

    typeHost();

    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toMatch(
        /compatibility could not be verified/i,
      );
    });
    expect(store.getAll()).toHaveLength(0);
  });

  it('does not trust a non-blocking unknown verdict from an outdated checker', async () => {
    const store = renderManager(async () => ({
      verdict: 'unknown',
      blocking: false,
      reason: 'Station compatibility could not be verified.',
    }));

    typeHost();

    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toMatch(
        /compatibility could not be verified/i,
      );
    });
    expect(store.getAll()).toHaveLength(0);
  });

  it('stays quiet on a compatible host', async () => {
    const store = renderManager(async () => ({
      verdict: 'compatible',
      blocking: false,
      reason: 'Station 0.4.1 is compatible with this app.',
      serverVersion: '0.4.1',
    }));

    typeHost();

    await waitFor(() => expect(store.getAll()).toHaveLength(1));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('blocks an embedding that omits the required compatibility checker', async () => {
    const store = renderManager();

    typeHost();

    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toMatch(
        /compatibility checking is unavailable/i,
      );
    });
    expect(store.getAll()).toHaveLength(0);
  });

  it('does not save a host when compatibility verification throws, and explains recovery', async () => {
    const store = renderManager(async () => {
      throw new Error('check exploded');
    });

    typeHost();

    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toMatch(
        /compatibility could not be verified/i,
      );
    });
    expect(screen.getByRole('status').textContent).toMatch(
      /Check reachability to this Station and try again/i,
    );
    expect(store.getAll()).toHaveLength(0);
  });
});
