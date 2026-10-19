import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs';
import { spawnSyncBounded } from '../lib/bounded-capture.mjs';

const makeTempDir = trackTempDirs();
const require = createRequire(resolve('package.json'));
const matter = require('gray-matter');
const yamlManifest = createRequire(
  require.resolve('gray-matter/package.json'),
).resolve('js-yaml/package.json');
const yamlRoot = dirname(yamlManifest);
const yaml = createRequire(yamlManifest)('./');
const cli = join(yamlRoot, 'bin/js-yaml.js');

function run(args: string[], input = '') {
  const result = spawnSyncBounded(process.execPath, [cli, ...args], {
    input,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10_000,
  });
  expect(result.error).toBeUndefined();
  return result;
}

describe('installed legacy YAML consumer compatibility', () => {
  it.each(['-v', '--version'])(
    'retains %s stdout and exit without deprecated aliases',
    (flag) => {
      expect(JSON.parse(readFileSync(yamlManifest, 'utf8')).version).toBe(
        '3.15.2',
      );
      const result = run([flag]);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('3.15.2\n');
      expect(result.stderr).toBe('');
    },
  );

  it.each(['-h', '--help'])(
    'retains %s options while keeping the compatibility flag hidden',
    (flag) => {
      const result = run([flag]);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toContain('usage: js-yaml');
      for (const option of [
        '--help',
        '--version',
        '--compact',
        '--trace',
        'file',
      ])
        expect(result.stdout).toContain(option);
      expect(result.stdout).not.toContain('--to-json');
    },
  );

  it.each([[], ['-'], ['-j'], ['--to-json']].map((args) => ({ args })))(
    'converts YAML stdin with args %j',
    ({ args }) => {
      const result = run(args, 'name: Station\ncount: 2\n');
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout)).toEqual({ name: 'Station', count: 2 });
    },
  );

  it.each([[], ['-j'], ['--to-json']].map((args) => ({ args })))(
    'keeps content-based JSON to YAML conversion with args %j',
    ({ args }) => {
      const result = run(args, '{"name":"Station","count":2}');
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toBe('name: Station\ncount: 2\n\n');
    },
  );

  it('reads an explicit UTF-8 file and reports a missing file with exit 2', () => {
    const directory = makeTempDir('station-yaml-cli-');
    const file = join(directory, 'input.yaml');
    writeFileSync(file, 'name: Station\n');
    const result = run([file]);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({ name: 'Station' });
    const missing = run([join(directory, 'missing.yaml')]);
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain('File not found:');
    expect(missing.stdout).toBe('');
  });

  it.each(['-c', '--compact', '-t', '--trace'])(
    'retains invalid YAML error mode %s',
    (flag) => {
      const result = run([flag], 'value: [\n');
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('YAMLException');
      expect(result.stderr).not.toMatch(/DeprecationWarning|renamed to/);
      if (flag === '-t' || flag === '--trace')
        expect(result.stderr).toMatch(/\bat /);
      else expect(result.stderr).not.toMatch(/\bat /);
    },
  );

  it.each(
    [['--unknown'], ['first.yaml', 'second.yaml']].map((args) => ({ args })),
  )('rejects unsupported arguments %j with exit 2', ({ args }) => {
    const result = run(args);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('unrecognized arguments:');
    expect(result.stderr).not.toMatch(/DeprecationWarning|renamed to/);
  });

  it('preserves the real gray-matter YAML parse and stringify boundary', () => {
    const input =
      '---\ntitle: Station\nitems:\n  - first\n  - second\n---\nbody\n';
    const parsed = matter(input);
    expect(parsed.data).toEqual({
      title: 'Station',
      items: ['first', 'second'],
    });
    expect(parsed.content).toBe('body\n');
    expect(matter(matter.stringify('body\n', parsed.data)).data).toEqual(
      parsed.data,
    );
    expect(yaml.safeLoad(yaml.safeDump(parsed.data))).toEqual(parsed.data);
    expect(() => matter('---\nvalue: [\n---\nbody')).toThrow();
  });
});
