import { humanPrincipal } from '@kontourai/station-contracts/principal';
import { afterEach, expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { FileStorageAdapter } from '../../../domain/file-storage-adapter.js';
import { ProjectManifestStore } from '../../../services/projects/project-manifest-store.js';
import { createProjectMembershipRuntime } from '../../../services/projects/project-membership-runtime.js';
import type { ProjectMembershipAuthority } from '../../../services/projects/project-membership-service.js';
import { ProjectMembershipRefusal } from '../../../services/projects/project-membership-store.js';
import { ProjectRoomService } from '../../../services/projects/project-room-service.js';
import { createProjectRoomRuntime } from '../../../services/projects/project-room-store.js';
import { ProjectService } from '../../../services/projects/project-service.js';
import { createProjectRoomAccess } from '../project-room-access.js';

const temp = trackTempDirs();
const close: Array<() => void> = [];
afterEach(() => {
  for (const dispose of close.splice(0).reverse()) dispose();
});
const owner = humanPrincipal('fixture', 'owner', 'Asha');
const member = humanPrincipal('fixture', 'member', 'Jamie');
async function fixture() {
  const home = temp('project-room-access-');
  const storage = new FileStorageAdapter(home);
  const manifests = new ProjectManifestStore(home, storage);
  const projects = new ProjectService(storage, manifests);
  const project = await projects.createProject({
    name: 'Example',
    slug: 'example',
  });
  const membership = createProjectMembershipRuntime(home, 'station', storage);
  close.push(() => membership.close());
  const rooms = createProjectRoomRuntime(home);
  close.push(() => rooms.close());
  let acting = owner,
    memberMode = false,
    transport = true;
  const authority: ProjectMembershipAuthority = {
    current: async () => {
      if (!transport) throw new ProjectMembershipRefusal('forbidden');
      return { principal: acting, verifiedEmails: [] };
    },
    operator: async () => {
      if (acting.id !== owner.id)
        throw new ProjectMembershipRefusal('forbidden');
    },
  };
  const access = createProjectRoomAccess({
    stationId: 'station',
    storage,
    manifests,
    membership: membership.service,
    member: async () => (memberMode ? authority : undefined),
    authority: () => authority,
    current: () => transport,
    allows: () => true,
  });
  const service = new ProjectRoomService(rooms.store, access);
  close.push(() => service.close());
  return {
    storage,
    projects,
    project,
    membership,
    rooms,
    access,
    service,
    authority,
    actor: (value: typeof owner, shared = false) => {
      acting = value;
      memberMode = shared;
    },
    revokeTransport: () => {
      transport = false;
    },
  };
}

test('real Room operations use current author, Project incarnation and separate discuss/edit/execute membership', async () => {
  const f = await fixture(),
    request = new Request('http://station.test/api/projects/example/room');
  const enabled = await f.membership.service.enable(
    'example',
    f.project.id,
    f.authority,
  );
  const offer = await f.membership.service.invite(
    enabled.scope,
    {
      email: null,
      role: 'contributor',
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    },
    f.authority,
  );
  f.actor(member, true);
  await f.membership.service.accept(offer.token, f.authority);
  f.rooms.store.ensureRoom(enabled.scope, () => {});
  const discovered = await f.service.discover(request, 'example');
  expect(discovered.data).toMatchObject({
    actor: { id: member.id, displayName: 'Jamie' },
    capabilities: { view: true, discuss: true, edit: true, execute: true },
  });
  const guards = {
    expectedRoomId: discovered.data.roomId,
    expectedProjectId: f.project.id,
    expectedActorId: member.id,
  };
  const result = await f.service.append(request, 'example', guards, {
    intentId: '11111111-1111-4111-8111-111111111111',
    text: 'Shared discussion',
  });
  expect(result.data.actor.id).toBe(member.id);
  f.actor(owner);
  const current = f.membership.service.admissionsForResolvedPrincipal(
    member.id,
  )[0].member;
  await f.membership.service.changeMember(
    enabled.scope,
    member.id,
    current.revision,
    { role: 'viewer', status: 'active' },
    f.authority,
  );
  f.actor(member, true);
  expect(
    (await f.service.discover(request, 'example')).data.capabilities.discuss,
  ).toBe(false);
  await expect(
    f.service.append(request, 'example', guards, {
      intentId: '22222222-2222-4222-8222-222222222222',
      text: 'Refused',
    }),
  ).rejects.toMatchObject({ code: 'forbidden' });
  expect(
    (await f.service.history(request, 'example', 0, 50)).data.messages,
  ).toHaveLength(1);
  f.actor(owner);
  await expect(
    f.service.append(request, 'example', guards, {
      intentId: '33333333-3333-4333-8333-333333333333',
      text: 'Stale Jamie intent',
    }),
  ).rejects.toMatchObject({ code: 'forbidden' });
  f.revokeTransport();
  expect(await f.service.current(request, discovered.admission)).toBe(false);
});
