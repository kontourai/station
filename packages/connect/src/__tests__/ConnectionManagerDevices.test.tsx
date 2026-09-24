// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectionStore } from '../core/ConnectionStore';
import type { StorageAdapter } from '../core/types';
import { ConnectionManagerModalContent } from '../react/ConnectionManagerModalContent';
import { ConnectionsProvider } from '../react/ConnectionsContext';

vi.mock('qrcode', () => ({ toCanvas: vi.fn(async () => undefined) }));

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

function setup({
  allowManualCredentials,
  hostAppName,
  authenticatedRequest,
  pairingClientChannel,
  originIsStation,
  hasLocalStation,
  initialPanel,
}: {
  allowManualCredentials?: boolean;
  hostAppName?: string;
  authenticatedRequest?: typeof fetch;
  pairingClientChannel?: 'stable' | 'beta' | 'nightly';
  originIsStation?: boolean;
  hasLocalStation?: boolean;
  initialPanel?: 'list' | 'pair-host';
} = {}) {
  const store = new ConnectionStore({ storage: memoryAdapter() });
  store.add('Remote Station', 'https://station.example.test');
  render(
    <ConnectionsProvider store={store}>
      <ConnectionManagerModalContent
        onClose={vi.fn()}
        checkHealth={vi.fn(async () => false)}
        allowManualCredentials={allowManualCredentials}
        hostAppName={hostAppName}
        authenticatedRequest={authenticatedRequest}
        pairingClientChannel={pairingClientChannel}
        originIsStation={originIsStation}
        hasLocalStation={hasLocalStation}
        initialPanel={initialPanel}
      />
    </ConnectionsProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Connection Manager paired devices', () => {
  it('reaches the device list from the connection list, then pairing from there', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: URL | RequestInfo) => {
        const path = new URL(String(input)).pathname;
        if (path === '/api/pairing/devices') {
          return Response.json({
            devices: [
              {
                id: 'device-phone',
                name: 'Pixel 9',
                scope: 'station:interactive',
                createdAt: Date.now() - 86_400_000,
                revokedAt: null,
              },
            ],
          });
        }
        return Response.json({ requests: [] });
      }),
    );

    setup();

    fireEvent.click(screen.getByRole('button', { name: 'Paired devices' }));
    expect(
      screen.getByRole('heading', { name: 'Paired Devices' }),
    ).toBeTruthy();
    expect(await screen.findByText('Pixel 9')).toBeTruthy();

    // The device inventory also retains its pairing entry point.
    fireEvent.click(
      screen.getByRole('button', { name: 'Approve another device' }),
    );
    expect(screen.getByRole('heading', { name: 'Pair a Device' })).toBeTruthy();
    // Let the pairing panel's own first poll settle inside the test.
    await screen.findByRole('button', { name: 'Create pairing code' });
  });

  it('invites another device directly to the selected server and returns to connections', async () => {
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      return Response.json(
        path.endsWith('/devices') ? { devices: [] } : { requests: [] },
      );
    });
    setup({ authenticatedRequest: request });
    fireEvent.click(
      screen.getByRole('button', { name: 'Connect another device' }),
    );
    await screen.findByRole('button', { name: 'Create pairing code' });
    expect(
      (screen.getByLabelText('Pairing endpoint') as HTMLInputElement).value,
    ).toBe('https://station.example.test');
    expect(request).toHaveBeenCalledWith(
      new URL('https://station.example.test/api/pairing/requests'),
      expect.anything(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(
      screen.getByRole('button', { name: 'Connect another device' }),
    ).toBeTruthy();
  });

  it('returns to the device list when the pairing panel is dismissed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: URL | RequestInfo) => {
        const path = new URL(String(input)).pathname;
        if (path === '/api/pairing/devices') {
          return Response.json({ devices: [] });
        }
        return Response.json({ requests: [] });
      }),
    );

    setup();

    fireEvent.click(screen.getByRole('button', { name: 'Paired devices' }));
    await screen.findByText(/No devices are paired with this Station yet/);
    fireEvent.click(
      screen.getByRole('button', { name: 'Approve another device' }),
    );
    await screen.findByRole('button', { name: 'Create pairing code' });
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));

    expect(
      screen.getByRole('heading', { name: 'Paired Devices' }),
    ).toBeTruthy();
    await screen.findByText(/No devices are paired with this Station yet/);
  });

  it('threads the native credential policy to paired-device management', async () => {
    const authenticatedRequest: typeof fetch = vi.fn(
      async (input: RequestInfo | URL) => {
        const path = new URL(String(input)).pathname;
        if (path === '/api/pairing/devices')
          return Response.json({ devices: [] });
        return Response.json({ requests: [] });
      },
    );
    setup({
      allowManualCredentials: false,
      hostAppName: 'Station Desktop',
      authenticatedRequest,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Paired devices' }));

    expect(
      await screen.findByText(
        /Station Desktop manages the operator credential for device changes/,
      ),
    ).toBeTruthy();
    expect(
      screen.queryByLabelText('Operator credential for device changes'),
    ).toBeNull();
    expect(authenticatedRequest).toHaveBeenCalled();
  });

  it('hides host-only Station management on a client-only device', () => {
    // The phone shape: the origin is not a Station and the device has no
    // Station of its own (station#2205).
    setup({ originIsStation: false, hasLocalStation: false });

    expect(
      screen.queryByText('Connect another device to this Station'),
    ).toBeNull();
    expect(screen.queryByRole('button', { name: 'Paired devices' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Request access' })).toBeTruthy();
  });

  it('keeps host Station management on a native desktop that supervises a local Station', () => {
    // Desktop Tauri: the origin is not a Station either, but the device still
    // has its own supervised Station — hiding must key on hasLocalStation,
    // never on originIsStation alone.
    setup({ originIsStation: false });

    expect(
      screen.getByText('Connect another device to this Station'),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Paired devices' })).toBeTruthy();
  });

  it('lands a client-only device opened straight onto pair-host on the list', () => {
    // AddMachineModal's "control this Station" goal mounts initialPanel
    // "pair-host"; on a client-only device that screen can only report its
    // own failure, so the list is the honest landing.
    setup({
      originIsStation: false,
      hasLocalStation: false,
      initialPanel: 'pair-host',
    });

    expect(
      screen.queryByRole('button', { name: 'Create pairing code' }),
    ).toBeNull();
    expect(
      screen.getByRole('heading', { name: 'Connect to another computer' }),
    ).toBeTruthy();
  });
});
