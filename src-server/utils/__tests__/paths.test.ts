import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { expandTilde, resolveHomeDir } from '../paths.js';

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
    process.env.STATION_HOME = '/tmp/station-home';
    expect(resolveHomeDir()).toBe('/tmp/station-home');
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
