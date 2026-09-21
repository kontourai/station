import { PROJECT_MEMBER_ROLES } from '@kontourai/station-contracts/project-membership';
import { humanPrincipal } from '@kontourai/station-contracts/principal';
import { afterEach, expect, test, vi } from 'vitest';
import { changeProjectAccess } from '../client/project-access.js';

afterEach(() => vi.unstubAllGlobals());

const apiBase = 'https://station.example.test';
const scope = {
  stationId: 'station-one',
  localProjectId: 'local-one',
  localProjectSlug: 'example',
  portableProjectId: 'prj_shared',
};
const actor = humanPrincipal('deployment', 'actor', 'Actor');
const other = humanPrincipal('deployment', 'other', 'Other');
const at = '2026-09-20T12:00:00.000Z';
const view = {
  version: 'station.project-membership/v1',
  actingPrincipal: actor,
  scope,
  members: [
    {
      principal: actor,
      role: 'admin',
      actions: [...PROJECT_MEMBER_ROLES.admin],
      status: 'active',
      revision: 1,
      grantedBy: actor,
      updatedAt: at,
    },
  ],
  invitations: [],
};
const invitation = {
  id: 'inv-1',
  recipientEmail: null,
  role: 'viewer',
  actions: [...PROJECT_MEMBER_ROLES.viewer],
  invitedBy: actor,
  status: 'pending',
  expiresAt: '2026-09-27T12:00:00.000Z',
  createdAt: at,
};
const token = `${'t'.repeat(43)}`;

function stubResponder(seen: Array<{ url: string; body: unknown }>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      seen.push({ url: input, body: JSON.parse(String(init?.body ?? '{}')) });
      const url = new URL(input);
      if (url.pathname.endsWith('/invitations') && init?.method === 'POST')
        return Response.json({ success: true, data: { invitation, token } });
      if (url.pathname.endsWith('/revoke'))
        return Response.json({ success: true, data: { changed: true } });
      if (url.pathname.endsWith('/members'))
        return Response.json({ success: true, data: { changed: true } });
      return Response.json({ success: true, data: view });
    }),
  );
}

test('mutations carry the caller-captured expected actor when supplied', async () => {
  const seen: Array<{ url: string; body: unknown }> = [];
  stubResponder(seen);
  await changeProjectAccess(
    apiBase,
    'example',
    {
      kind: 'invite',
      scope,
      email: null,
      role: 'viewer',
      expiresAt: invitation.expiresAt,
      expectedActor: actor.id,
    },
  );
  await changeProjectAccess(apiBase, 'example', {
    kind: 'revoke-invitation',
    scope,
    invitationId: invitation.id,
    expectedActor: actor.id,
  });
  await changeProjectAccess(apiBase, 'example', {
    kind: 'change-member',
    scope,
    principalId: other.id,
    revision: 2,
    role: 'viewer',
    status: 'active',
    expectedActor: actor.id,
  });
  for (const request of seen)
    expect(request.body).toMatchObject({ expectedActor: actor.id });
});

test('mutations omit the precondition when the caller supplies none', async () => {
  const seen: Array<{ url: string; body: unknown }> = [];
  stubResponder(seen);
  await changeProjectAccess(apiBase, 'example', {
    kind: 'revoke-invitation',
    scope,
    invitationId: invitation.id,
  });
  await changeProjectAccess(apiBase, 'example', {
    kind: 'invite',
    scope,
    email: null,
    role: 'viewer',
    expiresAt: invitation.expiresAt,
  });
  for (const request of seen)
    expect(request.body).not.toHaveProperty('expectedActor');
});
