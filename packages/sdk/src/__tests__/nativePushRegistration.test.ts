import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api', () => ({
  _getApiBase: vi.fn().mockResolvedValue('http://example.test'),
}));

import {
  DevicePairingRequiredError,
  registerNativePush,
  unregisterNativePush,
} from '../query-domains/chatRuntimeDevice';

function mockJsonResponse(payload: unknown, status = 200) {
  vi.mocked(fetch).mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  } as Response);
}

const REQUEST = {
  token: 'fcm-token-0123456789abcdef',
  packageName: 'io.kontourai.station',
  platform: 'android',
} as const;

describe('native push registration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn());
  });

  it('posts the registration to the contract path and returns the three check values', async () => {
    mockJsonResponse({
      registrationId: 'r'.repeat(22),
      stationId: 'station-1',
      stationKey: 'k'.repeat(43),
      extra: 'ignored',
    });
    await expect(registerNativePush(REQUEST)).resolves.toEqual({
      registrationId: 'r'.repeat(22),
      stationId: 'station-1',
      stationKey: 'k'.repeat(43),
    });
    expect(fetch).toHaveBeenCalledWith(
      'http://example.test/api/system/native-push/register',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify(REQUEST),
      }),
    );
  });

  it('refuses a response missing a check value rather than configuring the phone with it', async () => {
    mockJsonResponse({
      registrationId: 'r'.repeat(22),
      stationId: 'station-1',
    });
    await expect(registerNativePush(REQUEST)).rejects.toThrow(
      'Malformed native push registration response',
    );
  });

  it('maps an unpaired caller to DevicePairingRequiredError', async () => {
    mockJsonResponse({ error: 'device_pairing_required' }, 403);
    await expect(registerNativePush(REQUEST)).rejects.toBeInstanceOf(
      DevicePairingRequiredError,
    );
    mockJsonResponse({ error: 'device_pairing_required' }, 403);
    await expect(unregisterNativePush()).rejects.toBeInstanceOf(
      DevicePairingRequiredError,
    );
  });

  it('unregisters with DELETE on the registration path', async () => {
    mockJsonResponse({ ok: true });
    await expect(unregisterNativePush()).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledWith(
      'http://example.test/api/system/native-push',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('surfaces other failures', async () => {
    mockJsonResponse({ error: 'invalid_request' }, 400);
    await expect(registerNativePush(REQUEST)).rejects.toThrow(
      'Failed to register for native push: 400',
    );
  });
});
