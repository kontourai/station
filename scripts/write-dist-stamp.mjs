#!/usr/bin/env node
/**
 * Record the source digest a package's build output was produced from
 * (station#1813).
 *
 * Runs as the last step of a dist-backed package's own `build` script, with
 * that package as cwd. The stamp lives inside the (git-ignored) build
 * directory, so it is exactly as ephemeral as the output it describes.
 */
import { writeFileSync } from 'node:fs';
import { invokedDirectly } from './lib/module-entry.mjs';
import {
  computeSourceDigest,
  DIGEST_VERSION,
  stampPath,
} from './lib/package-dist-freshness.mjs';

export function writeDistStamp({
  pkgDir = process.cwd(),
  distDir = 'dist',
  now = () => new Date().toISOString(),
} = {}) {
  const target = stampPath(pkgDir, distDir);
  const stamp = {
    digestVersion: DIGEST_VERSION,
    sourceDigest: computeSourceDigest(pkgDir),
    generatedAt: now(),
  };
  writeFileSync(target, `${JSON.stringify(stamp, null, 2)}\n`);
  return { path: target, stamp };
}

if (invokedDirectly(import.meta.url)) {
  const distDir = process.argv[2] ?? 'dist';
  const { path } = writeDistStamp({ distDir });
  console.log(`dist stamp written: ${path}`);
}
