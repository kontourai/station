import type { PeerEnrollment } from '@kontourai/station-contracts/environment-security';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  StationRequestAuthorityError,
  setClientCredentialResolver,
} from '../client/http';
import {
  cancelPeerEnrollment,
  completePeerEnrollment,
  getPeerEnrollment,
  startPeerEnrollment,
} from '../client/peer-enrollments';

const controller = {
  apiBase: 'https://controller.test',
  authorityKey: 'controller:operator-1',
};
const enrollment: PeerEnrollment = {
  id: '837d58a7-817c-4d7d-a358-b5329eea7442',
  apiBase: 'https://destination.test',
  environmentId: 'destination-environment',
  label: 'Destination',
  status: 'pending',
  expiresAt: 1000,
};

afterEach(() => {
  setClientCredentialResolver(undefined);
  vi.unstubAllGlobals();
});

describe('peer enrollment caller authority', () => {
  it('starts on the captured controlling Station, not the destination', async () => {
    setClientCredentialResolver(() => ({
      origin: controller.apiBase,
      credential: 'controller-credential',
      requestAuthority: { ...controller, isCurrent: () => true },
    }));
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(Response.json({ success: true, data: enrollment }));
    vi.stubGlobal('fetch', fetch);

    await expect(
      startPeerEnrollment(
        controller.apiBase,
        {
          id: enrollment.id,
          apiBase: enrollment.apiBase,
          environmentId: enrollment.environmentId,
          label: 'Destination',
        },
        { requestScope: controller },
      ),
    ).resolves.toEqual(enrollment);

    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(
      'https://controller.test/api/environments/peers/enrollments',
    );
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('authorization')).toBe(
      'Bearer controller-credential',
    );
    expect(JSON.parse(String(init?.body))).toEqual({
      id: enrollment.id,
      apiBase: 'https://destination.test',
      environmentId: 'destination-environment',
      label: 'Destination',
    });
  });

  it.each([
    ['read', getPeerEnrollment],
    ['complete', completePeerEnrollment],
    ['cancel', cancelPeerEnrollment],
  ])(
    'refuses to %s an old enrollment under a replacement authority',
    async (_, request) => {
      setClientCredentialResolver(() => ({
        origin: controller.apiBase,
        credential: 'replacement-credential',
        requestAuthority: {
          apiBase: controller.apiBase,
          authorityKey: 'controller:operator-2',
          isCurrent: () => true,
        },
      }));
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(Response.json({ success: true, data: enrollment }));
      vi.stubGlobal('fetch', fetch);

      await expect(
        request(controller.apiBase, enrollment.id, {
          requestScope: controller,
        }),
      ).rejects.toBeInstanceOf(StationRequestAuthorityError);
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it('does not deliver a late completion after its authority is retired', async () => {
    let current = true;
    setClientCredentialResolver(() => ({
      origin: controller.apiBase,
      requestAuthority: { ...controller, isCurrent: () => current },
    }));
    let settle: ((response: Response) => void) | undefined;
    const fetch = vi.fn<typeof globalThis.fetch>(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    );
    vi.stubGlobal('fetch', fetch);
    const result = completePeerEnrollment(controller.apiBase, enrollment.id, {
      requestScope: controller,
    });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    current = false;
    settle?.(
      Response.json({
        success: true,
        data: { ...enrollment, status: 'connected' },
      }),
    );
    await expect(result).rejects.toBeInstanceOf(StationRequestAuthorityError);
  });

  it('preserves the operator refusal so setup can show the right remedy', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      Response.json(
        {
          success: false,
          error: 'Operator approval is required.',
          code: 'operator_required',
        },
        { status: 403 },
      ),
    );
    vi.stubGlobal('fetch', fetch);
    await expect(
      getPeerEnrollment(controller.apiBase, enrollment.id),
    ).rejects.toMatchObject({
      status: 403,
      code: 'operator_required',
      message: 'Operator approval is required.',
    });
  });
});
