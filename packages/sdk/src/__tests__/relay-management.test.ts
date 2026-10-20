import type { SelfHostedBrokerNativeRouteInvitationV2 } from '@kontourai/station-contracts/self-hosted-broker';
import { encodeNativeRelayLink } from '@kontourai/station-shared/native-relay-link';
import { beforeEach, expect, test, vi } from 'vitest';
import { StationHttpError } from '../client/http';
import { readProjectInvitationToken } from '../client/project-access';
import {
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
      (['stable', 'beta', 'nightly'] as const).map((channel) => [
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
