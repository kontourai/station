import { utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import { assertAsciiServerBundles } from '../lib/server-bundle-ascii.mjs';

const makeTempDir = trackTempDirs();
function bundleDir(files: Record<string, string>) {
  const dir = makeTempDir('server-bundle-ascii-');
  for (const [name, text] of Object.entries(files))
    writeFileSync(join(dir, name), text);
  return dir;
}

describe('assertAsciiServerBundles', () => {
  it('accepts ASCII bundles, including \\u escapes', () => {
    const dir = bundleDir({
      'command-station.js': 'const quote = /[\\u2019]/u;',
      'worker.mjs': 'export {};',
    });
    expect(() => assertAsciiServerBundles(dir)).not.toThrow();
  });

  it('names each bundle and offset holding a non-ASCII byte', () => {
    const dir = bundleDir({
      'command-station.js': 'const ok = 1;\nconst quote = /[’]/u;',
      'station-control.js': '// fine — not fine',
    });
    expect(() => assertAsciiServerBundles(dir)).toThrow(
      /command-station\.js @30:.*\[’\].*\n {2}station-control\.js @8: /,
    );
  });

  it('ignores files that are not loaded as scripts', () => {
    const dir = bundleDir({ 'command-station.js.map': '{"names":["’"]}' });
    expect(() => assertAsciiServerBundles(dir)).not.toThrow();
  });

  it('skips bundles older than this build but still checks new ones', () => {
    const dir = bundleDir({
      'removed-worker.js': '// stale — from an earlier build',
      'command-station.js': 'const quote = /[’]/u;',
    });
    const earlier = new Date(Date.now() - 60_000);
    utimesSync(join(dir, 'removed-worker.js'), earlier, earlier);
    const sinceMs = Date.now() - 30_000;
    expect(() => assertAsciiServerBundles(dir, { sinceMs })).toThrow(
      /command-station\.js @/,
    );
    expect(() => assertAsciiServerBundles(dir, { sinceMs })).not.toThrow(
      /removed-worker/,
    );
    writeFileSync(
      join(dir, 'command-station.js'),
      'const quote = /[\\u2019]/u;',
    );
    expect(() => assertAsciiServerBundles(dir, { sinceMs })).not.toThrow();
  });
});
