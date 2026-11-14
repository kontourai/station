import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import { AttachmentBlobStore } from '../orchestration/attachment-blob-store.js';
import {
  type ProjectRoomAccessPort,
  ProjectRoomService,
} from './project-room-service.js';
import { createProjectRoomRuntime } from './project-room-store.js';
import { ProjectRoomAttachments } from './task-room-attachments.js';

/**
 * #4852 review: Project-room files share one deduplicated byte store across
 * every Project, binding and process. Releasing a deleted message's files must
 * never take bytes that another process has committed to a message elsewhere.
 *
 * The parent pauses at the latest point a release can still delete bytes:
 * inside `removeByRef`, after its reference scan. There another process, ready
 * to upload the same bytes in another Project, gets a window to publish them.
 * The store lock keeps it out of that window, so its bytes land after the
 * deletion; without the lock it publishes inside the window and loses them.
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
import { readFileSync, writeFileSync } from 'node:fs';
import { ProjectRoomAttachments } from './src-server/services/projects/task-room-attachments.ts';
import { createProjectRoomRuntime } from './src-server/services/projects/project-room-store.ts';
import { ProjectRoomService } from './src-server/services/projects/project-room-service.ts';
const p = JSON.parse(readFileSync(process.env.RACE_INPUT, 'utf8'));
const runtime = createProjectRoomRuntime(p.home);
const access = {
  async withAction(_request, _slug, _action, _expected, operation) {
    return operation(p.scope, p.actor, { view: true, discuss: true, edit: false, execute: false }, () => {});
  },
  async current() { return true; },
};
const service = new ProjectRoomService(runtime.store, access, new ProjectRoomAttachments(p.root));
const request = new Request('http://station');
const room = (await service.open(request, p.scope.localProjectSlug)).data;
const guard = { expectedRoomId: room.roomId, expectedProjectId: p.scope.localProjectId, expectedActorId: p.actor.id };
writeFileSync(p.ready, '');
const [file] = (await service.storeAttachments(request, p.scope.localProjectSlug, guard, [p.input])).data;
writeFileSync(p.published, '');
await service.append(request, p.scope.localProjectSlug, guard, { intentId: p.intent, text: 'Second Project file', attachments: [file] });
service.close();
runtime.close();
process.stdout.write(JSON.stringify({ id: file.id, roomId: room.roomId }));
`;

/** Blocks this thread (the parent is inside a synchronous release). */
function sleepSync(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function waitForFile(path: string, ms: number) {
  const deadline = Date.now() + ms;
  while (!existsSync(path) && Date.now() < deadline) sleepSync(20);
  return existsSync(path);
}

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
    new ProjectRoomAttachments(root),
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

  const ready = join(home, 'child-ready');
  const published = join(home, 'child-published');
  // The parent waits synchronously inside the release, so the child writes
  // to files it can read without the event loop.
  const stdout = join(home, 'child.out');
  const stderr = join(home, 'child.err');
  const errors = () => (existsSync(stderr) ? readFileSync(stderr, 'utf8') : '');
  let finished: Promise<number | null> | undefined;
  // Inputs go through a file too: a pipe would need the event loop to flush.
  const input = join(home, 'child.json');
  writeFileSync(
    input,
    JSON.stringify({
      home,
      root,
      ready,
      published,
      scope: second,
      actor,
      intent: randomUUID(),
      input: png('two.png'),
    }),
  );
  const startElsewhere = () => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', CHILD],
      {
        cwd: process.cwd(),
        env: { ...process.env, RACE_INPUT: input },
        windowsHide: true,
        stdio: ['ignore', openSync(stdout, 'w'), openSync(stderr, 'w')],
      },
    );
    finished = new Promise((resolve) => child.on('close', resolve));
  };
  let paused = false;
  const remove = AttachmentBlobStore.prototype.removeByRef;
  vi.spyOn(AttachmentBlobStore.prototype, 'removeByRef').mockImplementation(
    function (this: AttachmentBlobStore, ref: string) {
      if (!paused) {
        paused = true;
        // The other process is about to upload the same bytes; give it a
        // window to publish them after this release's reference scan.
        startElsewhere();
        expect(waitForFile(ready, 20_000), errors()).toBe(true);
        waitForFile(published, 1_500);
      }
      return remove.call(this, ref);
    },
  );
  await service.deleteMessage(request, 'first', guard, sent.messageId, {
    intentId: randomUUID(),
  });
  expect(paused).toBe(true);
  expect(await finished, errors()).toBe(0);
  const other = JSON.parse(readFileSync(stdout, 'utf8')) as {
    id: string;
    roomId: string;
  };

  // The other Project's message names its file, and its bytes are there.
  const committed = runtime.store.history(second).messages;
  expect(committed.at(-1)?.attachments?.[0]?.id).toBe(other.id);
  const read = new ProjectRoomAttachments(root).read(
    [
      second.stationId,
      second.localProjectId,
      second.portableProjectId,
      other.roomId,
      actor.kind,
      actor.id,
    ],
    other.id,
  );
  expect(read?.bytes).toEqual(PNG);
});
