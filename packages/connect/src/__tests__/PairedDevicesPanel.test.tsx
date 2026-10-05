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
function stubHost(options: {
  devices: PairedDevice[];
  revokeStatus?: number;
  scopeStatus?: number;
  revokeBody?: unknown;
}) {
  const calls: RecordedCall[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (input: URL | RequestInfo, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({
        url: String(input),
        method,
        auth: new Headers(init?.headers).get('Authorization'),
      });
      if (method === 'POST' && String(input).endsWith('/scope')) {
        return new Response(null, { status: options.scopeStatus ?? 204 });
      }
      if (method === 'DELETE') {
        return options.revokeBody === undefined
          ? new Response(null, { status: options.revokeStatus ?? 204 })
          : new Response(JSON.stringify(options.revokeBody), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            });
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

  test('#1796 G3: a revoke shows what it reset and what stays at full access, as text', async () => {
    stubHost({
      devices: [device({ id: 'abc', name: 'Pixel 9' })],
      revokeBody: {
        id: 'abc',
        fullAccessRevocation: {
          cause: 'device-revoked',
          reset: [
            {
              conversationId: 'conversation:reset-1',
              title: '[Fix the build](https://evil.example)',
              sessionId: 'session-reset-1',
              was: 'never',
            },
          ],
          reconfined: [{ conversationId: 'conversation:reset-1' }],
          stillUnconfined: [
            { conversationId: 'conversation:running', until: 'engine-restart' },
          ],
          stillFullAccess: [
            {
              conversationId: '[x](https://evil.example)',
              reason: 'station-default',
            },
          ],
          unattributedHostStarts: {
            sessions: [
              {
                conversationId: 'older-host',
                startedAt: '2026-09-01T00:00:00.000Z',
              },
            ],
            total: 2,
          },
        },
      },
    });
    renderPanel();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Revoke Pixel 9' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    const notice = await screen.findByTestId('full-access-revocation');
    expect(notice.textContent).toContain(
      '“Pixel 9” was revoked, and so was the full access it had given.',
    );
    expect(notice.textContent).toContain(
      '[Fix the build](https://evil.example) conversation:reset-1 (was its full-access decision)',
    );
    // The title opens the session in Activity; it is text, never markup.
    const open = screen.getByRole('link', {
      name: '[Fix the build](https://evil.example)',
    });
    expect(open.getAttribute('href')).toBe(
      '/?surface=activity&session=session-reset-1',
    );
    expect(notice.textContent).toContain(
      'Untitled conversation [x](https://evil.example), because of the Station’s default approval mode',
    );
    expect(notice.textContent).toContain(
      'Untitled conversation older-host, started 2026-09-01T00:00:00.000Z',
    );
    expect(notice.textContent).toContain('…and 1 more (2 in all).');
    expect(notice.textContent).toContain(
      'Re-confined from its next turn (runs inside the workspace again):Untitled conversation conversation:reset-1',
    );
    expect(notice.textContent).toContain(
      'Untitled conversation conversation:running, because its engine is running with no decision to re-apply',
    );
    // The only link is the one Station built; no id or title becomes one.
    expect(notice.querySelectorAll('a')).toHaveLength(1);
  });

  test('#2898: a session still running unconfined can be stopped now from the revoke notice', async () => {
    const calls: Array<RecordedCall & { body?: string }> = [];
    let stopStatus = 500;
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (input: URL | RequestInfo, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        calls.push({
          url: String(input),
          method,
          auth: new Headers(init?.headers).get('Authorization'),
          ...(typeof init?.body === 'string' ? { body: init.body } : {}),
        });
        if (method === 'DELETE')
          return new Response(
            JSON.stringify({
              id: 'abc',
              fullAccessRevocation: {
                cause: 'device-revoked',
                reset: [],
                stillFullAccess: [],
                reconfined: [],
                stillUnconfined: [
                  {
                    conversationId: 'conversation:running',
                    title: 'Deploy',
                    sessionId: 'session-running',
                    until: 'next-turn',
                  },
                  // An older Station's answer: nothing to stop it by here.
                  {
                    conversationId: 'conversation:older',
                    until: 'engine-restart',
                  },
                ],
                unattributedHostStarts: { sessions: [], total: 0 },
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        if (method === 'POST')
          return new Response(JSON.stringify({ success: true }), {
            status: stopStatus,
            headers: { 'Content-Type': 'application/json' },
          });
        return new Response(
          JSON.stringify({ devices: [device({ id: 'abc', name: 'Pixel 9' })] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      },
    );
    renderPanel();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Revoke Pixel 9' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    const notice = await screen.findByTestId('full-access-revocation');
    expect(notice.textContent).toContain(
      'Deploy conversation:running, because its engine is running: a turn already running finishes unconfined, and its next turn runs confined',
    );
    // Only the entry that names a running session offers a stop.
    expect(screen.getAllByRole('button', { name: /^Stop / })).toHaveLength(1);

    // A refused stop says so, and can be tried again.
    fireEvent.click(screen.getByRole('button', { name: 'Stop Deploy now' }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Station could not stop it.',
    );
    stopStatus = 200;
    fireEvent.click(screen.getByRole('button', { name: 'Stop Deploy now' }));
    await waitFor(() =>
      expect(notice.textContent).toContain(
        'Deploy conversation:running, stopped: its next start runs confined.',
      ),
    );

    const stops = calls.filter((call) => call.method === 'POST');
    expect(stops).toHaveLength(2);
    expect(stops[1]).toMatchObject({
      url: 'https://station.example.ts.net/api/orchestration/commands',
      auth: 'Bearer secret-credential',
    });
    expect(JSON.parse(stops[1]!.body!)).toEqual({
      type: 'stopSession',
      threadId: 'session-running',
    });
    expect(
      screen.queryByRole('button', { name: 'Stop Deploy now' }),
    ).toBeNull();
  });

  test('#1796 G3: a revoke notice strips bidi and zero-width characters from titles', async () => {
    // RLO reverses what follows; LRI/PDI isolate; ZWSP/ZWJ are invisible.
    // Left in, a title could read as another conversation's.
    const hostile = '\u202Edliub eht xiF\u202C \u2066ops\u2069\u200B\u200D';
    stubHost({
      devices: [device({ id: 'abc', name: 'Pixel 9' })],
      revokeBody: {
        id: 'abc',
        fullAccessRevocation: {
          cause: 'device-revoked',
          reset: [
            {
              conversationId: 'conversation:reset-1',
              title: hostile,
              sessionId: 'session-reset-1',
              was: 'never',
            },
            {
              conversationId: 'conversation:reset-2',
              title: '\u200B\u2067\u2069',
              was: 'never',
            },
          ],
          stillFullAccess: [],
          unattributedHostStarts: { sessions: [], total: 0 },
        },
      },
    });
    renderPanel();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Revoke Pixel 9' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    const notice = await screen.findByTestId('full-access-revocation');
    const open = screen.getByRole('link', { name: 'dliub eht xiF ops' });
    expect(open.textContent).toBe('dliub eht xiF ops');
    // Nothing visible left: it reads as untitled.
    expect(notice.textContent).toContain(
      'Untitled conversation conversation:reset-2',
    );
    expect(notice.textContent).not.toMatch(
      /[\u200B-\u200F\u202A-\u202E\u2066-\u2069]/u,
    );
  });

  test('#1796 G3: revoking a device that had put nothing at full access adds no notice', async () => {
    const { calls } = stubHost({
      devices: [device({ id: 'abc', name: 'Pixel 9' })],
      revokeBody: {
        id: 'abc',
        fullAccessRevocation: {
          cause: 'device-revoked',
          reset: [],
          stillFullAccess: [],
          unattributedHostStarts: { sessions: [], total: 0 },
        },
      },
    });
    renderPanel();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Revoke Pixel 9' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() =>
      expect(calls.some((call) => call.method === 'DELETE')).toBe(true),
    );
    await waitFor(() =>
      expect(calls.filter((call) => call.method === 'GET').length).toBe(2),
    );
    expect(screen.queryByTestId('full-access-revocation')).toBeNull();
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

  test('points a native host at the CLI when the host credential is refused for a scope change', async () => {
    stubHost({
      devices: [
        device({
          id: 'abc',
          name: 'Pixel 9',
          scope: 'orchestration:read orchestration:operate',
        }),
      ],
      scopeStatus: 401,
    });
    renderPanel({
      allowManualCredentials: false,
      hostAppName: 'Station Desktop',
    });

    fireEvent.click(
      await screen.findByRole('button', { name: 'Change access for Pixel 9' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(
      'Station Desktop can’t change a device’s access. Run `station environment access scope <device> --add|--remove|--set` on the host, then reopen this list.',
    );
    expect(alert.textContent).not.toContain('managed by');
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

  test('keeps the account binding visible next to an account-bound grant', async () => {
    stubHost({
      devices: [
        device({
          id: 'guest-browser',
          name: 'Guest browser',
          scope: 'orchestration:read orchestration:operate',
          principalBinding: {
            kind: 'account',
            issuer: 'urn:station:test',
            subject: 'guest-person',
            displayName: 'Guest Person',
            approvedAt: Date.now(),
            approvalId: 'approval-1',
            approvedBy: 'operator',
          },
        }),
        device({ id: 'ordinary', name: 'Pixel 9', kind: 'device' }),
      ],
    });
    renderPanel();

    await screen.findByText('Guest browser');
    const row = screen
      .getByText('Guest browser')
      .closest('.station-connect-row');
    expect(row?.textContent).toContain('Account: Guest Person');
    const ordinary = screen
      .getByText('Pixel 9')
      .closest('.station-connect-row');
    expect(ordinary?.textContent).not.toContain('Account:');
  });
});
