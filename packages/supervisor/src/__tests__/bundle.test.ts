/**
 * The shipped supervisor is one self-contained file: it must import only
 * Node built-ins, so it runs with no node_modules beside it.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as esbuild from 'esbuild';
import { describe, expect, it } from 'vitest';
import { trackTempDirs } from '../../../../src-server/__test-utils__/temp-dirs.ts';
import { supervisorBuildOptions } from '../../build-options.mjs';

const makeTempDir = trackTempDirs();

describe('supervisor bundle', () => {
  it('imports only node: modules and runs --help from a directory without node_modules', async () => {
    const outDir = makeTempDir('sup-bundle-only-');
    const outfile = join(outDir, 'station-supervisor.js');
    await esbuild.build(supervisorBuildOptions(outfile));
    const source = readFileSync(outfile, 'utf8');
    const specifiers = [
      ...source.matchAll(/\bfrom\s*["']([^"']+)["']/g),
      ...source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g),
      ...source.matchAll(/\bimport\s*["']([^"']+)["']/g),
      ...source.matchAll(/\brequire\s*\(\s*["']([^"']+)["']\s*\)/g),
    ].map((match) => match[1]);
    expect(specifiers.length).toBeGreaterThan(0);
    expect(
      specifiers.filter((specifier) => !specifier?.startsWith('node:')),
    ).toEqual([]);
    // Test-only knobs are compiled out of the shipped bundle.
    expect(source).not.toContain('STATION_SUPERVISOR_TEST_LOCK_DELAY_MS');
    expect(source).not.toContain(
      'STATION_SUPERVISOR_TEST_POST_ACQUIRE_DELAY_MS',
    );

    const result = spawnSync(process.execPath, [outfile, '--help'], {
      cwd: outDir,
      encoding: 'utf8',
      timeout: 30_000,
      windowsHide: true,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('usage: station-supervisor');
  }, 60_000);
});
