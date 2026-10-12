import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import {
  CAPTURE_MAX_BYTES,
  CaptureOverflowError,
  execFileSyncBounded,
  spawnSyncBounded,
} from '../lib/bounded-capture.mjs';

const NODE_DEFAULT_MAX_BUFFER = 1024 * 1024;

/** A real child that writes exactly `bytes` bytes of `x` to stdout. */
function emit(bytes: number): string[] {
  return ['-e', `process.stdout.write(Buffer.alloc(${bytes}, 120))`];
}

describe('bounded synchronous capture (#2787)', () => {
  const makeTempDir = trackTempDirs();

  test('the bound is 64 MiB', () => {
    // Pinned as a literal: every assertion below that derives from the
    // constant would follow it anywhere, including back down to 1 MiB.
    expect(CAPTURE_MAX_BYTES).toBe(67_108_864);
  });

  test('spawnSyncBounded captures output past the 1 MiB default whole', () => {
    const bytes = 2 * NODE_DEFAULT_MAX_BUFFER;
    const result = spawnSyncBounded(process.execPath, emit(bytes), {
      encoding: 'utf8',
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toHaveLength(bytes);
  });

  test('execFileSyncBounded captures output past the 1 MiB default whole', () => {
    const bytes = 2 * NODE_DEFAULT_MAX_BUFFER;
    const stdout = execFileSyncBounded(process.execPath, emit(bytes), {
      encoding: 'utf8',
    });
    expect(stdout).toHaveLength(bytes);
  });

  test('output one byte past the 64 MiB bound is refused, named, and not returned', () => {
    const result = spawnSyncBounded(
      process.execPath,
      emit(CAPTURE_MAX_BYTES + 1),
      { encoding: 'utf8' },
    );
    expect(result.error).toBeInstanceOf(CaptureOverflowError);
    expect(result.error).toMatchObject({
      code: 'ENOBUFS',
      maxBuffer: 67_108_864,
    });
    const nodeName = basename(process.execPath).replace(
      /[.*+?^${}()|[\]\\]/g,
      '\\$&',
    );
    expect(result.error?.message).toMatch(
      new RegExp(
        `^${nodeName} -e .* wrote more than 67108864 bytes to stdout or stderr`,
      ),
    );
    expect(result.error?.message).toContain('Raise maxBuffer');
    // The truncated capture must not be mistakable for a complete one.
    expect(result.stdout).toBe('');
    expect(result.status).not.toBe(0);
  });

  test('a caller bound is honoured exactly: the limit passes, one more byte rejects', () => {
    const options = { encoding: 'utf8', maxBuffer: 4096 } as const;
    expect(
      execFileSyncBounded(process.execPath, emit(4096), options),
    ).toHaveLength(4096);
    expect(() =>
      execFileSyncBounded(process.execPath, emit(4097), options),
    ).toThrow(CaptureOverflowError);
    expect(() =>
      execFileSyncBounded(process.execPath, emit(4097), options),
    ).toThrow(/wrote more than 4096 bytes/);

    const within = spawnSyncBounded(process.execPath, emit(4096), options);
    expect(within.error).toBeUndefined();
    expect(within.stdout).toHaveLength(4096);
    const over = spawnSyncBounded(process.execPath, emit(4097), options);
    expect(over.error).toBeInstanceOf(CaptureOverflowError);
    expect(over.stdout).toBe('');
  });

  test('a Buffer capture is emptied as a Buffer on overflow', () => {
    const over = spawnSyncBounded(process.execPath, emit(4097), {
      maxBuffer: 4096,
    });
    expect(over.error).toBeInstanceOf(CaptureOverflowError);
    expect(Buffer.isBuffer(over.stdout)).toBe(true);
    expect(over.stdout).toHaveLength(0);
  });

  test('failures other than overflow pass through untouched', () => {
    const missing = 'station-bounded-capture-no-such-command';
    const result = spawnSyncBounded(missing, [], { encoding: 'utf8' });
    expect(result.error).not.toBeInstanceOf(CaptureOverflowError);
    expect(result.error).toMatchObject({ code: 'ENOENT' });

    let thrown: unknown;
    try {
      execFileSyncBounded(missing, [], { encoding: 'utf8' });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).not.toBeInstanceOf(CaptureOverflowError);
    expect(thrown).toMatchObject({ code: 'ENOENT' });

    // A non-zero exit is the caller's to interpret, as with execFileSync.
    expect(() =>
      execFileSyncBounded(process.execPath, ['-e', 'process.exit(3)'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    ).toThrow(expect.objectContaining({ status: 3 }));
  });

  test('an explicit maxBuffer: undefined still gets the bound', () => {
    // Node reads an explicit undefined as unbounded, not as its default.
    let requested: unknown;
    spawnSyncBounded(
      'unused',
      [],
      { maxBuffer: undefined },
      {
        run: (_command: string, _args: string[], options: object) => {
          requested = (options as { maxBuffer?: number }).maxBuffer;
          return { status: 0, stdout: '', stderr: '' };
        },
      },
    );
    expect(requested).toBe(67_108_864);
  });

  test('the ratchet family reads a tracked-file listing larger than 1 MiB whole', () => {
    const root = makeTempDir('station-ratchet-listing-');
    const git = (args: string[], input?: string) =>
      execFileSyncBounded('git', args, {
        cwd: root,
        encoding: 'utf8',
        ...(input === undefined ? {} : { input }),
      });
    git(['init', '-q']);
    // Index entries only: `git ls-files` lists them with no files on disk.
    const blob = git(['hash-object', '-w', '--stdin'], '').trim();
    const count = 6000;
    const names = Array.from(
      { length: count },
      (_, index) => `pad/${'p'.repeat(200)}-${index}.txt`,
    );
    expect(Buffer.byteLength(names.join('\n'))).toBeGreaterThan(
      NODE_DEFAULT_MAX_BUFFER,
    );
    git(
      ['update-index', '--add', '--index-info'],
      names.map((name) => `100644 ${blob}\t${name}\n`).join(''),
    );

    // gitLsFiles lists from process.cwd(), so drive the production module
    // in a child whose cwd is the scratch repository.
    const ratchetUtils = pathToFileURL(
      resolve('scripts/lib/ratchet-utils.mjs'),
    ).href;
    const listed = execFileSyncBounded(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const { gitLsFiles } = await import(${JSON.stringify(ratchetUtils)}); process.stdout.write(String(gitLsFiles([]).length));`,
      ],
      { cwd: root, encoding: 'utf8' },
    );
    expect(Number(listed)).toBe(count);
  });
});
