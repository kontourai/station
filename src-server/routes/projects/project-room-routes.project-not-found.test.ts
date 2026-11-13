import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { humanPrincipal } from '@kontourai/station-contracts/principal';
import { PROJECT_ROOM_PROJECT_NOT_FOUND_CODE } from '@kontourai/station-contracts/project-room';
import { Hono } from 'hono';
import { afterEach, expect, test } from 'vitest';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import { FileStorageAdapter } from '../../domain/file-storage-adapter.js';
import { createProjectRoomAccess } from '../../runtime/routes/project-room-access.js';
import { ProjectManifestStore } from '../../services/projects/project-manifest-store.js';
import { createProjectMembershipRuntime } from '../../services/projects/project-membership-runtime.js';
import type { ProjectMembershipAuthority } from '../../services/projects/project-membership-service.js';
import { ProjectRoomService } from '../../services/projects/project-room-service.js';
import { createProjectRoomRuntime } from '../../services/projects/project-room-store.js';
import { ProjectService } from '../../services/projects/project-service.js';
import { createProjectRoomRoutes } from './project-room-routes.js';

/**
 * A room route for a Project this Station does not have answers 404 with
 * its own code, not 503 "unavailable" (#4855); a real storage outage still
 * answers 503. Real file storage and the runtime's own access port: the
 * operator path reads the Project record exactly as production does.
 */
const temp = trackTempDirs();
const close: Array<() => void> = [];
afterEach(() => {
  for (const dispose of close.splice(0).reverse()) dispose();
});
const owner = humanPrincipal('fixture', 'owner', 'Asha');

async function station() {
  const home = temp('project-room-not-found-');
  const storage = new FileStorageAdapter(home);
  const manifests = new ProjectManifestStore(home, storage);
  await new ProjectService(storage, manifests).createProject({
    name: 'Example',
    slug: 'example',
  });
  const membership = createProjectMembershipRuntime(home, 'station', storage);
  close.push(() => membership.close());
  const rooms = createProjectRoomRuntime(home);
  close.push(() => rooms.close());
  const authority: ProjectMembershipAuthority = {
    current: async () => ({ principal: owner, verifiedEmails: [] }),
    operator: async () => {},
  };
  const service = new ProjectRoomService(
    rooms.store,
    createProjectRoomAccess({
      stationId: 'station',
      storage,
      manifests,
      membership: membership.service,
      member: async () => undefined,
      authority: () => authority,
      current: () => true,
      allows: () => true,
    }),
  );
  close.push(() => service.close());
  const app = new Hono();
  app.route('/api/projects', createProjectRoomRoutes(service));
  const get = async (path: string) => {
    const response = await app.request(`/api/projects${path}`);
    return { status: response.status, body: await response.json() };
  };
  return { home, get };
}

test('an unknown Project answers 404 "no such Project" for its channels and its room', async () => {
  const { get } = await station();
  // The known Project is the control: its channels read succeeds.
  expect((await get('/example/channels')).status).toBe(200);
  for (const path of ['/nowhere/channels', '/nowhere/room']) {
    const answer = await get(path);
    expect(answer, path).toEqual({
      status: 404,
      body: { error: { code: PROJECT_ROOM_PROJECT_NOT_FOUND_CODE } },
    });
  }
  // Pinned beside the constant: the wire code clients branch on.
  expect(PROJECT_ROOM_PROJECT_NOT_FOUND_CODE).toBe(
    'project_room_project_not_found',
  );
});

test('a Project record that cannot be read is still an outage: 503', async () => {
  const { home, get } = await station();
  // The record exists but cannot be read (a directory where the file was):
  // storage is unavailable, not the Project missing.
  const record = join(home, 'projects', 'example', 'project.json');
  rmSync(record);
  mkdirSync(record);
  for (const path of ['/example/channels', '/example/room']) {
    const answer = await get(path);
    expect(answer, path).toEqual({
      status: 503,
      body: { error: { code: 'project_room_unavailable' } },
    });
  }
});
