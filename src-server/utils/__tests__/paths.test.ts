import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from 'vitest';
import { expandTilde, resolveHomeDir } from '../paths.js';

// `/tmp/station-home` was a fixed name in the shared system temp directory, so
// any other process on the host could leave a regular file there and break this
// test for a reason unrelated to `resolveHomeDir` (#1790). Own the root.
const TEST_TEMP_ROOT = mkdtempSync(join(tmpdir(), 'station-paths-test-'));
const STATION_HOME_DIR = join(TEST_TEMP_ROOT, 'station-home');

afterAll(() => {
  rmSync(TEST_TEMP_ROOT, { force: true, recursive: true });
});

describe('resolveHomeDir', () => {
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env.STATION_HOME;
    delete process.env.STATION_HOME;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.STATION_HOME;
    else process.env.STATION_HOME = saved;
  });

  test('uses STATION_HOME when set', () => {
    process.env.STATION_HOME = STATION_HOME_DIR;
    expect(resolveHomeDir()).toBe(STATION_HOME_DIR);
  });

  test('defaults to the stable runtime below STATION_ROOT when unset', () => {
    expect(resolveHomeDir()).toBe(
      join(process.env.STATION_ROOT!, 'instances', 'stable'),
    );
  });
});

describe('expandTilde', () => {
  test('expands a bare ~ to the home directory', () => {
    expect(expandTilde('~')).toBe(homedir());
  });

  test('expands ~/sub to <home>/sub', () => {
    expect(expandTilde('~/dev/github/kontourai')).toBe(
      join(homedir(), 'dev/github/kontourai'),
    );
  });

  test('leaves absolute paths unchanged', () => {
    expect(expandTilde('/Users/brian/dev')).toBe('/Users/brian/dev');
  });

  test('leaves relative paths (no leading ~) unchanged', () => {
    expect(expandTilde('dev/github')).toBe('dev/github');
  });

  test('does NOT expand a ~ that is not the leading segment', () => {
    // The corrupt shape the old bug produced (cwd + a literal ~ segment).
    expect(expandTilde('/foo/~/bar')).toBe('/foo/~/bar');
  });
});
