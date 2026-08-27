// @vitest-environment jsdom

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ConnectionStore } from '../core/ConnectionStore';
import { registerConnectionCandidateProvider } from '../core/connectionCandidates';
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

function setup() {
  const store = new ConnectionStore({ storage: memoryAdapter() });
  const connection = store.add(
    'Remote Station',
    'https://station.example.test',
  );
  render(
    <ConnectionsProvider store={store}>
      <ConnectionManagerModalContent
        onClose={vi.fn()}
        checkHealth={vi.fn(async () => false)}
        checkCompatibility={checkCompatibleHost}
      />
    </ConnectionsProvider>,
  );
  return { store, connection };
}

describe('Connection Manager credential recovery', () => {
  it('adding a Station continues straight into authorising it, and closes into the connected workspace once approved', async () => {
    // Folds #986's two-button flow into one: a successful add no longer
    // strands a saved-but-unauthorised connection behind a separate
    // top-level "Request access" button — it carries straight into the same
    // pairing exchange `handlePaired` uses for a fresh QR/manual pairing.
    const store = new ConnectionStore({ storage: memoryAdapter() });
    const onClose = vi.fn();
    const commitVerifiedPairing = vi.fn(async () => undefined);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: URL | RequestInfo) => {
        const path = new URL(String(input)).pathname;
        if (path === '/.well-known/station/v1/pairing/access-request') {
          return Response.json(
            {
              environmentId: 'environment-workspace',
              offerId: 'offer-workspace',
              proof: 'proof-workspace',
              requestId: 'request-workspace',
              expiresAt: Date.now() + 60_000,
            },
            { status: 202 },
          );
        }
        if (path === '/.well-known/station/v1/pairing/exchange') {
          return Response.json({
            environmentId: 'environment-workspace',
            device: {
              id: 'device-workspace',
              name: 'This browser',
              scope: 'station:interactive',
              createdAt: Date.now(),
              revokedAt: null,
            },
            delivery: 'browser-cookie',
          });
        }
        // checkOne's incidental public-handshake probe after the add; not
        // relevant to this flow. Let it fail closed like an unreachable
        // older host would — checkOne already tolerates that.
        throw new Error(`Unexpected fetch: ${path}`);
      }),
    );

    render(
      <ConnectionsProvider
        store={store}
        commitVerifiedPairing={commitVerifiedPairing}
      >
        <ConnectionManagerModalContent
          onClose={onClose}
          checkHealth={vi.fn(async () => true)}
          checkCompatibility={checkCompatibleHost}
          initialPanel="add"
        />
      </ConnectionsProvider>,
    );

    fireEvent.change(
      screen.getByPlaceholderText('https://station.example.ts.net'),
      { target: { value: window.location.origin } },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    fireEvent.click(
      await screen.findByRole('button', { name: 'Request access' }),
    );

    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    // Exactly the connection just added gained the credential — pairing did
    // not create a second, separate "Paired Station" entry alongside it.
    expect(store.getAll()).toHaveLength(1);
    expect(store.getAll()[0].name).toBe(window.location.origin);
    expect(store.getActive()?.environmentId).toBe('environment-workspace');
    expect(commitVerifiedPairing).toHaveBeenCalledWith({
      clientInstanceId: expect.any(String),
      connectionId: store.getAll()[0].id,
      name: window.location.origin,
      endpoint: window.location.origin,
      handshake: {
        environmentId: 'environment-workspace',
        authentication: { scheme: 'bearer', protocolVersion: 1 },
      },
    });
    vi.unstubAllGlobals();
  });

  it('shows a per-connection request-access affordance naming the host, only where access is missing', () => {
    const store = new ConnectionStore({ storage: memoryAdapter() });
    store.add('Remote Station', 'https://station.example.test');
    const working = store.add('Home Server', 'https://home.example.test');
    store.setCredential(working.id, 'a-working-credential');

    render(
      <ConnectionsProvider store={store}>
        <ConnectionManagerModalContent
          onClose={vi.fn()}
          checkHealth={vi.fn(async () => true)}
          checkCompatibility={checkCompatibleHost}
        />
      </ConnectionsProvider>,
    );

    expect(
      screen.getByRole('button', { name: 'Request access to Remote Station' }),
    ).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: 'Request access to Home Server' }),
    ).toBeNull();
    // The replaced global button must be gone entirely, not just relabeled.
    expect(
      screen.queryByRole('button', {
        name: 'Request access to this Station',
      }),
    ).toBeNull();
  });

  it('routes a saved Station request-access click into the same named flow, with its host', async () => {
    const store = new ConnectionStore({ storage: memoryAdapter() });
    store.add('Remote Station', 'https://station.example.test');

    render(
      <ConnectionsProvider store={store}>
        <ConnectionManagerModalContent
          onClose={vi.fn()}
          checkHealth={vi.fn(async () => true)}
          checkCompatibility={checkCompatibleHost}
        />
      </ConnectionsProvider>,
    );

    fireEvent.click(
      screen.getByRole('button', { name: 'Request access to Remote Station' }),
    );

    expect(
      await screen.findByText(/Send a short-lived request to Remote Station\./),
    ).toBeTruthy();
    // The panel already knows the target host — it must never ask the user
    // to type (or disambiguate) an address it already has.
    expect(screen.queryByLabelText('Station server address')).toBeNull();
  });

  it('keeps authorization visible when the host persistence callback rejects', async () => {
    const store = new ConnectionStore({ storage: memoryAdapter() });
    const current = store.add(
      'Current Station',
      'https://current.example.test',
    );
    store.setCredential(current.id, 'current-credential');
    const target = store.add('Remote Station', 'https://station.example.test');
    store.setActive(current.id);
    const onClose = vi.fn();
    const commitVerifiedPairing = vi.fn(async () => {
      throw new Error('keyring write failed');
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: URL | RequestInfo) => {
        const path = new URL(String(input)).pathname;
        if (path === '/.well-known/station/v1/pairing/access-request') {
          return Response.json(
            {
              environmentId: 'environment-remote',
              offerId: 'offer-remote',
              proof: 'proof-remote',
              requestId: 'request-remote',
              expiresAt: Date.now() + 60_000,
            },
            { status: 202 },
          );
        }
        if (path === '/.well-known/station/v1/pairing/exchange') {
          return Response.json({
            environmentId: 'environment-remote',
            credential: 'new-remote-credential',
            device: {
              id: 'device-remote',
              name: 'This browser',
              scope: 'station:interactive',
              createdAt: Date.now(),
              revokedAt: null,
            },
          });
        }
        throw new Error(`Unexpected fetch: ${path}`);
      }),
    );

    render(
      <ConnectionsProvider
        store={store}
        commitVerifiedPairing={commitVerifiedPairing}
      >
        <ConnectionManagerModalContent
          onClose={onClose}
          checkHealth={vi.fn(async () => true)}
          checkCompatibility={checkCompatibleHost}
        />
      </ConnectionsProvider>,
    );

    fireEvent.click(
      screen.getByRole('button', { name: 'Request access to Remote Station' }),
    );
    fireEvent.click(
      await screen.findByRole('button', { name: 'Request access' }),
    );

    expect(
      await screen.findByText(
        'This device was paired, but the Station could not be saved here.',
      ),
    ).toBeTruthy();
    expect(commitVerifiedPairing).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
    expect(store.getActive()?.id).toBe(current.id);
    expect(store.getCredential(target.id)).toBeNull();
    expect(screen.getByRole('button', { name: 'Request access' })).toBeTruthy();
    vi.unstubAllGlobals();
  });

  it('shows an explicit required state and accepts a masked credential', () => {
    const { store, connection } = setup();
    expect(screen.getByText('Credential required')).toBeTruthy();

    fireEvent.click(screen.getByTitle('Edit Station'));
    expect(screen.getByText('Remote access credential')).toBeTruthy();
    expect(screen.getByText(/Localhost does not require one/)).toBeTruthy();
    expect(
      screen.getByText('./station environment credential show'),
    ).toBeTruthy();
    const input = screen.getByLabelText('Station access credential');
    expect(input.getAttribute('type')).toBe('password');
    fireEvent.change(input, { target: { value: 'component-fixture-secret' } });
    fireEvent.click(screen.getByText('Save'));

    expect(store.getCredential(connection.id)).toBe('component-fixture-secret');
    expect(screen.queryByText('component-fixture-secret')).toBeNull();
    expect(document.body.textContent).not.toContain('component-fixture-secret');
  });

  it('does not expose manual bearer entry when the native host owns credentials', () => {
    const store = new ConnectionStore({ storage: memoryAdapter() });
    const connection = store.add(
      'Remote Station',
      'https://station.example.test',
    );
    render(
      <ConnectionsProvider store={store}>
        <ConnectionManagerModalContent
          onClose={vi.fn()}
          checkHealth={vi.fn(async () => false)}
          allowManualCredentials={false}
        />
      </ConnectionsProvider>,
    );

    fireEvent.click(screen.getByTitle('Edit Station'));

    expect(screen.queryByLabelText('Station access credential')).toBeNull();
    expect(screen.queryByText('Remote access credential')).toBeNull();
    fireEvent.click(screen.getByText('Save'));
    expect(store.getCredential(connection.id)).toBeNull();
  });

  it('offers replacement without loading the saved value into the DOM', () => {
    const { store, connection } = setup();
    act(() => store.setCredential(connection.id, 'saved-fixture-secret'));
    fireEvent.click(screen.getByTitle('Edit Station'));

    const input = screen.getByLabelText('Station access credential');
    expect((input as HTMLInputElement).value).toBe('');
    expect(document.documentElement.innerHTML).not.toContain(
      'saved-fixture-secret',
    );
    expect(screen.getByText('Remove credential')).toBeTruthy();
  });

  it('keeps every row icon control on the shared touch-target class', () => {
    // The 44px minimum lives on .station-connect-icon-btn in
    // ConnectionManagerModal.css; jsdom does not apply stylesheets, so assert
    // the class contract here and leave pixel checks to the Playwright audits.
    setup();
    for (const title of [
      'Check reachability',
      'Edit Station',
      'Forget Station',
    ]) {
      expect(screen.getByTitle(title).className).toContain(
        'station-connect-icon-btn',
      );
    }
  });

  it('learns stable identity from an unauthenticated public handshake', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        environmentId: 'environment-1',
        authentication: { scheme: 'bearer', protocolVersion: 1 },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { store, connection } = setup();

    fireEvent.click(screen.getByTitle('Check reachability'));

    await waitFor(() =>
      expect(store.getAll()[0]).toMatchObject({
        environmentId: 'environment-1',
        authProtocolVersion: 1,
        credentialState: 'required',
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      new URL('https://station.example.test/.well-known/station/v1'),
      { headers: { Accept: 'application/json' } },
    );
    expect(store.getAll()[0].id).toBe(connection.id);
    vi.unstubAllGlobals();
  });

  it('checks each row with only that environment credential', async () => {
    const store = new ConnectionStore({ storage: memoryAdapter() });
    const first = store.add('Environment A', 'https://a.example.test');
    store.reconcileHandshake(first.id, {
      environmentId: 'environment-a',
      authentication: { scheme: 'bearer', protocolVersion: 1 },
    });
    store.setCredential(first.id, 'credential-a');
    const second = store.add('Environment B', 'https://b.example.test');
    store.reconcileHandshake(second.id, {
      environmentId: 'environment-b',
      authentication: { scheme: 'bearer', protocolVersion: 1 },
    });
    store.setCredential(second.id, 'credential-b');
    store.setActive(first.id);

    const handshakeRequests: Request[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
        handshakeRequests.push(new Request(input, init));
        const hostname = new URL(input.toString()).hostname;
        return Response.json({
          environmentId:
            hostname === 'a.example.test' ? 'environment-a' : 'environment-b',
          authentication: { scheme: 'bearer', protocolVersion: 1 },
        });
      }),
    );
    const checks: Array<[string, string | undefined]> = [];
    render(
      <ConnectionsProvider store={store}>
        <ConnectionManagerModalContent
          onClose={vi.fn()}
          checkHealth={vi.fn(async (url, credential) => {
            checks.push([url, credential]);
            return true;
          })}
        />
      </ConnectionsProvider>,
    );

    const buttons = screen.getAllByTitle('Check reachability');
    fireEvent.click(buttons[0]);
    fireEvent.click(buttons[1]);

    await waitFor(() => expect(checks).toHaveLength(2));
    expect(checks).toEqual([
      ['https://a.example.test', 'credential-a'],
      ['https://b.example.test', 'credential-b'],
    ]);
    expect(checks).not.toContainEqual([
      'https://b.example.test',
      'credential-a',
    ]);
    expect(
      handshakeRequests.every(
        (request) => !request.headers.has('Authorization'),
      ),
    ).toBe(true);
    expect(
      handshakeRequests.every((request) =>
        request.url.endsWith('/.well-known/station/v1'),
      ),
    ).toBe(true);
    vi.unstubAllGlobals();
  });

  it('does not send a saved bearer to an unconfirmed same-id endpoint', async () => {
    const store = new ConnectionStore({ storage: memoryAdapter() });
    const connection = store.add(
      'Trusted Station',
      'https://trusted.example.test',
    );
    store.reconcileHandshake(connection.id, {
      environmentId: 'environment-a',
      authentication: { scheme: 'bearer', protocolVersion: 1 },
    });
    store.setCredential(connection.id, 'credential-a');
    store.update(connection.id, { url: 'https://attacker.example.test' });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          environmentId: 'environment-a',
          authentication: { scheme: 'bearer', protocolVersion: 1 },
        }),
      ),
    );
    const checkHealth = vi.fn(async () => true);
    render(
      <ConnectionsProvider store={store}>
        <ConnectionManagerModalContent
          onClose={vi.fn()}
          checkHealth={checkHealth}
        />
      </ConnectionsProvider>,
    );

    fireEvent.click(screen.getByTitle('Check reachability'));
    await screen.findByRole('button', { name: 'Verify and use endpoint' });

    expect(checkHealth).not.toHaveBeenCalled();
    expect(store.getActive()?.url).toBe('https://trusted.example.test');
    expect(store.getActive()?.endpointCandidate?.url).toBe(
      'https://attacker.example.test',
    );
    vi.unstubAllGlobals();
  });

  it('does not save or activate a provider candidate before identity review', async () => {
    const unregister = registerConnectionCandidateProvider({
      id: 'test.tailnet',
      discover: async () => [
        {
          candidateVersion: 1,
          name: 'Suggested Station',
          url: 'https://suggested.example.ts.net',
          source: 'tailnet',
          discoveredAt: Date.now(),
        },
      ],
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          environmentId: 'suggested-environment',
          authentication: { scheme: 'bearer', protocolVersion: 1 },
        }),
      ),
    );
    const { store, connection } = setup();

    fireEvent.click(
      screen.getByRole('button', { name: 'Find other Stations' }),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Check' }));
    await screen.findByRole('button', { name: 'Open Station' });

    expect(store.getAll()).toHaveLength(1);
    expect(store.getActive()?.id).toBe(connection.id);
    expect(store.getAll()[0].url).toBe('https://station.example.test');

    unregister();
    vi.unstubAllGlobals();
  });

  it('aborts candidate identity review before leaving and re-entering the panel', async () => {
    const unregister = registerConnectionCandidateProvider({
      id: 'test.lifecycle',
      discover: async () => [
        {
          candidateVersion: 1,
          name: 'Lifecycle Station',
          url: 'https://lifecycle.example.ts.net',
          source: 'tailnet',
          discoveredAt: Date.now(),
        },
      ],
    });
    const signals: AbortSignal[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async (_input: URL | RequestInfo, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;
            if (!signal) throw new Error('candidate review signal missing');
            signals.push(signal);
            signal.addEventListener(
              'abort',
              () => reject(new DOMException('Aborted', 'AbortError')),
              { once: true },
            );
          }),
      ),
    );
    setup();

    fireEvent.click(
      screen.getByRole('button', { name: 'Find other Stations' }),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Check' }));
    await waitFor(() => expect(signals).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await waitFor(() => expect(signals[0].aborted).toBe(true));

    fireEvent.click(
      screen.getByRole('button', { name: 'Find other Stations' }),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Check' }));
    await waitFor(() => expect(signals).toHaveLength(2));
    expect(signals[1].aborted).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await waitFor(() => expect(signals[1].aborted).toBe(true));

    unregister();
    vi.unstubAllGlobals();
  });

  // station#1794 (part A). `registerConnectionCandidateProvider` has no
  // production caller on any platform, so without this the entry point is a
  // navigable dead end: the user clicks through and lands on
  // a panel whose only reachable state explains that the feature does not
  // exist. Worse, that panel blames "this browser" when the real reason —
  // nothing produces candidates anywhere — is platform-independent.
  //
  // The two tests above prove the complement: they register a provider first,
  // and the entry point is present for them. Together the pair pins the
  // affordance to whether discovery can actually return something, rather
  // than to a hardcoded decision.
  it('hides the discovery entry point when no discovery provider is registered', () => {
    setup();

    expect(
      screen.queryByRole('button', { name: 'Find other Stations' }),
    ).toBeNull();
  });
});
