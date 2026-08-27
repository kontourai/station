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
}: {
  allowManualCredentials?: boolean;
  hostAppName?: string;
  authenticatedRequest?: typeof fetch;
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

    // Granting access lives one step inside the review surface, not beside it.
    fireEvent.click(
      screen.getByRole('button', { name: 'Approve another device' }),
    );
    expect(screen.getByRole('heading', { name: 'Pair a Device' })).toBeTruthy();
    // Let the pairing panel's own first poll settle inside the test.
    await screen.findByRole('button', { name: 'Create pairing code' });
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
});
