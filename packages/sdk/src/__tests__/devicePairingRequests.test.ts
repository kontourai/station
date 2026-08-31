import { beforeEach, describe, expect, it, vi } from 'vitest';

const { authenticatedFetchMock } = vi.hoisted(() => ({
  authenticatedFetchMock: vi.fn(),
}));
vi.mock('../client/http', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  authenticatedFetch: authenticatedFetchMock,
}));

import {
  confirmDevicePairingRequest,
  DevicePairingRequestActionError,
  denyDevicePairingRequest,
  fetchPairedDevices,
  pairedDeviceQueries,
} from '../query-domains/devicePairingRequests';

/**
 * #765 D5: the attention card's Approve/Deny must hit the SAME gated pairing
 * routes the Connections panel and `station environment access approve|deny`
 * use — POST …/confirm and DELETE …/:requestId — so the pairing family's
 * authorization decides, and approving from the card is the same service
 * call as the CLI approve.
 */
describe('device pairing request actions (#765 D5)', () => {
  beforeEach(() => {
    authenticatedFetchMock.mockReset();
  });

  it('approve POSTs the existing pairing confirm route', async () => {
    authenticatedFetchMock.mockResolvedValue({ ok: true } as Response);

    await confirmDevicePairingRequest('req-1', 'http://station.test');

    expect(authenticatedFetchMock).toHaveBeenCalledWith(
      'http://station.test/api/pairing/requests/req-1/confirm',
      { method: 'POST' },
    );
  });

  it('deny DELETEs the existing pairing request route', async () => {
    authenticatedFetchMock.mockResolvedValue({ ok: true } as Response);

    await denyDevicePairingRequest('req-1', 'http://station.test');

    expect(authenticatedFetchMock).toHaveBeenCalledWith(
      'http://station.test/api/pairing/requests/req-1',
      { method: 'DELETE' },
    );
  });

  it('a refusal surfaces the HTTP status and server error code', async () => {
    authenticatedFetchMock.mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ error: 'approval_requires_operator' }),
    } as Response);

    const failure = await confirmDevicePairingRequest(
      'req-1',
      'http://station.test',
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(DevicePairingRequestActionError);
    expect(failure).toMatchObject({
      status: 403,
      code: 'approval_requires_operator',
    });
  });

  it('a non-JSON failure body still yields a status-bearing error', async () => {
    authenticatedFetchMock.mockResolvedValue({
      ok: false,
      status: 410,
      json: async () => {
        throw new Error('no body');
      },
    } as unknown as Response);

    const failure = await denyDevicePairingRequest(
      'req-1',
      'http://station.test',
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(DevicePairingRequestActionError);
    expect(failure).toMatchObject({ status: 410, code: undefined });
  });

  it('the request id is URL-encoded, never spliced raw', async () => {
    authenticatedFetchMock.mockResolvedValue({ ok: true } as Response);

    await confirmDevicePairingRequest('req/../x', 'http://station.test');

    expect(authenticatedFetchMock).toHaveBeenCalledWith(
      'http://station.test/api/pairing/requests/req%2F..%2Fx/confirm',
      { method: 'POST' },
    );
  });
});

describe('paired-device identity query (#951 step 2)', () => {
  beforeEach(() => {
    authenticatedFetchMock.mockReset();
  });

  it('reads the current device records from the canonical pairing route', async () => {
    const devices = [
      {
        id: 'device-1',
        name: 'Brian’s Pixel',
        scope: 'chat:read',
        kind: 'device',
        createdAt: 1,
        activityTracking: 'tracked-since-issued',
        lastSeenFrom: null,
        usageCount: 0,
        lastActiveDay: null,
        revokedAt: null,
        revocation: { state: 'not-revoked' },
      },
    ];
    authenticatedFetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ devices }),
    } as Response);

    await expect(fetchPairedDevices('https://station.test')).resolves.toBe(
      devices,
    );
    expect(authenticatedFetchMock).toHaveBeenCalledWith(
      'https://station.test/api/pairing/devices',
    );
  });

  it('keeps Station identities in separate caches', () => {
    expect(pairedDeviceQueries.list('https://a.test').queryKey).not.toEqual(
      pairedDeviceQueries.list('https://b.test').queryKey,
    );
  });

  it('refuses a successful response that has no device inventory', async () => {
    authenticatedFetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({}),
    } as Response);

    await expect(fetchPairedDevices('https://station.test')).rejects.toThrow(
      'Paired devices response is missing its device list',
    );
  });

  it('surfaces an HTTP refusal instead of treating it as an empty registry', async () => {
    authenticatedFetchMock.mockResolvedValue({
      ok: false,
      status: 403,
    } as Response);

    await expect(fetchPairedDevices('https://station.test')).rejects.toThrow(
      'Paired devices request failed (HTTP 403)',
    );
  });
});
