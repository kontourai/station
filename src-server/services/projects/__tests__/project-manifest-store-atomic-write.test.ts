/**
 * station#1499 slice 2, review HIGH-4: the file holding a project's portable
 * `id` — the one value in this system that must never change once anything has
 * joined on it — was written with `writeFileSync(path, data, { flag: 'wx' })`.
 * That is open(O_CREAT|O_EXCL) → write → close: the target exists at ZERO
 * BYTES in between, with no fsync and no `.previous` copy. A crash there leaves
 * a manifest that `readRecord` refuses and `ensureProjectManifest` cannot
 * repair (it reads first), i.e. a permanently bricked project.
 *
 * The defect is invisible to any assertion about the finished file: the torn
 * and the atomic implementation end with identical bytes on disk. What IS
 * observable is the mechanism, so — following `json-store-fsync-mode.test.ts`,
 * which pins the same class of unobservable-by-outcome property — this pins the
 * syscall sequence: the target is never written into, it is created by `link`
 * from a temp file that was written and fsync'd first.
 */
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

/** One ordered log, so "written before linked" is a real assertion. */
const events = vi.hoisted(() => [] as string[]);

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const fdPaths = new Map<number, string>();
  return {
    ...actual,
    writeFileSync: (path: never, data: never, ...rest: never[]) => {
      events.push(`write ${String(path)}`);
      return actual.writeFileSync(path, data, ...rest);
    },
    openSync: (path: never, flags: never, ...rest: never[]) => {
      const fd = actual.openSync(path, flags, ...rest);
      fdPaths.set(fd, String(path));
      events.push(`open ${String(path)} (${String(flags)})`);
      return fd;
    },
    fsyncSync: (fd: never) => {
      events.push(`fsync ${fdPaths.get(fd) ?? `fd:${String(fd)}`}`);
      return actual.fsyncSync(fd);
    },
    linkSync: (from: never, to: never) => {
      events.push(`link ${String(from)} -> ${String(to)}`);
      return actual.linkSync(from, to);
    },
  };
});

let dir: string;

beforeEach(() => {
  events.length = 0;
  dir = mkdtempSync(join(tmpdir(), 'station-ppi-atomic-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function tempPathFromLink(): string {
  const link = events.find((event) => event.startsWith('link '));
  expect(link).toBeDefined();
  return (link as string).slice('link '.length).split(' -> ')[0];
}

describe('writeManifestRecordExclusively (station#1499 HIGH-4)', () => {
  test('creates the target by LINK from a written, fsynced temp file — never by writing into the target itself', async () => {
    const { writeManifestRecordExclusively } = await import(
      '../project-manifest-store.js'
    );
    const target = join(dir, 'projects', 'acme', 'manifest.json');

    writeManifestRecordExclusively(target, '{"id":"prj_1"}\n');

    expect(readFileSync(target, 'utf-8')).toBe('{"id":"prj_1"}\n');

    const tempPath = tempPathFromLink();
    expect(dirname(tempPath)).toBe(dirname(target));
    // The exact sequence: the temp file is complete and flushed BEFORE the
    // target exists at all.
    expect(events.filter((event) => event.includes(tempPath))).toEqual([
      `write ${tempPath}`,
      `open ${tempPath} (r+)`,
      `fsync ${tempPath}`,
      `link ${tempPath} -> ${target}`,
    ]);
    // Nothing ever wrote into, or opened for writing, the manifest itself.
    expect(events).not.toContain(`write ${target}`);
    expect(
      events.filter(
        (event) => event.startsWith(`open ${target}`) && !event.endsWith('(r)'),
      ),
    ).toEqual([]);
    // …and the temp file does not survive.
    expect(existsSync(tempPath)).toBe(false);
    expect(readdirSync(dirname(target))).toEqual(['manifest.json']);
  });

  test('still fails EEXIST when the target exists, so the adopt-the-winner path is unchanged', async () => {
    const { writeManifestRecordExclusively } = await import(
      '../project-manifest-store.js'
    );
    const target = join(dir, 'manifest.json');
    writeManifestRecordExclusively(target, 'first\n');

    let code: unknown;
    try {
      writeManifestRecordExclusively(target, 'second\n');
    } catch (error) {
      code = (error as NodeJS.ErrnoException).code;
    }
    // `rename` would have been atomic too — and would have silently replaced
    // the winner's portable id, which is the one thing that must never happen.
    expect(code).toBe('EEXIST');
    expect(readFileSync(target, 'utf-8')).toBe('first\n');
    // …and left no temp file behind either.
    expect(readdirSync(dir)).toEqual(['manifest.json']);
  });
});
