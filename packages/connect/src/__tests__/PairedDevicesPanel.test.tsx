// @vitest-environment jsdom
import type { PairedDevice } from '@kontourai/station-contracts';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { PairedDevicesPanel } from '../react/connection-manager-modal/PairedDevicesPanel';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Ages are expressed against the real clock rather than a frozen one: the
 * panel stamps its own `now` on every refresh, and the labels under test are
 * far enough from a unit boundary that a few milliseconds of drift cannot
 * change them.
 */
function device(overrides: Partial<PairedDevice> = {}): PairedDevice {
  return {
    id: 'device-1',
    name: 'Pixel 9',
    scope: 'station:interactive',
    kind: 'device',
    createdAt: Date.now() - DAY,
    activityTracking: 'tracked-since-issued',
    lastSeenFrom: null,
    usageCount: 0,
    lastActiveDay: null,
    revokedAt: null,
    revocation: { state: 'not-revoked' },
    ...overrides,
  };
}

interface RecordedCall {
  url: string;
  method: string;
  auth: string | null;
}

/** Serves the device list and records what the panel asked the host to do. */
function stubHost(options: { devices: PairedDevice[]; revokeStatus?: number }) {
  const calls: RecordedCall[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (input: URL | RequestInfo, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({
        url: String(input),
        method,
        auth: new Headers(init?.headers).get('Authorization'),
      });
      if (method === 'DELETE') {
        return new Response(null, { status: options.revokeStatus ?? 204 });
      }
      return new Response(JSON.stringify({ devices: options.devices }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  );
  return { calls };
}

function renderPanel(
  overrides: Partial<Parameters<typeof PairedDevicesPanel>[0]> = {},
) {
  return render(
    <PairedDevicesPanel
      apiBase="https://station.example.ts.net"
      getCredential={() => 'secret-credential'}
      onPairDevice={() => {}}
      onBack={() => {}}
      {...overrides}
    />,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PairedDevicesPanel', () => {
  test('shows when each device was paired and last used', async () => {
    stubHost({
      devices: [
        device({ name: 'Pixel 9', lastUsedAt: Date.now() - 8 * MINUTE }),
      ],
    });
    renderPanel();

    expect(await screen.findByText('Pixel 9')).toBeTruthy();
    expect(screen.getByText(/Paired 1 day ago/)).toBeTruthy();
    expect(screen.getByText('Last used 8 minutes ago')).toBeTruthy();
  });

  test('marks a device with recent request activity as active', async () => {
    stubHost({
      devices: [device({ name: 'MacBook', lastUsedAt: Date.now() - 20_000 })],
    });
    renderPanel();

    expect(await screen.findByText('MacBook')).toBeTruthy();
    expect(screen.getByText('Active recently')).toBeTruthy();
    expect(screen.getByText('Recent request activity')).toBeTruthy();
  });

  test('keeps connected, recent, access, and revoked states distinct', async () => {
    stubHost({
      devices: [
        device({
          id: 'connected',
          name: 'Connected',
          connectedClients: {
            deviceId: 'connected',
            sessionCount: 2,
            connectedAt: Date.now() - MINUTE,
            lastSeenAt: Date.now(),
            transports: ['events-sse'],
          },
          lastUsedAt: Date.now(),
        }),
        device({
          id: 'recent',
          name: 'Recent',
          lastUsedAt: Date.now() - MINUTE,
        }),
        device({ id: 'access', name: 'Access' }),
        device({
          id: 'revoked',
          name: 'Revoked',
          revokedAt: Date.now() - MINUTE,
        }),
      ],
    });
    renderPanel();
    expect(await screen.findByText('Connected')).toBeTruthy();
    expect(screen.getByText('Connected now · 2')).toBeTruthy();
    expect(screen.getByText('Connected now · 2 sessions')).toBeTruthy();
    expect(screen.getByText('Active recently')).toBeTruthy();
    expect(screen.getAllByText('Has access')).toHaveLength(2);
    expect(screen.getByText('Revoked 1 minute ago')).toBeTruthy();
  });

  test('separates revoked devices from devices that still have access', async () => {
    stubHost({
      devices: [
        device({ id: 'live', name: 'Still allowed' }),
        device({
          id: 'dead',
          name: 'Turned off',
          revokedAt: Date.now() - HOUR,
        }),
      ],
    });
    renderPanel();

    await screen.findByText('Still allowed');
    const withAccess = screen.getByRole('region', {
      name: 'Devices with access',
    });
    const revoked = screen.getByRole('region', { name: 'Revoked devices' });

    expect(withAccess.textContent).toContain('Still allowed');
    expect(withAccess.textContent).not.toContain('Turned off');
    expect(revoked.textContent).toContain('Turned off');
    expect(revoked.textContent).toContain('Revoked 1 hour ago');
  });

  test('offers record removal, not revocation, for an already-revoked device', async () => {
    const { calls } = stubHost({
      devices: [device({ name: 'Turned off', revokedAt: Date.now() - HOUR })],
    });
    renderPanel();

    await screen.findByText('Turned off');
    expect(
      screen.queryByRole('button', { name: 'Revoke Turned off' }),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Remove revoked record for Turned off',
      }),
    );
    await waitFor(() => {
      expect(calls).toContainEqual({
        method: 'DELETE',
        url: 'https://station.example.ts.net/api/pairing/devices/device-1/record',
        auth: 'Bearer secret-credential',
      });
    });
  });

  test('requires a confirmation before revoking, and sends the credential', async () => {
    const { calls } = stubHost({
      devices: [device({ id: 'abc', name: 'Pixel 9' })],
    });
    renderPanel();

    fireEvent.click(
      await screen.findByRole('button', { name: 'Revoke Pixel 9' }),
    );
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    await waitFor(() => {
      const revoke = calls.find((call) => call.method === 'DELETE');
      expect(revoke?.url).toBe(
        'https://station.example.ts.net/api/pairing/devices/abc',
      );
      expect(revoke?.auth).toBe('Bearer secret-credential');
    });
  });

  test('abandons the revoke when the confirmation is cancelled', async () => {
    const { calls } = stubHost({ devices: [device({ name: 'Pixel 9' })] });
    renderPanel();

    fireEvent.click(
      await screen.findByRole('button', { name: 'Revoke Pixel 9' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(calls.some((call) => call.method === 'DELETE')).toBe(false);
    expect(screen.getByRole('button', { name: 'Revoke Pixel 9' })).toBeTruthy();
  });

  test('reports a rejected revoke instead of implying access was cut', async () => {
    stubHost({ devices: [device({ name: 'Pixel 9' })], revokeStatus: 401 });
    renderPanel();

    fireEvent.click(
      await screen.findByRole('button', { name: 'Revoke Pixel 9' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(
      'requires this Station’s operator credential',
    );
  });

  test('uses an explicitly entered operator credential only for device changes', async () => {
    const { calls } = stubHost({
      devices: [device({ id: 'abc', name: 'Pixel 9' })],
    });
    renderPanel({
      allowManualCredentials: true,
      getCredential: () => undefined,
    });

    fireEvent.change(
      await screen.findByLabelText('Operator credential for device changes'),
      { target: { value: 'operator-credential' } },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Revoke Pixel 9' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    await waitFor(() => {
      expect(calls).toContainEqual({
        method: 'DELETE',
        url: 'https://station.example.ts.net/api/pairing/devices/abc',
        auth: 'Bearer operator-credential',
      });
    });
    expect(calls.filter((call) => call.method === 'GET')).toEqual(
      expect.arrayContaining([expect.objectContaining({ auth: null })]),
    );
  });

  test('does not render or use a manual credential when the native host owns it', async () => {
    const { calls } = stubHost({
      devices: [device({ id: 'abc', name: 'Pixel 9' })],
    });
    renderPanel({
      allowManualCredentials: false,
      hostAppName: 'Station Desktop',
    });

    expect(
      await screen.findByText(
        /Station Desktop manages the operator credential for device changes/,
      ),
    ).toBeTruthy();
    expect(
      screen.queryByLabelText('Operator credential for device changes'),
    ).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Revoke Pixel 9' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    await waitFor(() => {
      expect(calls).toContainEqual({
        method: 'DELETE',
        url: 'https://station.example.ts.net/api/pairing/devices/abc',
        auth: null,
      });
    });
  });

  test('explains that an unauthorized device needs review and reconnection', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 401 }),
    );
    renderPanel();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(
      "This device's access to this Station needs review. Reconnect it, then try again.",
    );
  });

  test('says so plainly when no device has ever been paired', async () => {
    stubHost({ devices: [] });
    renderPanel();

    expect(
      await screen.findByText(/No devices are paired with this Station yet/),
    ).toBeTruthy();
  });

  test('routes to the pairing flow rather than issuing a credential itself', async () => {
    const onPairDevice = vi.fn();
    stubHost({ devices: [] });
    renderPanel({ onPairDevice });

    fireEvent.click(
      await screen.findByRole('button', { name: 'Approve another device' }),
    );
    expect(onPairDevice).toHaveBeenCalledTimes(1);
  });

  test('station#1123 slice 1: a delegation grant is visibly distinct and revocable from the same list', async () => {
    const { calls } = stubHost({
      devices: [
        device({
          id: 'peer-grant',
          name: 'Peer: box-b',
          kind: 'delegation',
          scope: 'orchestration:read orchestration:operate',
        }),
        device({ id: 'ordinary', name: 'Pixel 9', kind: 'device' }),
      ],
    });
    renderPanel();

    await screen.findByText('Peer: box-b');
    // The delegation badge appears once, next to the delegation grant only.
    expect(screen.getAllByText('Delegation')).toHaveLength(1);
    const row = screen.getByText('Peer: box-b').closest('.station-connect-row');
    expect(row?.textContent).toContain('Delegation');

    fireEvent.click(
      await screen.findByRole('button', { name: 'Revoke Peer: box-b' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    await waitFor(() => {
      const revoke = calls.find((call) => call.method === 'DELETE');
      expect(revoke?.url).toBe(
        'https://station.example.ts.net/api/pairing/devices/peer-grant',
      );
    });
  });
});
