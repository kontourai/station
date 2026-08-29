#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { npmBuildInvocation } from './lib/desktop-build-command.mjs';

const root = resolve(import.meta.dirname, '..');

export function tauriShellBinaryCandidates(
  projectRoot,
  platform = process.platform,
) {
  const target = join(projectRoot, 'src-desktop', 'target', 'debug');
  if (platform === 'darwin') {
    return [
      join(
        target,
        'bundle',
        'macos',
        'Station Tauri Shell E2E.app',
        'Contents',
        'MacOS',
        'station',
      ),
      join(
        target,
        'bundle',
        'macos',
        'Station Tauri Shell E2E.app',
        'Contents',
        'MacOS',
        'Station Tauri Shell E2E',
      ),
      join(target, 'station'),
    ];
  }
  if (platform === 'win32') return [join(target, 'station.exe')];
  return [join(target, 'station')];
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    env: options.env ?? process.env,
    stdio: 'inherit',
    shell: false,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function npmRun(args) {
  const invocation = npmBuildInvocation(args, {
    npmExecPath: process.env.npm_execpath,
  });
  run(invocation.command, invocation.args);
}

function buildHarness() {
  const bundleArgs =
    process.platform === 'darwin' ? ['--bundles', 'app'] : ['--no-bundle'];
  npmRun([
    'run',
    'build:desktop',
    '--',
    '--debug',
    '--no-sign',
    '--features',
    'webdriver',
    '--config',
    'tauri.webdriver.conf.json',
    ...bundleArgs,
  ]);
}

function main() {
  if (process.argv.slice(2).includes('--build')) buildHarness();
  const explicit = process.env.STATION_TAURI_E2E_BINARY;
  const binary =
    explicit ??
    tauriShellBinaryCandidates(root).find((candidate) => existsSync(candidate));
  if (!binary || !existsSync(binary)) {
    throw new Error(
      `Tauri shell E2E binary not found. Run npm run test:tauri-shell:build or set STATION_TAURI_E2E_BINARY. Checked: ${tauriShellBinaryCandidates(root).join(', ')}`,
    );
  }
  const wdio = resolve(root, 'node_modules/@wdio/cli/bin/wdio.js');
  if (!existsSync(wdio))
    throw new Error(`WebdriverIO CLI not installed: ${wdio}`);
  const revision = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (revision.status !== 0)
    throw new Error('Could not resolve the Tauri E2E source revision.');
  run(process.execPath, [wdio, 'run', 'tests/tauri-shell/wdio.conf.ts'], {
    env: {
      ...process.env,
      STATION_TAURI_E2E_BINARY: binary,
      STATION_TAURI_E2E_SOURCE_SHA: revision.stdout.trim(),
    },
  });
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  try {
    main();
  } catch (error) {
    console.error(
      `tauri-shell-e2e: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
