// @vitest-environment jsdom

import { PUBLIC_STATION_HANDSHAKE_PATH } from '@kontourai/station-contracts';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionHealthCheckResult } from '../core/ConnectionHealthCoordinator';
import { ConnectionStore } from '../core/ConnectionStore';
import type { SavedConnection, StorageAdapter } from '../core/types';
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

const HANDSHAKE_PATHNAME = new URL(
  PUBLIC_STATION_HANDSHAKE_PATH,
  'https://placeholder.test',
).pathname;

const respondAsStation = async (url: URL) =>
  Response.json({
    environmentId: `environment-${url.hostname}`,
    authentication: { scheme: 'bearer', protocolVersion: 1 },
  });

/**
 * Every check the manager runs starts with the unauthenticated public
 * handshake, which the component fetches itself. Left unstubbed, that is a
 * real network request to a `.test` host whose DNS failure lands whenever the
 * resolver gets round to it — on a loaded runner, after this file's jsdom
 * environment was torn down, where the flow's next `setState` reads `window`
 * and reds the whole shard with "window is not defined" while every test
 * passes. Answer the handshake hermetically instead, and refuse anything the
 * fixture does not model rather than returning an empty success.
 */
function stubPublicHandshake(
  respond: (url: URL) => Promise<Response> = respondAsStation,
) {
  const fetchMock = vi.fn(async (input: URL | string) => {
    const url = new URL(String(input));
    if (url.pathname === HANDSHAKE_PATHNAME) return respond(url);
    throw new Error(`unmodeled fixture request: ${url.href}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  stubPublicHandshake();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderWith(
  checkHealth: () => Promise<ConnectionHealthCheckResult>,
  seed?: (store: ConnectionStore, connection: SavedConnection) => void,
) {
  const store = new ConnectionStore({ storage: memoryAdapter() });
  const connection = store.add(
    'Remote Station',
    'https://station.example.test',
  );
  store.setActive(connection.id);
  seed?.(store, connection);
  const { unmount } = render(
    <ConnectionsProvider store={store}>
      <ConnectionManagerModalContent
        onClose={vi.fn()}
        checkHealth={vi.fn(checkHealth)}
      />
    </ConnectionsProvider>,
  );
  return { store, connection, unmount };
}

function checkReachability() {
  fireEvent.click(
    screen.getByRole('button', { name: 'More actions for Remote Station' }),
  );
  fireEvent.click(screen.getByRole('menuitem', { name: 'Check reachability' }));
}

const savedIn = (store: ConnectionStore, id: string) =>
  store.getAll().find((item) => item.id === id);

/**
 * The reason a failed check reports is what the user is told to go and fix, so
 * it is worth pinning at the component rather than only on the probe helper.
 *
 * These also guard the truthiness derivation. A failure result is an object and
 * every object is truthy, so a plausible-looking `const ok = !!result` would
 * record success on a failed check — and no test in this suite caught that,
 * because every other test supplies a bare boolean.
 *
 * Every case waits for the check's TERMINAL store write (the failure record,
 * or the success stamp that retires it). An assertion satisfied by an earlier
 * state leaves the rest of the flow running after the test — and after the
 * file — has finished.
 */
describe('Connection Manager — failure reason recorded from the check result', () => {
  it('records the reason a failure result carries, not a blanket "unreachable"', async () => {
    const { store, connection } = renderWith(async () => ({
      ok: false,
      reason: 'authentication-failed',
    }));

    checkReachability();

    await waitFor(() => {
      expect(savedIn(store, connection.id)?.lastError?.reason).toBe(
        'authentication-failed',
      );
    });
  });

  it('still records "unreachable" when the check can only say false', async () => {
    const { store, connection } = renderWith(async () => false);

    checkReachability();

    await waitFor(() => {
      expect(savedIn(store, connection.id)?.lastError?.reason).toBe(
        'unreachable',
      );
    });
  });

  it('does not treat a falsy-ok result object as success', async () => {
    const { store, connection } = renderWith(async () => ({
      ok: false,
      reason: 'identity-mismatch',
    }));

    checkReachability();

    await waitFor(() => {
      // A success would clear lastError and stamp success evidence instead.
      expect(savedIn(store, connection.id)?.lastError?.reason).toBe(
        'identity-mismatch',
      );
    });
  });

  it('treats a bare true as success and clears the error', async () => {
    // Start from a recorded failure: a connection that never had `lastError`
    // satisfies "cleared" before the check has even started, which is how the
    // previous form of this test passed without the flow reaching its end.
    const { store, connection } = renderWith(
      async () => true,
      (seedStore, seedConnection) =>
        seedStore.recordEndpointFailure(seedConnection.id, 'unreachable'),
    );
    expect(savedIn(store, connection.id)?.lastError?.reason).toBe(
      'unreachable',
    );

    checkReachability();

    await waitFor(() => {
      const saved = savedIn(store, connection.id);
      expect(saved?.lastSuccessAt).toBeDefined();
      expect(saved?.lastError).toBeUndefined();
    });
  });

  it('tells the user a host that fails the public handshake could not be verified, and still records the check result', async () => {
    stubPublicHandshake(async () => {
      throw new TypeError('fetch failed');
    });
    const { store, connection } = renderWith(async () => ({
      ok: false,
      reason: 'authentication-failed',
    }));

    checkReachability();

    await waitFor(() => {
      expect(savedIn(store, connection.id)?.lastError?.reason).toBe(
        'authentication-failed',
      );
    });
    expect(
      screen.getByText(
        'Could not verify Remote Station as a Station. Check its address and Station version, then try again.',
      ),
    ).toBeTruthy();
  });
});

describe('Connection Manager — a check started before the manager closes', () => {
  it('still records its evidence in the store after unmount', async () => {
    // The pairing paths close the manager and only then start the health
    // check, so completing after unmount is the ordinary case for this flow,
    // not an edge: the store must still learn the outcome. Only the manager's
    // own state updates are skipped once it is gone.
    let finishHandshake: (() => void) | undefined;
    stubPublicHandshake(
      (url) =>
        new Promise((resolve) => {
          finishHandshake = () => resolve(respondAsStation(url));
        }),
    );
    const { store, connection, unmount } = renderWith(async () => true);

    checkReachability();
    await waitFor(() => expect(finishHandshake).toBeDefined());
    unmount();
    finishHandshake?.();

    await waitFor(() => {
      const saved = savedIn(store, connection.id);
      expect(saved?.environmentId).toBe('environment-station.example.test');
      expect(saved?.lastSuccessAt).toBeDefined();
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
    // Adding also starts the new Station's health check. Wait for its terminal
    // store write: this is the last test in the file, and a check that is
    // still in flight here is exactly the one that outlives the environment.
    await waitFor(() => {
      expect(
        store.getAll().find((item) => item.url === next)?.lastSuccessAt,
      ).toBeDefined();
    });
  });
});
