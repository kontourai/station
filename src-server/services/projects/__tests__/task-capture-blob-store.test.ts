import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { join } from 'node:path';
import * as lifecycle from '@kontourai/station-shared/lifecycle-events';
import { describe, expect, test, vi } from 'vitest';
import {
  executeOwnedProcess,
  terminateSuiteExecution,
  waitForSuiteSettlement,
} from '../../../../scripts/lib/owned-process.mjs';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { execGit } from '../../../utils/git-exec.js';
import {
  TASK_CAPTURE_MAX_BLOB_BYTES,
  TaskCaptureBlobStore,
  TaskCaptureBlobStoreError,
} from '../task-capture-blob-store.js';

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
}));

const temporary = trackTempDirs();
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6PCEAAAAASUVORK5CYII=',
  'base64',
);
// A JPEG signature fixture: the store checks media signatures, not image decoding.
const JPEG = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex');
const digestOf = (bytes: Buffer) =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const blobPath = (home: string, digest: string) =>
  join(home, 'task-captures', 'sha256', digest.slice('sha256:'.length));

const contenderSource = `
import { TaskCaptureBlobStore, TaskCaptureBlobStoreError } from ${JSON.stringify(new URL('../task-capture-blob-store.ts', import.meta.url).href)};
const bytes = Buffer.alloc(256 * 1024);
Buffer.from('89504e470d0a1a0a', 'hex').copy(bytes);
bytes.writeUInt32BE(Number(process.argv[2]), bytes.length - 4);
const store = new TaskCaptureBlobStore({ homeDir: process.argv[1], forbiddenProjectRoots: [], maxHomeBytes: 5 * bytes.length });
process.once('message', async () => {
  let result;
  try { await store.put(bytes, 'image/png'); result = 'stored'; }
  catch (error) {
    if (!(error instanceof TaskCaptureBlobStoreError)) throw error;
    result = error.code;
  }
  process.send({ kind: 'result', result }, () => process.disconnect());
});
process.send({ kind: 'ready' });
`;

function contender(home: string, id: number) {
  const execution = executeOwnedProcess(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      contenderSource,
      home,
      String(id),
    ],
    spawn,
    'Capture contender',
    { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true },
  );
  let result: string | undefined;
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Capture contender barrier timed out')),
      10_000,
    );
    execution.child.once('error', reject);
    execution.child.on('message', (message: unknown) => {
      const value = message as { kind?: string; result?: string };
      if (value.kind === 'ready') {
        clearTimeout(timer);
        resolve();
      }
      if (value.kind === 'result') result = value.result;
    });
    execution.child.once('close', () => {
      clearTimeout(timer);
      reject(new Error('Capture contender exited before the barrier'));
    });
  });
  return { execution, ready, result: () => result };
}

describe('TaskCaptureBlobStore', () => {
  test.each([
    ['image/png', PNG],
    ['image/jpeg', JPEG],
  ])(
    '%s survives a new instance on the same home',
    async (mediaType, bytes) => {
      const homeDir = temporary('station-capture-home-');
      const stored = await new TaskCaptureBlobStore({
        homeDir,
        forbiddenProjectRoots: [],
      }).put(bytes, mediaType);
      expect(stored).toEqual({
        digest: digestOf(bytes),
        byteLength: bytes.length,
      });
      expect(readFileSync(blobPath(homeDir, stored.digest))).toEqual(bytes);
      expect(
        await new TaskCaptureBlobStore({
          homeDir,
          forbiddenProjectRoots: [],
        }).read(stored.digest),
      ).toEqual(bytes);
      expect(readdirSync(join(homeDir, 'task-captures'))).toEqual(['sha256']);
    },
  );

  test('tampered bytes are refused on read and cannot be reused by put', async () => {
    const homeDir = temporary('station-capture-tamper-');
    const store = new TaskCaptureBlobStore({
      homeDir,
      forbiddenProjectRoots: [],
    });
    const { digest } = await store.put(PNG, 'image/png');
    const tampered = Buffer.from(PNG);
    tampered[tampered.length - 1] ^= 1;
    writeFileSync(blobPath(homeDir, digest), tampered);
    const read = store.read(digest);
    await expect(read).rejects.toBeInstanceOf(TaskCaptureBlobStoreError);
    await expect(read).rejects.toMatchObject({ code: 'digest-mismatch' });
    await expect(store.put(PNG, 'image/png')).rejects.toMatchObject({
      code: 'digest-mismatch',
    });
  });

  test('the exact blob limit is readable; max+1 is refused on put and read', async () => {
    const homeDir = temporary('station-capture-size-');
    const store = new TaskCaptureBlobStore({
      homeDir,
      forbiddenProjectRoots: [],
    });
    const bytes = Buffer.alloc(TASK_CAPTURE_MAX_BLOB_BYTES);
    PNG.copy(bytes);
    const { digest } = await store.put(bytes, 'image/png');
    expect((await store.read(digest)).equals(bytes)).toBe(true);
    const oversized = Buffer.concat([bytes, Buffer.from([1])]);
    await expect(store.put(oversized, 'image/png')).rejects.toMatchObject({
      code: 'blob-too-large',
    });
    writeFileSync(blobPath(homeDir, digest), oversized);
    await expect(store.read(digest)).rejects.toMatchObject({
      code: 'blob-too-large',
    });
  });

  test('the home cap persists across instances and duplicate bytes cost no extra space', async () => {
    const homeDir = temporary('station-capture-cap-');
    const input = {
      homeDir,
      forbiddenProjectRoots: [],
      maxHomeBytes: PNG.length + JPEG.length - 1,
    };
    const first = await new TaskCaptureBlobStore(input).put(PNG, 'image/png');
    const reopened = new TaskCaptureBlobStore(input);
    expect(await reopened.put(PNG, 'image/png')).toEqual(first);
    await expect(reopened.put(JPEG, 'image/jpeg')).rejects.toMatchObject({
      code: 'home-cap-exceeded',
    });
    expect(readdirSync(join(homeDir, 'task-captures', 'sha256'))).toEqual([
      first.digest.slice(7),
    ]);
    const exactCap = new TaskCaptureBlobStore({
      forbiddenProjectRoots: [],
      homeDir,
      maxHomeBytes: PNG.length + JPEG.length,
    });
    expect(await exactCap.put(JPEG, 'image/jpeg')).toMatchObject({
      byteLength: JPEG.length,
    });
  });

  test('independent processes cannot overrun the same home cap', {
    timeout: 30_000,
  }, async () => {
    const homeDir = temporary('station-capture-race-');
    const contenders = Array.from({ length: 12 }, (_, id) =>
      contender(homeDir, id),
    );
    try {
      await Promise.all(contenders.map((child) => child.ready));
      for (const child of contenders) child.execution.child.send('go');
      await Promise.all(
        contenders.map(async (child) => {
          expect(await waitForSuiteSettlement(child.execution, 15_000)).toBe(
            true,
          );
          expect(await child.execution.completion).toMatchObject({ status: 0 });
        }),
      );
      const stored = readdirSync(join(homeDir, 'task-captures', 'sha256'));
      expect(stored.length).toBeLessThanOrEqual(5);
      expect(stored).toHaveLength(5);
      expect(
        contenders.filter((child) => child.result() === 'stored'),
      ).toHaveLength(5);
      expect(
        contenders.filter((child) => child.result() === 'home-cap-exceeded'),
      ).toHaveLength(7);
    } finally {
      for (const child of contenders) {
        expect(
          await terminateSuiteExecution(child.execution, {
            processLabel: 'Capture contender',
            waitForSuiteSettlement,
            terminationGraceMs: 1000,
            terminationForceMs: 1000,
          }),
        ).toMatchObject({ settled: true, errors: [] });
      }
    }
  });

  test.each([
    [PNG, 'image/jpeg'],
    [JPEG, 'image/png'],
    [PNG, 'text/plain'],
    [Buffer.from('not an image'), 'image/png'],
    [Buffer.alloc(0), 'image/jpeg'],
  ])(
    'refuses bytes that do not match the allowed media type (%s, %s)',
    async (bytes, mediaType) => {
      const store = new TaskCaptureBlobStore({
        forbiddenProjectRoots: [],
        homeDir: temporary('station-capture-media-'),
      });
      await expect(store.put(bytes, mediaType)).rejects.toMatchObject({
        code: 'invalid-media-type',
      });
    },
  );

  test('a home inside a real Project repository is refused', async () => {
    const project = temporary('station-capture-project-');
    await execGit(['init'], {
      cwd: project,
      timeout: 10_000,
      windowsHide: true,
    });
    const homeDir = join(project, 'station-home');
    await expect(
      new TaskCaptureBlobStore({
        homeDir,
        forbiddenProjectRoots: [project],
      }).put(PNG, 'image/png'),
    ).rejects.toMatchObject({ code: 'storage-in-repository' });
    expect(existsSync(homeDir)).toBe(false);
  });

  test('a redirected capture directory is refused', async () => {
    const homeDir = temporary('station-capture-link-home-');
    const outside = temporary('station-capture-link-target-');
    symlinkSync(
      outside,
      join(homeDir, 'task-captures'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await expect(
      new TaskCaptureBlobStore({
        homeDir,
        forbiddenProjectRoots: [],
      }).put(PNG, 'image/png'),
    ).rejects.toMatchObject({ code: 'storage-unavailable' });
    expect(readdirSync(outside)).toEqual([]);
  });

  test('a Project initialized at the capture directory is refused', async () => {
    const homeDir = temporary('station-capture-nested-project-');
    const project = join(homeDir, 'task-captures');
    mkdirSync(project);
    await execGit(['init'], {
      cwd: project,
      timeout: 10_000,
      windowsHide: true,
    });
    await expect(
      new TaskCaptureBlobStore({
        homeDir,
        forbiddenProjectRoots: [project],
      }).put(PNG, 'image/png'),
    ).rejects.toMatchObject({ code: 'storage-in-repository' });
    expect(readdirSync(project)).toEqual(['.git']);
  });

  test('invalid digest paths and absent blobs are refused', async () => {
    const homeDir = temporary('station-capture-digest-');
    mkdirSync(join(homeDir, 'task-captures', 'sha256'), { recursive: true });
    const store = new TaskCaptureBlobStore({
      homeDir,
      forbiddenProjectRoots: [],
    });
    await expect(store.read('sha256:../../outside')).rejects.toMatchObject({
      code: 'invalid-digest',
    });
    await expect(store.read(digestOf(PNG))).rejects.toMatchObject({
      code: 'not-found',
    });
  });

  test('read on a missing home creates nothing', async () => {
    const parent = temporary('station-capture-read-only-');
    const homeDir = join(parent, 'missing-home');
    await expect(
      new TaskCaptureBlobStore({ homeDir, forbiddenProjectRoots: [] }).read(
        digestOf(PNG),
      ),
    ).rejects.toMatchObject({ code: 'not-found' });
    expect(readdirSync(parent)).toEqual([]);
  });

  test('later reads and puts do not initialize directories again', async () => {
    const store = new TaskCaptureBlobStore({
      homeDir: temporary('station-capture-initialized-'),
      forbiddenProjectRoots: [],
    });
    await store.put(PNG, 'image/png');
    const spy = vi
      .spyOn(fsPromises, 'mkdir')
      .mockRejectedValue(new Error('No repeated mkdir'));
    try {
      expect(await store.read(digestOf(PNG))).toEqual(PNG);
      await store.put(JPEG, 'image/jpeg');
      expect(await store.read(digestOf(JPEG))).toEqual(JPEG);
    } finally {
      spy.mockRestore();
    }
  });

  test('non-digest entries do not block puts', async () => {
    const homeDir = temporary('station-capture-stray-');
    const root = join(homeDir, 'task-captures', 'sha256');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, '.DS_Store'), 'metadata');
    expect(
      await new TaskCaptureBlobStore({
        homeDir,
        forbiddenProjectRoots: [],
      }).put(PNG, 'image/png'),
    ).toMatchObject({ digest: digestOf(PNG) });
  });

  test.each(['directory', 'symlink'])(
    'a hex-named %s is refused',
    async (kind) => {
      const homeDir = temporary('station-capture-invalid-entry-');
      const root = join(homeDir, 'task-captures', 'sha256');
      mkdirSync(root, { recursive: true });
      const path = join(root, 'a'.repeat(64));
      if (kind === 'directory') mkdirSync(path);
      else
        symlinkSync(
          temporary('station-capture-hex-target-'),
          path,
          process.platform === 'win32' ? 'junction' : 'dir',
        );
      await expect(
        new TaskCaptureBlobStore({ homeDir, forbiddenProjectRoots: [] }).put(
          PNG,
          'image/png',
        ),
      ).rejects.toMatchObject({ code: 'storage-unavailable' });
    },
  );

  test('put reclaims crash-leftover temporary files before duplicate reuse', async () => {
    const homeDir = temporary('station-capture-temporary-');
    const store = new TaskCaptureBlobStore({
      homeDir,
      forbiddenProjectRoots: [],
    });
    await store.put(PNG, 'image/png');
    const stale = join(homeDir, 'task-captures', '.blob-crashed.tmp');
    writeFileSync(stale, Buffer.alloc(1024));
    await store.put(PNG, 'image/png');
    expect(existsSync(stale)).toBe(false);
    expect(await store.read(digestOf(PNG))).toEqual(PNG);
  });

  test('a home used as a dotfiles repository is allowed unless registered as a Project', async () => {
    const homeDir = temporary('station-capture-dotfiles-');
    await execGit(['init'], {
      cwd: homeDir,
      timeout: 10_000,
      windowsHide: true,
    });
    const store = new TaskCaptureBlobStore({
      homeDir,
      forbiddenProjectRoots: [],
    });
    await store.put(PNG, 'image/png');
    expect(await store.read(digestOf(PNG))).toEqual(PNG);
  });

  test('a bare Project root is refused without depending on a .git entry', async () => {
    const project = temporary('station-capture-bare-');
    await execGit(['init', '--bare'], {
      cwd: project,
      timeout: 10_000,
      windowsHide: true,
    });
    const homeDir = join(project, 'station-home');
    await expect(
      new TaskCaptureBlobStore({
        homeDir,
        forbiddenProjectRoots: [project],
      }).put(PNG, 'image/png'),
    ).rejects.toMatchObject({ code: 'storage-in-repository' });
    expect(existsSync(homeDir)).toBe(false);
  });

  test('filesystem failures are typed with their cause', async () => {
    const parent = temporary('station-capture-unavailable-');
    const homeDir = join(parent, 'file');
    writeFileSync(homeDir, 'not a directory');
    await expect(
      new TaskCaptureBlobStore({ homeDir, forbiddenProjectRoots: [] }).put(
        PNG,
        'image/png',
      ),
    ).rejects.toMatchObject({
      code: 'storage-unavailable',
      cause: { code: 'ENOTDIR' },
    });
  });

  test.each(['lock', 'mkdir', 'readdir', 'link'] as const)(
    '%s failures retain the cause under storage-unavailable',
    async (operation) => {
      const homeDir = temporary('station-capture-io-failure-');
      const store = new TaskCaptureBlobStore({
        homeDir,
        forbiddenProjectRoots: [],
      });
      const cause = Object.assign(
        new Error(
          operation === 'lock'
            ? 'Timed out acquiring file lock'
            : 'I/O refused',
        ),
        { code: 'EPERM' },
      );
      const spy =
        operation === 'lock'
          ? vi
              .spyOn(lifecycle, 'acquireFileMutationLockAsync')
              .mockRejectedValueOnce(cause)
          : vi.spyOn(fsPromises, operation).mockRejectedValueOnce(cause);
      try {
        const result = store.put(PNG, 'image/png');
        await expect(result).rejects.toBeInstanceOf(TaskCaptureBlobStoreError);
        await expect(result).rejects.toMatchObject({
          code: 'storage-unavailable',
        });
        await expect(result).rejects.toHaveProperty('cause', cause);
      } finally {
        spy.mockRestore();
      }
    },
  );
});
