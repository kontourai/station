import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { acquireFileMutationLockAsync } from '@kontourai/station-shared/lifecycle-events';
import { afterEach, expect, it, vi } from 'vitest';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import { AttachmentBlobStore } from '../orchestration/attachment-blob-store.js';
import {
  type ProjectRoomAccessPort,
  ProjectRoomService,
} from './project-room-service.js';
import { createProjectRoomRuntime } from './project-room-store.js';
import {
  ProjectRoomAttachments,
  TaskRoomAttachmentCapacityError,
  TaskRoomAttachments,
} from './task-room-attachments.js';

/**
 * #4852 review: Project-room files share one deduplicated byte store across
 * every Project, binding and process. Releasing a deleted message's files must
 * never take bytes that another process has committed to a message elsewhere.
 *
 * The parent pauses at the latest point a release can still delete bytes:
 * inside `removeByRefConfirmed`, after its reference scan. There another process, ready
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
  // Pause at the real deletion point, after the release's reference scan.
  const remove = AttachmentBlobStore.prototype.removeByRefConfirmed;
  vi.spyOn(
    AttachmentBlobStore.prototype,
    'removeByRefConfirmed',
  ).mockImplementation(function (this: AttachmentBlobStore, ref: string) {
    if (!paused) {
      paused = true;
      // The other process is about to upload the same bytes; give it a
      // window to publish them after this release's reference scan.
      startElsewhere();
      expect(waitForFile(ready, 20_000), errors()).toBe(true);
      waitForFile(published, 1_500);
    }
    return remove.call(this, ref);
  });
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

/** The other process: cycles of upload, send and delete in its own Project. */
const CYCLING_CHILD = `
import { readFileSync } from 'node:fs';
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
const slug = p.scope.localProjectSlug;
const room = (await service.open(request, slug)).data;
const guard = { expectedRoomId: room.roomId, expectedProjectId: p.scope.localProjectId, expectedActorId: p.actor.id };
const send = async (input) => {
  const [file] = (await service.storeAttachments(request, slug, guard, [input])).data;
  const message = (await service.append(request, slug, guard, { intentId: crypto.randomUUID(), text: '', attachments: [file] })).data;
  return { file, message };
};
for (const input of p.cycles) {
  const { message } = await send(input);
  await service.deleteMessage(request, slug, guard, message.messageId, { intentId: crypto.randomUUID() });
}
const live = await send(p.live);
service.close();
runtime.close();
process.stdout.write(JSON.stringify({ id: live.file.id, roomId: room.roomId }));
`;

it('bytes on disk are exactly the bytes live files name, across release and re-upload in two processes', async () => {
  const { readdirSync } = await import('node:fs');
  const home = makeTempDir('room-release-accounting-');
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
  const variant = (name: string) => {
    const bytes = Buffer.concat([PNG, Buffer.from(name)]);
    return {
      ...png(`${name}.png`),
      size: bytes.length,
      dataUrl: `data:image/png;base64,${bytes.toString('base64')}`,
      bytes,
    };
  };
  const input = ({ bytes: _bytes, ...rest }: ReturnType<typeof variant>) =>
    rest;
  const sendHere = async (file: ReturnType<typeof variant>) => {
    const [stored] = (
      await service.storeAttachments(request, 'first', guard, [input(file)])
    ).data;
    const message = (
      await service.append(request, 'first', guard, {
        intentId: randomUUID(),
        text: '',
        attachments: [stored!],
      })
    ).data;
    return { stored: stored!, message };
  };
  // This process's live file: its bytes are also uploaded, sent and deleted
  // by the other process, so a release that ignored references would take it.
  const shared = variant('shared');
  const mine = await sendHere(shared);

  const stdout = join(home, 'child.out');
  const stderr = join(home, 'child.err');
  const inputFile = join(home, 'child.json');
  writeFileSync(
    inputFile,
    JSON.stringify({
      home,
      root,
      scope: second,
      actor,
      cycles: [
        input(shared),
        ...[1, 2, 3, 4, 5].map((n) => input(variant(`child-${n}`))),
      ],
      live: input(variant('child-live')),
    }),
  );
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', CYCLING_CHILD],
    {
      cwd: process.cwd(),
      env: { ...process.env, RACE_INPUT: inputFile },
      windowsHide: true,
      stdio: ['ignore', openSync(stdout, 'w'), openSync(stderr, 'w')],
    },
  );
  const finished = new Promise<number | null>((resolve) =>
    child.on('close', resolve),
  );
  // Meanwhile this process cycles too, through the same store.
  for (const n of [1, 2, 3, 4, 5]) {
    const { message } = await sendHere(variant(`parent-${n}`));
    await service.deleteMessage(request, 'first', guard, message.messageId, {
      intentId: randomUUID(),
    });
  }
  expect(await finished, readFileSync(stderr, 'utf8')).toBe(0);
  const theirs = JSON.parse(readFileSync(stdout, 'utf8')) as {
    id: string;
    roomId: string;
  };

  // Only the two live files keep bindings, and the blobs on disk are exactly
  // the ones those bindings name: nothing released stays, nothing live went.
  const bindings = join(root, 'bindings');
  const named = new Set<string>();
  let files = 0;
  for (const key of readdirSync(bindings))
    for (const name of readdirSync(join(bindings, key))) {
      files += 1;
      named.add(
        (
          JSON.parse(readFileSync(join(bindings, key, name), 'utf8')) as {
            blobRef: string;
          }
        ).blobRef.slice('sha256-'.length),
      );
    }
  const blobs = new Set<string>();
  for (const prefix of readdirSync(join(root, 'blobs')))
    for (const digest of readdirSync(join(root, 'blobs', prefix)))
      blobs.add(digest);
  expect(files).toBe(2);
  expect([...blobs].sort()).toEqual([...named].sort());
  const store = new ProjectRoomAttachments(root);
  const binding = (scope: typeof first, roomId: string) => [
    scope.stationId,
    scope.localProjectId,
    scope.portableProjectId,
    roomId,
    actor.kind,
    actor.id,
  ];
  expect(
    store.read(binding(first, room.roomId), mine.stored.id)?.bytes,
  ).toEqual(shared.bytes);
  expect(store.read(binding(second, theirs.roomId), theirs.id)?.bytes).toEqual(
    variant('child-live').bytes,
  );
});

it('an upload waiting on the store lock is refused if access is revoked meanwhile, and writes nothing', async () => {
  const { readdirSync } = await import('node:fs');
  const home = makeTempDir('room-lock-revocation-');
  const root = join(home, 'project-room-attachments');
  const first = scopeFor('first', randomUUID());
  const runtime = createProjectRoomRuntime(home);
  cleanup.push(runtime.close);
  let allowed = true;
  const revocable: ProjectRoomAccessPort = {
    async withAction(_request, _slug, _action, _expected, operation) {
      if (!allowed) throw new Error('access revoked');
      return operation(
        first,
        actor,
        { view: true, discuss: true, edit: false, execute: false },
        () => {
          if (!allowed) throw new Error('access revoked');
        },
      );
    },
    async current() {
      return allowed;
    },
  };
  const service = new ProjectRoomService(
    runtime.store,
    revocable,
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
  // Another holder (as another process would) keeps the store lock.
  mkdirSync(root, { recursive: true });
  const unlock = await acquireFileMutationLockAsync(join(root, 'store.lock'));
  let settled = false;
  const upload = service
    .storeAttachments(request, 'first', guard, [png('late.png')])
    .finally(() => {
      settled = true;
    });
  upload.catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 300));
  // Still waiting on the lock: its authority check has not run yet.
  expect(settled).toBe(false);
  allowed = false;
  await unlock();
  await expect(upload).rejects.toThrow();
  const bindings = join(root, 'bindings');
  const files = existsSync(bindings)
    ? readdirSync(bindings).flatMap((key) => readdirSync(join(bindings, key)))
    : [];
  expect(files).toEqual([]);
});

it('Task-room uploads cannot bypass another process’s store lock or its committed byte budget', async () => {
  const root = makeTempDir('task-room-lock-contention-');
  const first = png('first.png');
  const other = {
    ...png('other.png'),
    size: PNG.length + 1,
    dataUrl: `data:image/png;base64,${Buffer.concat([PNG, Buffer.from([1])]).toString('base64')}`,
  };
  vi.stubEnv('STATION_ATTACHMENT_MAX_BYTES', String(other.size));
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      `
        import { once } from 'node:events';
        import { TaskRoomAttachments } from './src-server/services/projects/task-room-attachments.ts';
        const files = new TaskRoomAttachments(process.env.TASK_ROOM_LOCK_ROOT);
        const input = JSON.parse(process.env.TASK_ROOM_LOCK_INPUT);
        const uploaded = await files.store(async () => {
          const release = once(process, 'message');
          process.send('locked');
          await release;
          return { projectId: 'project', taskId: 'first', taskCreatedAt: '2026-10-01T00:00:00.000Z' };
        }, [input]);
        if (uploaded?.length !== 1) throw new Error('First upload did not publish');
        process.disconnect();
      `,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        TASK_ROOM_LOCK_ROOT: root,
        TASK_ROOM_LOCK_INPUT: JSON.stringify(first),
      },
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    },
  );
  const finished = once(child, 'exit');
  try {
    const [message] = await once(child, 'message', {
      signal: AbortSignal.timeout(8_000),
    });
    expect(message).toBe('locked');
    const store = new TaskRoomAttachments(root);
    const scope = async () => ({
      projectId: 'project',
      taskId: 'other',
      taskCreatedAt: '2026-10-01T00:00:00.000Z',
    });
    await expect(store.store(scope, [other])).rejects.toThrow(
      'lifecycle journal lock is held by a live process',
    );
    expect(existsSync(join(root, 'blobs'))).toBe(false);
    child.send('release');
    expect(await finished).toEqual([0, null]);
    await expect(store.store(scope, [other])).rejects.toBeInstanceOf(
      TaskRoomAttachmentCapacityError,
    );
    await expect(store.store(scope, [first])).resolves.toHaveLength(1);
  } finally {
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL');
    await finished;
    vi.unstubAllEnvs();
  }
}, 30_000);

it('exact notice-journey helper fails when its limit note never appears, then passes restored', async () => {
  const { chromium, expect: browserExpect } = await import('@playwright/test');
  const source = readFileSync(
    'tests/project-room-message-actions.spec.ts',
    'utf8',
  );
  const helper = source.slice(
    source.indexOf('      const pageBack = async'),
    source.indexOf('      const readable = async'),
  );
  const limit = source.slice(
    source.indexOf('      const limit = (client'),
    source.indexOf('      const unloaded = (client'),
  );
  expect(helper).toContain('older.or(limit(client))');
  // Erase only the two Client annotations; execute the spec's exact helper.
  expect((limit + helper).split('(client: Client)').length - 1).toBe(2);
  const compiled = (limit + helper).replaceAll('(client: Client)', '(client)');
  const pageBack = new Function('expect', `${compiled}; return pageBack;`)(
    browserExpect,
  );
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    for (const mode of ['baseline', 'injected', 'restored']) {
      // Deliberately a browser fixture of the assertion helper, not a Station journey.
      await page.setContent(
        `<main role="region" aria-label="Project room"><button>Load earlier messages</button></main><script>window.presses=0;document.querySelector('button').onclick=()=>{window.presses++;if(window.presses===20 && ${JSON.stringify(mode)}!=='injected'){document.querySelector('button').remove();const note=document.createElement('p');note.setAttribute('role','status');note.textContent='This view keeps the latest 500 messages.';document.querySelector('main').append(note);}}</script>`,
      );
      const client = {
        page,
        room: page.getByRole('region', { name: 'Project room' }),
      };
      if (mode === 'injected') {
        await expect(pageBack(client)).rejects.toThrow();
        expect(await page.evaluate('window.presses')).toBe(25);
        console.log(
          'R4_NOTICE_CONTROL injected: assertion failed after 25 working button presses without a note',
        );
      } else {
        await pageBack(client);
        expect(await page.evaluate('window.presses')).toBe(20);
        console.log(`R4_NOTICE_CONTROL ${mode}: PASS after 20 presses`);
      }
    }
  } finally {
    await browser.close();
  }
}, 75000);

it('lock spans awaits, excludes a second caller, and releases after callback rejection', async () => {
  const home = makeTempDir('room-lock-await-');
  const root = join(home, 'files');
  const files = new ProjectRoomAttachments(root);
  let finish!: () => void;
  const hold = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let entered = false,
    secondEntered = false;
  const first = files.locked(async () => {
    entered = true;
    await hold;
    throw new Error('operation failed');
  });
  const firstResult = first.then(
    () => ({ kind: 'resolved' }),
    (error) => ({ kind: 'rejected', error }),
  );
  while (!entered) await new Promise((resolve) => setTimeout(resolve, 10));
  const second = files.locked(() => {
    secondEntered = true;
    return 'second';
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(secondEntered).toBe(false);
  } finally {
    finish();
  }
  expect(await firstResult).toMatchObject({
    kind: 'rejected',
    error: expect.any(Error),
  });
  expect(await second).toBe('second');
  expect(secondEntered).toBe(true);
  expect(
    await files.locked(() =>
      files.store(['binding'], [png('after-error.png')]),
    ),
  ).toHaveLength(1);
});

it('persisted block survives an actual child-process restart, is per store, and repair clears without a release', async () => {
  const { rmSync } = await import('node:fs');
  const home = makeTempDir('room-restart-block-');
  const root = join(home, 'files');
  const directory = join(root, 'bindings', 'bad');
  mkdirSync(directory, { recursive: true });
  const damaged = join(directory, `${randomUUID()}.json`);
  writeFileSync(damaged, '{');
  const files = new ProjectRoomAttachments(root);
  expect(
    await files.locked(() => files.release(['empty'], [randomUUID()])),
  ).toBe('blocked');
  const config = join(home, 'child-input.json');
  writeFileSync(config, JSON.stringify({ root, input: png('restart.png') }));
  const script = `
    import {readFileSync,existsSync} from 'node:fs';
    import {ProjectRoomAttachments,ProjectRoomFilesUnavailable} from './src-server/services/projects/task-room-attachments.ts';
    const {root,input}=JSON.parse(readFileSync(process.env.RACE_INPUT,'utf8'));
    const store=new ProjectRoomAttachments(root);let blocked=false,stored=false;
    try {await store.locked(()=>store.store(['new-uploader'],[input]));stored=true;}
    catch(error) {if(!(error instanceof ProjectRoomFilesUnavailable))throw error;blocked=true;}
    const other=new ProjectRoomAttachments(root+'-other');
    const independent=(await other.locked(()=>other.store(['independent'],[input]))).length;
    process.stdout.write(JSON.stringify({blocked,stored,independent,marker:existsSync(root+'/reclamation-blocked.json')}));
  `;
  const run = () =>
    new Promise<{
      blocked: boolean;
      stored: boolean;
      independent: number;
      marker: boolean;
    }>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '-e', script],
        {
          cwd: process.cwd(),
          env: { ...process.env, RACE_INPUT: config },
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let out = '',
        err = '';
      child.stdout.on('data', (b) => {
        out += b;
      });
      child.stderr.on('data', (b) => {
        err += b;
      });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code !== 0) reject(new Error(err));
        else resolve(JSON.parse(out));
      });
    });
  const blocked = await run();
  expect(blocked).toEqual({
    blocked: true,
    stored: false,
    independent: 1,
    marker: true,
  });
  rmSync(damaged);
  const repaired = await run();
  expect(repaired).toEqual({
    blocked: false,
    stored: true,
    independent: 1,
    marker: false,
  });
  console.log('R4_PROCESS_RESTART', JSON.stringify({ blocked, repaired }));
});

it.skipIf(process.getuid?.() === 0)(
  'a warmed peer process refuses uploads after another process found damage it could not write down (#4852 review)',
  async () => {
    const fs = await import('node:fs');
    const { createHash } = await import('node:crypto');
    const { createInterface } = await import('node:readline');
    const root = makeTempDir('r5-warmed-peer-');
    const files = new ProjectRoomAttachments(root);
    const binding = ['owner'];
    const [owned] = await files.locked(() =>
      files.store(binding, [png('owner.png')]),
    );
    const key = createHash('sha256')
      .update(JSON.stringify(binding))
      .digest('hex');
    const record = join(root, 'bindings', key, `${owned!.id}.json`);
    const code = `
 import {ProjectRoomAttachments} from './src-server/services/projects/task-room-attachments.ts';
 import {createInterface} from 'node:readline';
 const f=new ProjectRoomAttachments(process.env.R5_ROOT);
 const input=JSON.parse(process.env.R5_INPUT);
 await f.locked(()=>f.store(['peer'],[input]));
 console.log('READY');
 for await(const command of createInterface({input:process.stdin})){
  try{await f.locked(()=>f.store(['peer'],[input]));console.log(JSON.stringify({blocked:false}));}
  catch(e){console.log(JSON.stringify({blocked:true,name:e.name,code:e.code}));}
  break;
 }
 `;
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', code],
      {
        windowsHide: true,
        cwd: process.cwd(),
        env: {
          ...process.env,
          R5_ROOT: root,
          R5_INPUT: JSON.stringify(png('peer.png')),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    const exited = new Promise((resolve) => child.on('close', resolve));
    let stderr = '';
    child.stderr.on('data', (c) => (stderr += c));
    const lines = createInterface({ input: child.stdout })[
      Symbol.asyncIterator
    ]();
    try {
      expect((await lines.next()).value, stderr).toBe('READY');
      fs.writeFileSync(record, '{');
      const staging = join(root, 'staging');
      fs.chmodSync(staging, 0o500);
      let outcome: string;
      try {
        outcome = await files.locked(() => files.release(binding, [owned!.id]));
      } finally {
        fs.chmodSync(staging, 0o700);
      }
      expect(outcome!).toBe('blocked');
      expect(fs.existsSync(join(root, 'reclamation-blocked.json'))).toBe(false);
      child.stdin.write('upload\n');
      child.stdin.end();
      const line = (await lines.next()).value;
      const result = JSON.parse(line!);
      expect(await exited, stderr).toBe(0);
      console.log(
        'R5_WARMED_PEER',
        JSON.stringify({ outcome: outcome!, marker: false, ...result }),
      );
      expect(result.blocked).toBe(true);
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
      await exited;
    }
  },
  30000,
);

it('a crash after a blob unlink but before its record goes keeps the retry, and a later release recovers (#4852 review)', async () => {
  const fs = await import('node:fs');
  const { createHash } = await import('node:crypto');
  const root = makeTempDir('r5-crash-delete-');
  const f = new ProjectRoomAttachments(root);
  const binding = ['owner'];
  const [file] = await f.locked(() => f.store(binding, [png('crash.png')]));
  const key = createHash('sha256')
    .update(JSON.stringify(binding))
    .digest('hex');
  const path = join(root, 'bindings', key, `${file!.id}.json`);
  const code = `
 import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
 import {ProjectRoomAttachments} from './src-server/services/projects/task-room-attachments.ts';
 const original=fs.rmSync;
 fs.rmSync=function(p,...rest){if(p===process.env.R5_RECORD)process.exit(73);return original(p,...rest);};syncBuiltinESMExports();
 const f=new ProjectRoomAttachments(process.env.R5_ROOT);await f.locked(()=>f.release(['owner'],[process.env.R5_ID]));
 `;
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', code],
    {
      windowsHide: true,
      cwd: process.cwd(),
      env: { ...process.env, R5_ROOT: root, R5_RECORD: path, R5_ID: file!.id },
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  );
  let stderr = '';
  child.stderr.on('data', (c) => (stderr += c));
  expect(await new Promise((r) => child.on('close', r)), stderr).toBe(73);
  expect(fs.existsSync(path)).toBe(true);
  expect(f.read(binding, file!.id)).toBeUndefined();
  const fresh = new ProjectRoomAttachments(root);
  expect(await fresh.locked(() => fresh.release(binding, [file!.id]))).toBe(
    'reclaimed',
  );
  expect(fs.existsSync(path)).toBe(false);
  expect(
    (await fresh.locked(() => fresh.store(binding, [png('after.png')]))).length,
  ).toBe(1);
  console.log(
    'R5_CRASH_RELEASE exit=73, record retained, fresh-process lock takeover/release/upload recovered',
  );
}, 30000);

it('a crash before a record is renamed into place leaves no torn record, and a restart accepts (#4852 review)', async () => {
  const fs = await import('node:fs');
  const root = makeTempDir('r5-crash-publish-');
  const code = `
 import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
 import {ProjectRoomAttachments} from './src-server/services/projects/task-room-attachments.ts';
 const rename=fs.renameSync;fs.renameSync=function(from,to){if(String(to).includes('/bindings/'))process.exit(74);return rename(from,to);};syncBuiltinESMExports();
 const f=new ProjectRoomAttachments(process.env.R5_ROOT);await f.locked(()=>f.store(['owner'],[JSON.parse(process.env.R5_INPUT)]));
 `;
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', code],
    {
      windowsHide: true,
      cwd: process.cwd(),
      env: {
        ...process.env,
        R5_ROOT: root,
        R5_INPUT: JSON.stringify(png('crash.png')),
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  );
  let stderr = '';
  child.stderr.on('data', (c) => (stderr += c));
  expect(await new Promise((r) => child.on('close', r)), stderr).toBe(74);
  const bindings = fs
    .readdirSync(join(root, 'bindings'))
    .flatMap((k) => fs.readdirSync(join(root, 'bindings', k)));
  expect(bindings).toEqual([]);
  expect(fs.readdirSync(join(root, 'staging'))).toHaveLength(1);
  const fresh = new ProjectRoomAttachments(root);
  expect(
    (await fresh.locked(() => fresh.store(['owner'], [png('after.png')])))
      .length,
  ).toBe(1);
  console.log(
    'R5_CRASH_PUBLICATION exit=74, zero bindings, one staging record/orphan, fresh-process upload recovered',
  );
}, 30000);

it('offline repair: with Station stopped, fixing the damaged record lets a fresh process admit uploads and recover the quota (#4852 review)', async () => {
  const { createHash } = await import('node:crypto');
  const root = makeTempDir('room-offline-repair-');
  // Bytes of their own, so releasing the kept file frees them.
  const bytes = Buffer.concat([PNG, Buffer.from('offline-repair')]);
  const kept = {
    ...png('kept.png'),
    size: bytes.length,
    dataUrl: `data:image/png;base64,${bytes.toString('base64')}`,
  };
  const live = new ProjectRoomAttachments(root);
  const [file] = await live.locked(() => live.store(['owner'], [kept]));
  const [other] = await live.locked(() =>
    live.store(['other'], [png('other.png')]),
  );
  const directory = (binding: string[]) =>
    join(
      root,
      'bindings',
      createHash('sha256').update(JSON.stringify(binding)).digest('hex'),
    );
  const record = join(directory(['owner']), `${file!.id}.json`);
  const damaged = join(directory(['other']), `${other!.id}.json`);
  const blobRef = JSON.parse(readFileSync(record, 'utf8')).blobRef as string;
  const blob = join(root, 'blobs', blobRef.slice(7, 9), blobRef.slice(7));
  const intact = readFileSync(damaged, 'utf8');
  writeFileSync(damaged, '{');
  // While damaged: the release keeps the record (its quota charge) and its
  // bytes, and uploads are refused.
  expect(await live.locked(() => live.release(['owner'], [file!.id]))).toBe(
    'blocked',
  );
  await expect(
    live.locked(() => live.store(['owner'], [png('refused.png')])),
  ).rejects.toThrow('unavailable until the file store is repaired');
  expect(existsSync(record)).toBe(true);
  expect(existsSync(blob)).toBe(true);
  // Station stops (no process holds the store), the operator restores the
  // record on disk, and Station starts again as a fresh process.
  writeFileSync(damaged, intact);
  const config = join(makeTempDir('room-offline-repair-input-'), 'input.json');
  writeFileSync(
    config,
    JSON.stringify({ root, input: png('after.png'), id: file!.id }),
  );
  const script = `
    import {readFileSync} from 'node:fs';
    import {ProjectRoomAttachments,ProjectRoomFilesUnavailable} from './src-server/services/projects/task-room-attachments.ts';
    const {root,input,id}=JSON.parse(readFileSync(process.env.RACE_INPUT,'utf8'));
    const files=new ProjectRoomAttachments(root);
    let stored=0;
    try {stored=(await files.locked(()=>files.store(['owner'],[input]))).length;}
    catch(error) {if(!(error instanceof ProjectRoomFilesUnavailable))throw error;}
    const released=await files.locked(()=>files.release(['owner'],[id]));
    process.stdout.write(JSON.stringify({stored,released}));
  `;
  const result = await new Promise<{ stored: number; released: string }>(
    (resolve, reject) => {
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '-e', script],
        {
          cwd: process.cwd(),
          env: { ...process.env, RACE_INPUT: config },
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let out = '';
      let err = '';
      child.stdout.on('data', (b) => {
        out += b;
      });
      child.stderr.on('data', (b) => {
        err += b;
      });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code !== 0) reject(new Error(err));
        else resolve(JSON.parse(out));
      });
    },
  );
  expect(result).toEqual({ stored: 1, released: 'reclaimed' });
  // The quota charge and the bytes are gone; the restored record stays.
  expect(existsSync(record)).toBe(false);
  expect(existsSync(blob)).toBe(false);
  expect(readFileSync(damaged, 'utf8')).toBe(intact);
  expect(existsSync(join(root, 'reclamation-blocked.json'))).toBe(false);
}, 30000);
