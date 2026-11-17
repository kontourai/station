import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import {
  type ProjectRoomAccessPort,
  ProjectRoomService,
} from '../projects/project-room-service.js';
import { createProjectRoomRuntime } from '../projects/project-room-store.js';
import { projectRoomVersionSource } from './room-version-sources.js';

const makeTempDir = trackTempDirs();
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
});

/**
 * #4792 + #3075: a Project has many channels, each its own room. The read
 * marker version for a channel is that channel's own sequence, read through
 * the real room service, so the sidebar's unread state follows each channel.
 */
it('reads each channel’s own version, #general included, and refuses an unknown room id', async () => {
  const runtime = createProjectRoomRuntime(makeTempDir('room-versions-'));
  cleanup.push(runtime.close);
  const scope = {
    stationId: 'station',
    localProjectId: randomUUID(),
    portableProjectId: 'portable',
    localProjectSlug: 'alpha',
  };
  const actor = { id: 'person', kind: 'person' as const, displayName: 'Ada' };
  const current = () => {};
  const port: ProjectRoomAccessPort = {
    async withAction(_request, _slug, _action, _expected, operation) {
      return operation(
        scope,
        { ...actor },
        { view: true, discuss: true, edit: true, execute: false },
        current,
      );
    },
    async current() {
      return true;
    },
  };
  const service = new ProjectRoomService(runtime.store, port);
  cleanup.push(() => service.close());
  const request = new Request('http://localhost/alpha');
  const general = (await service.open(request, 'alpha')).data.roomId;
  const design = runtime.store.createChannel(
    scope,
    { name: 'design' },
    current,
  ).channelId;
  const post = (channelId?: string) =>
    runtime.store.append(
      scope,
      actor,
      { intentId: randomUUID(), text: 'hello' },
      current,
      channelId,
    );
  post();
  post(design);
  post(design);
  post(design);

  const versions = projectRoomVersionSource(service);
  expect(
    await versions.latest({ projectSlug: 'alpha', roomId: general }, request),
  ).toEqual({ key: `project-room:${general}`, latestVersion: 1 });
  expect(
    await versions.latest({ projectSlug: 'alpha', roomId: design }, request),
  ).toEqual({ key: `project-room:${design}`, latestVersion: 3 });
  expect(
    await versions.latest(
      { projectSlug: 'alpha', roomId: randomUUID() },
      request,
    ),
  ).toBeUndefined();
});
