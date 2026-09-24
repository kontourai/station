import { afterEach, expect, test, vi } from 'vitest';
import {
  captureMobileDevice,
  fetchMobileDeviceInventory,
  MobileDeviceRequestError,
} from '../mobile-device';

afterEach(() => vi.unstubAllGlobals());
const selected = {
  hostId: 'local',
  platform: 'android' as const,
  deviceId: 'emulator-5584',
};
const frame = {
  target: selected,
  captureId: 'capture-1',
  capturedAt: '2026-09-12T00:00:00.000Z',
  width: 1,
  height: 1,
  mimeType: 'image/png',
  pngBase64:
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDWQAAAAASUVORK5CYII=',
};

test('device client uses the selected Station base and exact capture target', async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(
      Response.json({
        success: true,
        data: {
          hostId: 'local',
          state: 'ready',
          observedAt: frame.capturedAt,
          devices: [],
        },
      }),
    )
    .mockResolvedValueOnce(Response.json({ success: true, data: frame }));
  vi.stubGlobal('fetch', fetch);
  expect((await fetchMobileDeviceInventory('https://station.test')).state).toBe(
    'ready',
  );
  expect(await captureMobileDevice('https://station.test', selected)).toEqual(
    frame,
  );
  expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
    'https://station.test/api/mobile-devices/hosts/local/devices',
    'https://station.test/api/mobile-devices/hosts/local/devices/android/emulator-5584/capture',
  ]);
  expect(fetch.mock.calls[1]?.[1]).toMatchObject({
    method: 'POST',
    body: '{}',
  });
});

test.each([
  { ...frame, target: { ...selected, deviceId: 'other-device' } },
  { ...frame, width: 0 },
  { ...frame, pngBase64: '<html>secret</html>' },
])('refuses mismatched or malformed captures', async (value) => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(Response.json({ success: true, data: value })),
  );
  await expect(
    captureMobileDevice('https://station.test', selected),
  ).rejects.toBeInstanceOf(MobileDeviceRequestError);
});

test('keeps authorization failures observable without disclosing upstream messages', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        Response.json({ error: 'secret-host-path' }, { status: 403 }),
      ),
  );
  await expect(
    fetchMobileDeviceInventory('https://station.test'),
  ).rejects.toMatchObject({
    status: 403,
    message: 'Mobile device inspection is unavailable.',
  });
});

test('missing readiness fields cannot become a healthy inventory', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      Response.json({
        success: true,
        data: { hostId: 'local', devices: [] },
      }),
    ),
  );
  await expect(
    fetchMobileDeviceInventory('https://station.test'),
  ).rejects.toBeInstanceOf(MobileDeviceRequestError);
});

test('capture enforces its response byte ceiling before parsing the image envelope', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ success: true, data: frame }) +
            ' '.repeat(13 * 1024 * 1024),
        ),
      ),
  );
  await expect(
    captureMobileDevice('https://station.test', selected),
  ).rejects.toBeInstanceOf(Error);
});

test('capture rejects path-shaped targets before making a request', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  await expect(
    captureMobileDevice('https://station.test', {
      ...selected,
      deviceId: '../exec',
    }),
  ).rejects.toMatchObject({ status: 400 });
  expect(fetch).not.toHaveBeenCalled();
});

// ---- device hosts (#1973) ---------------------------------------------------

const REMOTE = 'ssh-0123456789ab';

test('an SSH device host is addressed by its id, and its answer must be for that host', async () => {
  const {
    fetchMobileDeviceHosts,
    fetchMobileDeviceSessions,
    openMobileDeviceSession,
  } = await import('../mobile-device');
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(
      Response.json({
        success: true,
        data: {
          hostId: REMOTE,
          state: 'ready',
          observedAt: frame.capturedAt,
          devices: [],
        },
      }),
    )
    // A server answering for the wrong host is refused.
    .mockResolvedValueOnce(
      Response.json({
        success: true,
        data: {
          hostId: 'local',
          state: 'ready',
          observedAt: frame.capturedAt,
          devices: [],
        },
      }),
    )
    .mockResolvedValueOnce(
      Response.json({ success: true, data: { sessions: [] } }),
    )
    .mockResolvedValueOnce(
      Response.json({
        success: true,
        data: {
          hosts: [
            { hostId: 'local', label: 'This Station', kind: 'local' },
            { hostId: REMOTE, label: 'Mac mini', kind: 'ssh' },
          ],
        },
      }),
    );
  vi.stubGlobal('fetch', fetch);
  expect(
    (
      await fetchMobileDeviceInventory(
        'https://station.test',
        undefined,
        null,
        REMOTE,
      )
    ).hostId,
  ).toBe(REMOTE);
  await expect(
    fetchMobileDeviceInventory('https://station.test', undefined, null, REMOTE),
  ).rejects.toBeInstanceOf(MobileDeviceRequestError);
  await fetchMobileDeviceSessions(
    'https://station.test',
    undefined,
    'alpha',
    REMOTE,
  );
  expect(
    (await fetchMobileDeviceHosts('https://station.test')).map((h) => h.hostId),
  ).toEqual(['local', REMOTE]);
  expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
    `https://station.test/api/mobile-devices/hosts/${REMOTE}/devices`,
    `https://station.test/api/mobile-devices/hosts/${REMOTE}/devices`,
    `https://station.test/api/mobile-devices/hosts/${REMOTE}/sessions?projectSlug=alpha`,
    'https://station.test/api/mobile-devices/hosts',
  ]);
  // A malformed host id never leaves the client.
  const before = fetch.mock.calls.length;
  for (const hostId of ['../local', 'ssh-XYZ', 'LOCAL', ''])
    await expect(
      fetchMobileDeviceInventory(
        'https://station.test',
        undefined,
        null,
        hostId,
      ),
    ).rejects.toBeInstanceOf(MobileDeviceRequestError);
  await expect(
    openMobileDeviceSession('https://station.test', {
      hostId: 'ssh-..',
      platform: 'android',
      deviceId: 'emulator-5554',
    }),
  ).rejects.toBeInstanceOf(MobileDeviceRequestError);
  expect(fetch.mock.calls.length).toBe(before);
});

test('the operator device host client surfaces typed refusals', async () => {
  const { addDeviceSshHost, checkDeviceSshHost, DeviceHostRequestError } =
    await import('../mobile-device');
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        Response.json(
          { success: false, code: 'invalid-target' },
          { status: 400 },
        ),
      ),
  );
  await expect(
    addDeviceSshHost('https://station.test', {
      label: 'x',
      sshTarget: '-oProxyCommand=sh',
    }),
  ).rejects.toMatchObject({ status: 400, code: 'invalid-target' });
  await expect(
    checkDeviceSshHost('https://station.test', 'local'),
  ).rejects.toBeInstanceOf(DeviceHostRequestError);
});
