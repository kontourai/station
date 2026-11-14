import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import { AttachmentBlobStore } from '../orchestration/attachment-blob-store.js';
import {
  type ProjectRoomAccessPort,
  ProjectRoomService,
} from './project-room-service.js';
import { createProjectRoomRuntime } from './project-room-store.js';
import { RoomAttachments } from './task-room-attachments.js';

/**
 * #4852 review: Project-room files share one deduplicated byte store across
 * every Project, binding and process. Releasing a deleted message's files must
 * never take bytes that another process has, at that moment, committed to a
 * message elsewhere. The other process runs at the latest point the release
 * could still delete bytes: inside `removeByRef` if the release ever calls it
 * (after any reference scan), otherwise right after the delete.
 */

const makeTempDir = trackTempDirs();
const cleanup: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0)) close();
});

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
const png = (name: string) => ({
  kind: 'image' as const,
  name,
  mimeType: 'image/png' as const,
  size: PNG.length,
  dataUrl: `data:image/png;base64,${PNG.toString('base64')}`,
});
const actor = { id: 'alice', kind: 'person' as const, displayName: 'Alice' };
const scopeFor = (slug: string, localProjectId: string) => ({
  stationId: 'station',
  localProjectId,
  portableProjectId: `portable-${slug}`,
  localProjectSlug: slug,
});

/** One person with discuss in every Project this port is asked about. */
function port(scopes: Record<string, ReturnType<typeof scopeFor>>) {
  const access: ProjectRoomAccessPort = {
    async withAction(_request, slug, _action, _expected, operation) {
      return operation(
        scopes[slug]!,
        actor,
        { view: true, discuss: true, edit: false, execute: false },
        () => {},
      );
    },
    async current() {
      return true;
    },
  };
  return access;
}

/** The other process: the production service on the same home and store. */
const CHILD = `
import { readFileSync } from 'node:fs';
import { RoomAttachments } from './src-server/services/projects/task-room-attachments.ts';
import { createProjectRoomRuntime } from './src-server/services/projects/project-room-store.ts';
import { ProjectRoomService } from './src-server/services/projects/project-room-service.ts';
const p = JSON.parse(readFileSync(0, 'utf8'));
const runtime = createProjectRoomRuntime(p.home);
const access = {
  async withAction(_request, _slug, _action, _expected, operation) {
    return operation(p.scope, p.actor, { view: true, discuss: true, edit: false, execute: false }, () => {});
  },
  async current() { return true; },
};
const service = new ProjectRoomService(runtime.store, access, new RoomAttachments(p.root, 'room'));
const request = new Request('http://station');
const room = (await service.open(request, p.scope.localProjectSlug)).data;
const guard = { expectedRoomId: room.roomId, expectedProjectId: p.scope.localProjectId, expectedActorId: p.actor.id };
const [file] = (await service.storeAttachments(request, p.scope.localProjectSlug, guard, [p.input])).data;
await service.append(request, p.scope.localProjectSlug, guard, { intentId: p.intent, text: 'Second Project file', attachments: [file] });
service.close();
runtime.close();
process.stdout.write(JSON.stringify({ id: file.id, roomId: room.roomId }));
`;

it('releasing a deleted message never takes bytes another process commits to a message in another Project', async () => {
  const home = makeTempDir('room-release-race-');
  const root = join(home, 'project-room-attachments');
  const first = scopeFor('first', randomUUID());
  const second = scopeFor('second', randomUUID());
  const runtime = createProjectRoomRuntime(home);
  cleanup.push(runtime.close);
  const service = new ProjectRoomService(
    runtime.store,
    port({ first, second }),
    new RoomAttachments(root, 'room'),
  );
  cleanup.push(() => service.close());
  const request = new Request('http://station');
  const room = (await service.open(request, 'first')).data;
  const guard = {
    expectedRoomId: room.roomId,
    expectedProjectId: first.localProjectId,
    expectedActorId: actor.id,
  };
  const [file] = (
    await service.storeAttachments(request, 'first', guard, [png('one.png')])
  ).data;
  const sent = (
    await service.append(request, 'first', guard, {
      intentId: randomUUID(),
      text: '',
      attachments: [file!],
    })
  ).data;

  let other: { id: string; roomId: string } | undefined;
  const commitElsewhere = () => {
    const child = spawnSync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', CHILD],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        timeout: 60_000,
        windowsHide: true,
        input: JSON.stringify({
          home,
          root,
          scope: second,
          actor,
          intent: randomUUID(),
          input: png('two.png'),
        }),
      },
    );
    expect(child.status, child.stderr).toBe(0);
    other = JSON.parse(child.stdout);
  };
  const remove = AttachmentBlobStore.prototype.removeByRef;
  vi.spyOn(AttachmentBlobStore.prototype, 'removeByRef').mockImplementation(
    function (this: AttachmentBlobStore, ref: string) {
      if (!other) commitElsewhere();
      return remove.call(this, ref);
    },
  );
  await service.deleteMessage(request, 'first', guard, sent.messageId, {
    intentId: randomUUID(),
  });
  if (!other) commitElsewhere();

  // The other Project's message names its file, and its bytes are there.
  const committed = runtime.store.history(second).messages;
  expect(committed.at(-1)?.attachments?.[0]?.id).toBe(other!.id);
  const read = new RoomAttachments(root, 'room').read(
    [
      second.stationId,
      second.localProjectId,
      second.portableProjectId,
      other!.roomId,
      actor.kind,
      actor.id,
    ],
    other!.id,
  );
  expect(read?.bytes).toEqual(PNG);
});
