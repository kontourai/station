import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import {
  downloadPinnedArtifact,
  PinnedArtifactError,
} from '../pinned-artifact.js';

const makeTempDir = trackTempDirs();

function served(body: Buffer): typeof fetch {
  return (async () => new Response(body)) as unknown as typeof fetch;
}

function pinned(body: Buffer, dest: string) {
  return {
    fetch: served(body),
    url: 'https://artifacts.test/a.tar.gz',
    dest,
    bytes: body.length,
    sha256: createHash('sha256').update(body).digest('hex'),
    sourceName: 'Fixture',
  };
}

async function failure(
  promise: Promise<unknown>,
): Promise<PinnedArtifactError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof PinnedArtifactError) return error;
    throw error;
  }
  throw new Error('the download did not fail');
}

describe('downloadPinnedArtifact', () => {
  test('streams the pinned bytes to the destination', async () => {
    const body = Buffer.alloc(3 * 1024 * 1024, 7);
    const dest = join(makeTempDir('pinned-artifact-'), 'a');
    await downloadPinnedArtifact(pinned(body, dest));
    expect(readFileSync(dest).equals(body)).toBe(true);
  });

  // A write failure used to be an unhandled 'error' on the write stream,
  // which crashed the process (or left the backpressure wait pending).
  test('a destination that cannot be opened rejects with download-failed', async () => {
    const dest = join(makeTempDir('pinned-artifact-'), 'missing', 'a');
    const error = await failure(
      downloadPinnedArtifact(pinned(Buffer.alloc(64, 1), dest)),
    );
    expect(error.reason).toBe('download-failed');
    expect(error.message).toMatch(/ENOENT/);
  });

  test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'an unwritable destination directory rejects with download-failed, a backpressured body included',
    async () => {
      const dir = join(makeTempDir('pinned-artifact-'), 'locked');
      mkdirSync(dir);
      chmodSync(dir, 0o500);
      try {
        const error = await failure(
          downloadPinnedArtifact(
            pinned(Buffer.alloc(4 * 1024 * 1024, 2), join(dir, 'a')),
          ),
        );
        expect(error.reason).toBe('download-failed');
        expect(error.message).toMatch(/EACCES|EPERM/);
      } finally {
        chmodSync(dir, 0o700);
      }
    },
  );

  // Callers remove their staging directory as soon as the download rejects.
  // A refusal on the first chunk lands while the write stream is still
  // opening; settling before it closes let the file appear after that
  // removal (ENOTEMPTY, staging left behind) about half the time.
  test('a rejected download has closed its file before it settles', async () => {
    const base = makeTempDir('pinned-artifact-');
    for (let i = 0; i < 40; i++) {
      const staging = join(base, `s${i}`);
      mkdirSync(staging);
      const body = Buffer.alloc(31, 1);
      const error = await failure(
        downloadPinnedArtifact({
          ...pinned(body, join(staging, 'a')),
          bytes: 30,
        }),
      );
      expect(error.reason).toBe('size-mismatch');
      rmSync(staging, { recursive: true, force: true });
      await new Promise((resolve) => setTimeout(resolve, 2));
      expect(existsSync(staging)).toBe(false);
    }
  });

  test('an over-length body still rejects with size-mismatch', async () => {
    const body = Buffer.alloc(128, 3);
    const dest = join(makeTempDir('pinned-artifact-'), 'a');
    const error = await failure(
      downloadPinnedArtifact({ ...pinned(body, dest), bytes: 64 }),
    );
    expect(error.reason).toBe('size-mismatch');
  });
});
