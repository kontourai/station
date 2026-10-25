import { createHash } from 'node:crypto';
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { execGit } from '../../../utils/git-exec.js';
import {
  TASK_CAPTURE_MAX_BLOB_BYTES,
  TaskCaptureBlobStore,
  TaskCaptureBlobStoreError,
} from '../task-capture-blob-store.js';

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

describe('TaskCaptureBlobStore', () => {
  test.each([
    ['image/png', PNG],
    ['image/jpeg', JPEG],
  ])(
    '%s survives a new instance on the same home',
    async (mediaType, bytes) => {
      const homeDir = temporary('station-capture-home-');
      const stored = await new TaskCaptureBlobStore({ homeDir }).put(
        bytes,
        mediaType,
      );
      expect(stored).toEqual({
        digest: digestOf(bytes),
        byteLength: bytes.length,
      });
      expect(readFileSync(blobPath(homeDir, stored.digest))).toEqual(bytes);
      expect(
        await new TaskCaptureBlobStore({ homeDir }).read(stored.digest),
      ).toEqual(bytes);
      expect(readdirSync(join(homeDir, 'task-captures'))).toEqual(['sha256']);
    },
  );

  test('tampered bytes are refused on read and cannot be reused by put', async () => {
    const homeDir = temporary('station-capture-tamper-');
    const store = new TaskCaptureBlobStore({ homeDir });
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
    const store = new TaskCaptureBlobStore({ homeDir });
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
    const input = { homeDir, maxHomeBytes: PNG.length + JPEG.length - 1 };
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
      homeDir,
      maxHomeBytes: PNG.length + JPEG.length,
    });
    expect(await exactCap.put(JPEG, 'image/jpeg')).toMatchObject({
      byteLength: JPEG.length,
    });
  });

  test('concurrent instances cannot overrun the same home cap', async () => {
    const homeDir = temporary('station-capture-race-');
    const input = { homeDir, maxHomeBytes: PNG.length };
    const results = await Promise.allSettled([
      new TaskCaptureBlobStore(input).put(PNG, 'image/png'),
      new TaskCaptureBlobStore(input).put(JPEG, 'image/jpeg'),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({ reason: { code: 'home-cap-exceeded' } });
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
      new TaskCaptureBlobStore({ homeDir }).put(PNG, 'image/png'),
    ).rejects.toMatchObject({ code: 'storage-in-repository' });
    expect(readdirSync(homeDir)).toEqual([]);
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
      new TaskCaptureBlobStore({ homeDir }).put(PNG, 'image/png'),
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
      new TaskCaptureBlobStore({ homeDir }).put(PNG, 'image/png'),
    ).rejects.toMatchObject({ code: 'storage-in-repository' });
    expect(readdirSync(project)).toEqual(['.git']);
  });

  test('invalid digest paths and absent blobs are refused', async () => {
    const homeDir = temporary('station-capture-digest-');
    mkdirSync(join(homeDir, 'task-captures', 'sha256'), { recursive: true });
    const store = new TaskCaptureBlobStore({ homeDir });
    await expect(store.read('sha256:../../outside')).rejects.toMatchObject({
      code: 'invalid-digest',
    });
    await expect(store.read(digestOf(PNG))).rejects.toMatchObject({
      code: 'not-found',
    });
  });
});
