import type { SelfHostedBrokerNativeRouteInvitationV2 } from '@kontourai/station-contracts/self-hosted-broker';
import { encodeNativeRelayLink } from '@kontourai/station-shared/native-relay-link';
import { beforeEach, expect, test, vi } from 'vitest';
import { StationHttpError } from '../client/http';
import { readProjectInvitationToken } from '../client/project-access';
import {
  approveRelaySetup,
  createRelayInvitation,
  getRelayManagement,
  getRelayManagementCapabilities,
} from '../relay-management';

const http = vi.hoisted(() => ({ get: vi.fn(), mutate: vi.fn() }));
vi.mock('../client/http', async (original) => ({
  ...(await original<typeof import('../client/http')>()),
  getJson: http.get,
  mutateJson: http.mutate,
}));
beforeEach(() => vi.clearAllMocks());
test('capability discovery decodes only boolean permission facts', async () => {
  http.get.mockResolvedValueOnce(
    Response.json({ data: { canManage: false, configured: true } }),
  );
  await expect(
    getRelayManagementCapabilities('https://station.example'),
  ).resolves.toEqual({ canManage: false, configured: true });
  http.get.mockResolvedValueOnce(
    Response.json({ data: { canManage: 'false', configured: true } }),
  );
  await expect(
    getRelayManagementCapabilities('https://station.example'),
  ).rejects.toThrow();
});
test('a denied or uncertain response never releases a success-shaped invitation and keeps a safe HTTP failure', async () => {
  http.mutate.mockResolvedValueOnce(
    Response.json(
      {
        data: {
          link: 'private invitation must not be released',
          expiresAt: Date.now() + 10000,
        },
        error: {
          code: 'invitation_delivery_uncertain',
          message: 'Private broker detail',
        },
      },
      { status: 409 },
    ),
  );
  const route = {
    applicationOrigin: 'https://station.example',
    brokerOrigin: 'https://broker.example',
    stationId: 'b39e4ea7-1a94-4cfb-9583-70ff9e971e21',
    enrollmentId: '8adbb1f1-1863-4560-b922-8f04467730ee',
  };
  const prepare = {
    ...route,
    appIdentifier: 'io.kontourai.station.nightly',
    channel: 'nightly',
    clientInstanceId: '579f0519-95eb-47b8-846b-5908dcb52251',
    keyThumbprint: 'T'.repeat(43),
  };
  const pending = createRelayInvitation(
    'https://station.example',
    route,
    prepare,
    '24h',
  );
  await expect(pending).rejects.toBeInstanceOf(StationHttpError);
  await expect(pending).rejects.toMatchObject({
    status: 409,
    message: 'Relay management is unavailable.',
  });
  expect(http.mutate).toHaveBeenCalledTimes(1);
});

test('mobile invitation input extracts only a code and never interprets a foreign link as Station selection', () => {
  const token = 'P'.repeat(43);
  expect(
    readProjectInvitationToken(
      `https://inviter.example/account/join#invitation=${token}`,
    ),
  ).toBe(token);
  expect(readProjectInvitationToken(` ${token} `)).toBe(token);
  expect(
    readProjectInvitationToken(
      `https://inviter.example/account/join#invitation=${token}&station=other`,
    ),
  ).toBeUndefined();
  expect(
    readProjectInvitationToken(
      `https://user:password@inviter.example/account/join#invitation=${token}`,
    ),
  ).toBeUndefined();
  expect(
    readProjectInvitationToken(`javascript:alert(1)#invitation=${token}`),
  ).toBeUndefined();
});

const invitationRoute = {
  applicationOrigin: 'https://station.example',
  brokerOrigin: 'https://broker.example',
  stationId: 'b39e4ea7-1a94-4cfb-9583-70ff9e971e21',
  enrollmentId: '8adbb1f1-1863-4560-b922-8f04467730ee',
};
const recipient = {
  brokerOrigin: invitationRoute.brokerOrigin,
  stationId: invitationRoute.stationId,
  enrollmentId: invitationRoute.enrollmentId,
  appIdentifier: 'io.kontourai.station.nightly',
  channel: 'nightly' as const,
  clientInstanceId: '579f0519-95eb-47b8-846b-5908dcb52251',
  keyThumbprint: 'T'.repeat(43),
};
function issuedInvitation(): SelfHostedBrokerNativeRouteInvitationV2 {
  return {
    version: 'station-broker-native-route-invitation/v2',
    brokerOrigin: invitationRoute.brokerOrigin,
    scope: {
      stationId: invitationRoute.stationId,
      enrollmentId: invitationRoute.enrollmentId,
      routingGeneration: 1,
    },
    stationSigningKeyId: 'K'.repeat(43),
    stationSigningGeneration: 1,
    surface: {
      kind: 'station-native',
      appIdentifier: recipient.appIdentifier,
      channel: recipient.channel,
      clientInstanceId: recipient.clientInstanceId,
      keyThumbprint: recipient.keyThumbprint,
    },
    invitationId: 'I'.repeat(43),
    invitationSecret: 'S'.repeat(43),
    expiresAt: Date.now() + 86_400_000,
  };
}
function invitationLink(
  invitation: SelfHostedBrokerNativeRouteInvitationV2,
  origin = invitationRoute.applicationOrigin,
) {
  return encodeNativeRelayLink(
    {
      version: 'station-native-relay-link/v1',
      kind: 'bound-invitation',
      applicationOrigin: origin,
      invitation,
    },
    { channel: 'nightly' },
  );
}
test('a canonical invitation is released only when its Station, recipient, expiry and requested lifetime agree', async () => {
  const invitation = issuedInvitation();
  const result = {
    link: invitationLink(invitation),
    expiresAt: invitation.expiresAt,
  };
  http.mutate.mockResolvedValueOnce(Response.json({ data: result }));
  await expect(
    createRelayInvitation(
      'https://station.example',
      invitationRoute,
      recipient,
      '24h',
    ),
  ).resolves.toEqual(result);
});
test.each([
  'malformed',
  'wrong-expiry',
  'wrong-station',
  'wrong-recipient',
  'wrong-origin',
  'wrong-kind',
] as const)(
  'a successful %s response cannot become a confirmed invitation',
  async (mode) => {
    let invitation = issuedInvitation();
    if (mode === 'wrong-station')
      invitation = {
        ...invitation,
        scope: {
          ...invitation.scope,
          stationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        },
      };
    if (mode === 'wrong-recipient')
      invitation = {
        ...invitation,
        surface: { ...invitation.surface, keyThumbprint: 'X'.repeat(43) },
      };
    const link =
      mode === 'malformed'
        ? 'not-a-link'
        : mode === 'wrong-kind'
          ? encodeNativeRelayLink(
              {
                version: 'station-native-relay-link/v1',
                kind: 'route-intent',
                ...invitationRoute,
              },
              { channel: 'nightly' },
            )
          : invitationLink(
              invitation,
              mode === 'wrong-origin'
                ? 'https://other.example'
                : invitationRoute.applicationOrigin,
            );
    http.mutate.mockResolvedValueOnce(
      Response.json({
        data: {
          link,
          expiresAt: mode === 'wrong-expiry' ? 1 : invitation.expiresAt,
        },
      }),
    );
    await expect(
      createRelayInvitation(
        'https://station.example',
        invitationRoute,
        recipient,
        '24h',
      ),
    ).rejects.toThrow();
  },
);

test.each(['malformed', 'wrong-station'] as const)(
  'setup discovery refuses a %s successful link',
  async (mode) => {
    const setupLinks = Object.fromEntries(
      (['stable', 'nightly'] as const).map((channel) => [
        channel,
        encodeNativeRelayLink(
          {
            version: 'station-native-relay-link/v1',
            kind: 'route-intent',
            ...invitationRoute,
          },
          { channel },
        ),
      ]),
    );
    setupLinks.nightly =
      mode === 'malformed'
        ? 'not-a-link'
        : encodeNativeRelayLink(
            {
              version: 'station-native-relay-link/v1',
              kind: 'route-intent',
              ...invitationRoute,
              stationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            },
            { channel: 'nightly' },
          );
    http.get.mockResolvedValueOnce(
      Response.json({
        data: {
          route: invitationRoute,
          confirmationCode: '0123456789ABCDEF',
          keyId: 'K'.repeat(43),
          setupLinks,
          approvals: [],
          pendingDevices: [],
        },
      }),
    );
    await expect(
      getRelayManagement('https://station.example'),
    ).rejects.toThrow();
  },
);

test.each([false, true])(
  'management v2 decodes retained-channel links from a host with legacy wire field: %s',
  async (legacy) => {
    const route = invitationRoute;
    const link = (channel: 'stable' | 'nightly') =>
      encodeNativeRelayLink(
        {
          version: 'station-native-relay-link/v1',
          kind: 'route-intent',
          ...route,
        },
        { channel },
      );
    const stable = link('stable');
    http.get.mockResolvedValueOnce(
      Response.json({
        data: {
          route,
          confirmationCode: '0123456789ABCDEF',
          keyId: 'K'.repeat(43),
          setupLinks: {
            stable,
            nightly: link('nightly'),
            ...(legacy
              ? {
                  beta: stable.replace(
                    /^station-relay-stable:/,
                    'station-relay-beta:',
                  ),
                }
              : {}),
          },
          approvals: [],
          pendingDevices: [],
        },
      }),
    );
    const view = await getRelayManagement('https://station.example');
    expect(view.setupLinks).toEqual({ stable, nightly: link('nightly') });
    expect(view.setupLinks).not.toHaveProperty('beta');
    expect(http.get.mock.calls[0]?.[0]).toBe(
      'https://station.example/api/relay-management?viewVersion=2',
    );
  },
);

test.each([
  'local-approval',
  'foreign-approval',
  'local-pending',
  'mixed',
  'foreign-pending',
  'malformed-beta',
  'mutation-beta',
])(
  'legacy retired records stay read-only and Station scoped: %s',
  async (mode) => {
    const foreign = mode.startsWith('foreign');
    const route = invitationRoute;
    const link = (channel: 'stable' | 'nightly') =>
      encodeNativeRelayLink(
        {
          version: 'station-native-relay-link/v1',
          kind: 'route-intent',
          ...route,
        },
        { channel },
      );
    const surface = {
      kind: 'station-native',
      appIdentifier:
        mode === 'malformed-beta'
          ? 'io.kontourai.station'
          : 'io.kontourai.station.beta',
      channel: 'beta',
      clientInstanceId: '11111111-1111-4111-8111-111111111111',
      keyThumbprint: 'K'.repeat(43),
    };
    const approval = {
      approvalId: '22222222-2222-4222-8222-222222222222',
      revision: 1,
      scope: {
        stationId: foreign
          ? '33333333-3333-4333-8333-333333333333'
          : route.stationId,
        enrollmentId: route.enrollmentId,
        routingGeneration: 1,
      },
      surface,
    };
    const stable = link('stable');
    const pending = {
      enrollmentId: 'E'.repeat(43),
      requestId: approval.approvalId,
      candidate: {
        version: 'station-native-device-binding-candidate/v1',
        stationId: approval.scope.stationId,
        deviceId: approval.approvalId,
        bindingId: approval.approvalId,
        surface,
        deviceProofJwk: {
          kty: 'EC',
          crv: 'P-256',
          x: 'X'.repeat(43),
          y: 'Y'.repeat(43),
        },
        deviceProofKeyThumbprint: 'P'.repeat(43),
      },
      account: {
        issuer: 'https://account.example',
        subject: 'operator',
        displayName: 'Operator',
      },
      requestedScope: 'orchestration:read',
      expiresAt: 1900000000000,
    };
    if (mode === 'mutation-beta') {
      http.mutate.mockResolvedValueOnce(Response.json({ data: approval }));
      await expect(
        approveRelaySetup('https://station.example', {}),
      ).rejects.toThrow();
      return;
    }
    const isPending = mode.endsWith('pending');
    const activeApproval = {
      ...approval,
      approvalId: '44444444-4444-4444-8444-444444444444',
      surface: {
        ...surface,
        channel: 'stable',
        appIdentifier: 'io.kontourai.station',
      },
    };
    const activePending = {
      ...pending,
      candidate: {
        ...pending.candidate,
        surface: {
          ...surface,
          channel: 'nightly',
          appIdentifier: 'io.kontourai.station.nightly',
        },
      },
    };
    http.get.mockResolvedValueOnce(
      Response.json({
        data: {
          route,
          confirmationCode: '0123456789ABCDEF',
          keyId: 'K'.repeat(43),
          setupLinks: {
            stable,
            nightly: link('nightly'),
            beta: stable.replace(
              /^station-relay-stable:/,
              'station-relay-beta:',
            ),
          },
          approvals:
            mode === 'mixed'
              ? [activeApproval, approval]
              : isPending
                ? []
                : [approval],
          pendingDevices:
            mode === 'mixed'
              ? [pending, activePending]
              : isPending
                ? [pending]
                : [],
        },
      }),
    );
    const result = getRelayManagement('https://station.example');
    if (foreign) await expect(result).rejects.toThrow('another Station');
    else if (mode === 'malformed-beta')
      await expect(result).rejects.toThrow('Retired surface identity');
    else {
      await expect(result).resolves.toMatchObject({
        approvals: mode === 'mixed' ? [activeApproval] : [],
        pendingDevices: mode === 'mixed' ? [activePending] : [],
        retiredRecords: {
          approvals: isPending ? 0 : 1,
          pendingDevices: isPending || mode === 'mixed' ? 1 : 0,
        },
      });
    }
  },
);
