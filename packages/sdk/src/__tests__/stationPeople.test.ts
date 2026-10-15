import { beforeEach, describe, expect, it, vi } from 'vitest';

const { authenticatedFetchMock } = vi.hoisted(() => ({
  authenticatedFetchMock: vi.fn(),
}));
vi.mock('../client/http', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  authenticatedFetch: authenticatedFetchMock,
}));

import {
  isOperatorCredentialRequired,
  isStationAccessUnavailable,
  mintOwnAccessToken,
  mintStationPersonToken,
  StationAccessError,
} from '../query-domains/stationPeople';

/**
 * #3557: the People routes answer `{ error: "code" }` and the boundary and
 * self-service routes `{ error: { code } }`. Both must reach the caller as a
 * code it can branch on.
 */
describe('Station people and token refusals (#3557)', () => {
  beforeEach(() => authenticatedFetchMock.mockReset());

  it('reads a People route’s string error code', async () => {
    authenticatedFetchMock.mockResolvedValue(
      Response.json({ error: 'token_limit_reached' }, { status: 409 }),
    );
    const failure = await mintStationPersonToken(
      'human:tailscale-serve:ada@example.com',
      { name: 'CI', scope: 'orchestration:read' },
      'http://station.test',
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(StationAccessError);
    expect(failure).toMatchObject({ status: 409, code: 'token_limit_reached' });
    expect(authenticatedFetchMock).toHaveBeenCalledWith(
      'http://station.test/api/pairing/people/human%3Atailscale-serve%3Aada%40example.com/tokens',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('reads the boundary’s nested error code', async () => {
    authenticatedFetchMock.mockResolvedValue(
      Response.json(
        { error: { code: 'person_device_required' } },
        { status: 403 },
      ),
    );
    const failure = await mintOwnAccessToken(
      { name: 'CI', scope: 'orchestration:read' },
      'http://station.test',
    ).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      status: 403,
      code: 'person_device_required',
    });
    expect(isStationAccessUnavailable(failure)).toBe(true);
    expect(isOperatorCredentialRequired(failure)).toBe(false);
  });

  it('a server failure is not mistaken for "not for you"', () => {
    expect(isStationAccessUnavailable(new StationAccessError(500))).toBe(false);
    expect(isStationAccessUnavailable(new Error('offline'))).toBe(false);
    expect(isOperatorCredentialRequired(new StationAccessError(401))).toBe(
      true,
    );
  });
});
