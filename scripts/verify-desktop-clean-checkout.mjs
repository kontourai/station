#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const DESKTOP_DIR = 'src-desktop';
const CONFIG_PATH = `${DESKTOP_DIR}/tauri.conf.json`;
const CHANNEL_PORTS_CONTRACT = 'config/channel-ports.json';
const CHANNEL_PORTS_GENERATOR = 'scripts/channel-ports.mjs';
const REQUIRED_RUST_INPUTS = [
  `${DESKTOP_DIR}/Cargo.toml`,
  `${DESKTOP_DIR}/Cargo.lock`,
];
export const TAURI_BUILD_COMMAND = [
  'run',
  'tauri',
  '--',
  'build',
  '--debug',
  '--no-bundle',
];

function run(repoRoot, command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: repoRoot,
    windowsHide: true,
    ...options,
  });
}

function commandFailure(command, args, result) {
  const signal = result.signal ? ` (signal ${result.signal})` : '';
  const stderr = result.stderr?.toString().trim();
  const detail = stderr ? `\n${stderr}` : '';
  return new Error(
    `${command} ${args.join(' ')} failed with exit code ${result.status ?? 'unknown'}${signal}${detail}`,
  );
}

function requireSuccessful(repoRoot, command, args, options = {}) {
  const result = run(repoRoot, command, args, options);
  if (result.error) throw result.error;
  if (result.status !== 0) throw commandFailure(command, args, result);
  return result;
}

function configuredIconPaths(repoRoot) {
  let config;
  try {
    config = JSON.parse(readFileSync(resolve(repoRoot, CONFIG_PATH), 'utf8'));
  } catch (error) {
    throw new Error(
      `Desktop build prerequisite ${CONFIG_PATH} is missing or invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const icons = config?.bundle?.icon;
  if (!Array.isArray(icons) || icons.length === 0) {
    throw new Error(
      `${CONFIG_PATH} must declare at least one bundle.icon input`,
    );
  }
  if (icons.some((icon) => typeof icon !== 'string' || icon.length === 0)) {
    throw new Error(
      `${CONFIG_PATH} bundle.icon entries must be non-empty strings`,
    );
  }
  return icons.map((icon) => `${DESKTOP_DIR}/${icon}`);
}

function assertRegularFile(repoRoot, path) {
  try {
    if (!lstatSync(resolve(repoRoot, path)).isFile()) {
      throw new Error('not a regular file');
    }
  } catch (error) {
    throw new Error(
      `Desktop build prerequisite is missing: ${path}${error instanceof Error && error.message !== 'not a regular file' ? ` (${error.message})` : ''}`,
    );
  }
}

function assertTracked(repoRoot, path) {
  const result = run(
    repoRoot,
    'git',
    ['ls-files', '--error-unmatch', '--', path],
    {
      encoding: 'utf8',
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `Desktop build prerequisite must be committed to Git: ${path}`,
    );
  }
}

export function verifyDesktopPrerequisites(repoRoot) {
  const requiredPaths = [
    CONFIG_PATH,
    CHANNEL_PORTS_CONTRACT,
    CHANNEL_PORTS_GENERATOR,
    ...REQUIRED_RUST_INPUTS,
    ...configuredIconPaths(repoRoot),
  ];
  for (const path of requiredPaths) {
    assertRegularFile(repoRoot, path);
    assertTracked(repoRoot, path);
  }
  return requiredPaths;
}

export function captureGitVisibleState(repoRoot) {
  const result = requireSuccessful(
    repoRoot,
    'git',
    ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
    { encoding: null },
  );
  const output = Buffer.isBuffer(result.stdout)
    ? result.stdout
    : Buffer.from(result.stdout ?? '');
  return output
    .toString('utf8')
    .split('\0')
    .filter((entry) => entry.length > 0);
}

function quotedEntries(entries) {
  return entries.map((entry) => JSON.stringify(entry)).join(', ');
}

export function assertNoGitVisibleResidue(before, after) {
  const beforeCounts = new Map();
  const afterCounts = new Map();
  for (const entry of before) {
    beforeCounts.set(entry, (beforeCounts.get(entry) ?? 0) + 1);
  }
  for (const entry of after) {
    afterCounts.set(entry, (afterCounts.get(entry) ?? 0) + 1);
  }
  const added = [];
  const removed = [];
  for (const [entry, count] of afterCounts) {
    const difference = count - (beforeCounts.get(entry) ?? 0);
    for (let index = 0; index < difference; index += 1) added.push(entry);
  }
  for (const [entry, count] of beforeCounts) {
    const difference = count - (afterCounts.get(entry) ?? 0);
    for (let index = 0; index < difference; index += 1) removed.push(entry);
  }
  if (added.length > 0 || removed.length > 0) {
    const details = [
      added.length > 0 ? `new/changed: ${quotedEntries(added)}` : null,
      removed.length > 0 ? `removed/changed: ${quotedEntries(removed)}` : null,
    ]
      .filter(Boolean)
      .join('; ');
    throw new Error(
      `Desktop verification introduced Git-visible residue (${details}). Generated build output must stay ignored and source inputs must remain unchanged.`,
    );
  }
}

export function verifyDesktopCleanCheckout(
  repoRoot,
  { buildRunner = run } = {},
) {
  const requiredPaths = verifyDesktopPrerequisites(repoRoot);
  const before = captureGitVisibleState(repoRoot);
  const result = buildRunner(repoRoot, 'npm', TAURI_BUILD_COMMAND, {
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result?.error) throw result.error;
  if (result?.status !== 0) {
    throw commandFailure('npm', TAURI_BUILD_COMMAND, result ?? {});
  }
  const after = captureGitVisibleState(repoRoot);
  assertNoGitVisibleResidue(before, after);
  return { requiredPaths, before, after };
}

function main() {
  const { requiredPaths } = verifyDesktopCleanCheckout(resolve(process.cwd()));
  process.stdout.write(
    `Desktop clean-checkout verification passed (${requiredPaths.length} committed prerequisites).\n`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
