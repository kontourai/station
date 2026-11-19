import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { ProjectLibraryUploads } from '../project-library-uploads.js';

const makeTempDir = trackTempDirs();
const failure = new Error('injected upload I/O failure');
let failAt: 'writeFile' | 'sync' | 'close' | undefined;

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      if (args[1] !== 'wx') return handle;
      if (failAt === 'writeFile') {
        vi.spyOn(handle, 'writeFile').mockRejectedValueOnce(failure);
      } else if (failAt === 'sync') {
        vi.spyOn(handle, 'sync').mockRejectedValueOnce(failure);
      } else if (failAt === 'close') {
        const close = handle.close.bind(handle);
        vi.spyOn(handle, 'close').mockImplementationOnce(async () => {
          await close();
          throw failure;
        });
      }
      return handle;
    },
  };
});

afterEach(() => {
  failAt = undefined;
});

test.each(['writeFile', 'sync', 'close'] as const)(
  'cleans up a failed replacement after %s while preserving existing files',
  async (operation) => {
    const library = new ProjectLibraryUploads({
      homeDir: makeTempDir('station-library-upload-'),
    });
    const projectId = 'project-1';
    const folder = library.folderFor(projectId);
    const target = 'brief.md';
    const otherUpload = '.upload-other.tmp';
    await library.write(projectId, target, Buffer.from('original'));
    await writeFile(join(folder, otherUpload), 'another upload');

    failAt = operation;
    await expect(
      library.write(projectId, target, Buffer.from('replacement')),
    ).rejects.toBe(failure);

    expect(await readFile(join(folder, target), 'utf8')).toBe('original');
    expect(await readFile(join(folder, otherUpload), 'utf8')).toBe(
      'another upload',
    );
    expect((await readdir(folder)).sort()).toEqual([otherUpload, target]);
  },
);
