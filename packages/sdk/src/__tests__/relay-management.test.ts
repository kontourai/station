import { beforeEach, expect, test, vi } from 'vitest';
import { StationHttpError } from '../client/http';
import { readProjectInvitationToken } from '../client/project-access';
import {
  createRelayInvitation,
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
  const pending = createRelayInvitation('https://station.example', {}, '24h');
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
