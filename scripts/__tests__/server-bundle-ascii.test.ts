import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertAsciiServerBundles } from '../lib/server-bundle-ascii.mjs';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
function bundleDir(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'server-bundle-ascii-'));
  dirs.push(dir);
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
});
