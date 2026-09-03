#!/usr/bin/env node
/**
 * Proves a node-pty Linux prebuild actually works as a prebuild (#1245).
 *
 * Given a candidate `pty.node`, this stages a throwaway copy of the installed
 * `node_modules/node-pty` with NO `build/` directory and only
 * `prebuilds/<platform>-<arch>/pty.node`, then proves the exact contract the
 * shipped layout depends on:
 *
 *   1. upstream's own `scripts/prebuild.js` exits 0 (so the install hook
 *      `node scripts/prebuild.js || node-gyp rebuild` never invokes node-gyp
 *      and never needs a C++ toolchain), and
 *   2. the module loads from `prebuilds/` and passes Station's real-PTY
 *      handshake proof (`verifyNodePtyHandshake`) — output, input, and a
 *      natural child exit through the native bridge, not merely a load.
 *
 * It then prints the artifact's sha256 and its glibc/libstdc++ symbol-version
 * floor (via objdump when available), which the prebuild manifest records.
 *
 * The PTY handshake execs the native module, so this must run on the
 * architecture it verifies; it refuses a cross-architecture artifact instead
 * of skipping the proof silently.
 *
 * Usage:
 *   node scripts/verify-node-pty-prebuild.mjs --artifact <path/to/pty.node>
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyNodePtyHandshake } from './lib/dependency-lifecycle-policy.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function fail(message) {
  console.error(`verify-node-pty-prebuild: ${message}`);
  process.exit(1);
}

function parseArguments(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--artifact') parsed.artifact = argv[index + 1];
  }
  return parsed;
}

function symbolVersionFloor(artifact, prefix) {
  const result = spawnSync('objdump', ['-T', artifact], {
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
  });
  if (result.status !== 0) return null;
  const versions = [
    ...new Set(result.stdout.match(new RegExp(`${prefix}_[0-9.]+`, 'g')) ?? []),
  ];
  versions.sort((left, right) =>
    left.localeCompare(right, undefined, { numeric: true }),
  );
  return versions.at(-1) ?? null;
}

const { artifact } = parseArguments(process.argv.slice(2));
if (!artifact || !existsSync(artifact)) fail('missing --artifact <pty.node>');
if (process.platform !== 'linux')
  fail('linux prebuild verification must run on linux');

const packageRoot = resolve(root, 'node_modules', 'node-pty');
if (!existsSync(join(packageRoot, 'package.json')))
  fail('node_modules/node-pty is not installed; run npm run dependencies:ci');
const version = JSON.parse(
  readFileSync(join(packageRoot, 'package.json'), 'utf8'),
).version;
const target = `${process.platform}-${process.arch}`;

const staging = mkdtempSync(join(tmpdir(), 'station-node-pty-prebuild-'));
try {
  const stagedPackage = join(staging, 'node-pty');
  // The proof is about the prebuild ALONE: exclude compiled output and any
  // host prebuild for this target at copy time, so nothing but the candidate
  // artifact can satisfy the load.
  const excluded = new Set([
    join(packageRoot, 'build'),
    join(packageRoot, 'prebuilds', target),
    join(packageRoot, 'node_modules'),
  ]);
  cpSync(packageRoot, stagedPackage, {
    recursive: true,
    filter: (source) => !excluded.has(source),
  });
  mkdirSync(join(stagedPackage, 'prebuilds', target), { recursive: true });
  cpSync(artifact, join(stagedPackage, 'prebuilds', target, 'pty.node'));

  const prebuildCheck = spawnSync(
    process.execPath,
    [join(stagedPackage, 'scripts', 'prebuild.js')],
    {
      cwd: stagedPackage,
      encoding: 'utf8',
      timeout: 30_000,
      windowsHide: true,
    },
  );
  if (prebuildCheck.status !== 0)
    fail(
      `upstream scripts/prebuild.js exited ${prebuildCheck.status}; the install hook would fall back to node-gyp`,
    );

  verifyNodePtyHandshake(stagedPackage);

  const sha256 = createHash('sha256')
    .update(readFileSync(artifact))
    .digest('hex');
  const report = {
    package: 'node-pty',
    version,
    target,
    sha256,
    glibcFloor: symbolVersionFloor(artifact, 'GLIBC'),
    glibcxxFloor: symbolVersionFloor(artifact, 'GLIBCXX'),
  };
  // JSON alone on stdout so CI can tee it straight into proof.json; the
  // human-readable receipt goes to stderr.
  console.log(JSON.stringify(report, null, 2));
  console.error(
    `OK: ${target} prebuild loads from prebuilds/ and passes the real PTY handshake without node-gyp.`,
  );
} finally {
  rmSync(staging, { recursive: true, force: true });
}
