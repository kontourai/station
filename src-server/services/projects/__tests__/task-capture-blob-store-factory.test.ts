import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { createTaskCaptureBlobStoreFactory } from '../task-capture-blob-store-factory.js';

const temporary = trackTempDirs();
const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

test('a new Project root invalidates the cached store and refuses its existing capture storage', async () => {
  const project = temporary('station-capture-factory-project-');
  const homeDir = join(project, 'station-home');
  const forbiddenProjectRoots: string[] = [];
  const blobs = createTaskCaptureBlobStoreFactory({
    homeDir: () => homeDir,
    forbiddenProjectRoots: () => forbiddenProjectRoots,
    logger: { warn: vi.fn() },
  });
  const original = blobs();
  const stored = await original.put(PNG, 'image/png');
  expect(blobs()).toBe(original);
  expect(await blobs().read(stored.digest)).toEqual(PNG);

  forbiddenProjectRoots.push(project);
  const refused = blobs();
  await expect(refused.read(stored.digest)).rejects.toMatchObject({
    code: 'storage-in-repository',
  });
  await expect(refused.put(PNG, 'image/png')).rejects.toMatchObject({
    code: 'storage-in-repository',
  });
  expect(refused).not.toBe(original);
});

test('a changed home selects separate storage while unchanged inputs reuse it', async () => {
  let homeDir = temporary('station-capture-factory-first-');
  const blobs = createTaskCaptureBlobStoreFactory({
    homeDir: () => homeDir,
    forbiddenProjectRoots: () => [],
    logger: { warn: vi.fn() },
  });
  const first = blobs();
  const stored = await first.put(PNG, 'image/png');
  homeDir = temporary('station-capture-factory-second-');
  const second = blobs();
  expect(second).not.toBe(first);
  expect(blobs()).toBe(second);
  await expect(second.read(stored.digest)).rejects.toMatchObject({
    code: 'not-found',
  });
  expect(await second.put(PNG, 'image/png')).toEqual(stored);
  expect(await first.read(stored.digest)).toEqual(PNG);
});
