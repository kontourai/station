import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import {
  type ProjectRoomAccessPort,
  ProjectRoomService,
} from './project-room-service.js';
import { createProjectRoomRuntime } from './project-room-store.js';

const makeTempDir = trackTempDirs();
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
});
it('keeps VIEW discovery lookup-only and requires explicit current DISCUSS admission to provision', async () => {
  const runtime = createProjectRoomRuntime(makeTempDir('room-service-'));
  cleanup.push(runtime.close);
  const scope = {
    stationId: 'station',
    localProjectId: randomUUID(),
    portableProjectId: 'portable',
    localProjectSlug: 'project',
  };
  let discuss = false;
  let live = true;
  const port: ProjectRoomAccessPort = {
    async withAction(_request, _slug, action, _expected, operation) {
      if (action === 'discuss' && !discuss) throw new Error('forbidden');
      return operation(
        scope,
        { id: 'person', kind: 'person', displayName: 'Person' },
        { view: true, discuss, edit: false, execute: false },
        () => {
          if (!live) throw new Error('revoked');
        },
      );
    },
    async current() {
      return live;
    },
  };
  const service = new ProjectRoomService(runtime.store, port);
  cleanup.push(() => service.close());
  const request = new Request('http://localhost/project');
  await expect(service.discover(request, 'project')).rejects.toThrow(
    'not_found',
  );
  expect(runtime.store.lookupRoom(scope)).toBeNull();
  await expect(service.open(request, 'project')).rejects.toThrow('forbidden');
  discuss = true;
  live = false;
  await expect(service.open(request, 'project')).rejects.toThrow('revoked');
  expect(runtime.store.lookupRoom(scope)).toBeNull();
  live = true;
  const opened = await service.open(request, 'project');
  discuss = false;
  expect((await service.discover(request, 'project')).data.roomId).toBe(
    opened.data.roomId,
  );
  expect(
    (await service.discover(request, 'project')).data.capabilities.discuss,
  ).toBe(false);
});
