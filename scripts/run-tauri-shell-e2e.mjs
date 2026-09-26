#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { npmBuildInvocation } from './lib/desktop-build-command.mjs';
import { invokedDirectly } from './lib/module-entry.mjs';

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

export const SHELL_E2E_LANES = [
  {
    name: 'plugin-host-security',
    spec: 'tests/tauri-shell/plugin-host-security.e2e.ts',
  },
  {
    // #1969: the Device pane against a real Station route and a fixture
    // device helper. Deliberately a named lane rather than a PR-smoke
    // addition — it needs a built shell binary and boots the whole app.
    name: 'device-pane',
    spec: 'tests/tauri-shell/device-pane.e2e.ts',
  },
];

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
  const revision = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (revision.status !== 0)
    throw new Error('Could not resolve the Tauri E2E source revision.');
  // Named lanes, each a separate process so one lane's app fixture cannot
  // outlive it into the next. `--lane=<name>` runs one; the default runs all.
  //
  // "All" became TWO with #1969's Device lane, and they run SERIALLY, so a
  // bare `npm run test:tauri-shell` now costs the sum of both (#2091). Each
  // lane boots the whole shell, waits on a real WebView and tears a fixture
  // home down, so that is minutes rather than seconds.
  //
  // And `run` exits the process on a non-zero lane, so the FIRST failure ends
  // the sweep: a red `plugin-host-security` means `device-pane` did not run at
  // all rather than passing. Use `--lane=<name>` to reach a later lane while an
  // earlier one is red, and to iterate on one without paying for the other.
  const requested = process.argv
    .slice(2)
    .find((argument) => argument.startsWith('--lane='))
    ?.slice('--lane='.length);
  const lanes = requested
    ? SHELL_E2E_LANES.filter((lane) => lane.name === requested)
    : SHELL_E2E_LANES;
  if (lanes.length === 0) {
    throw new Error(
      `Unknown Tauri shell lane '${requested}'. Known lanes: ${SHELL_E2E_LANES.map((lane) => lane.name).join(', ')}.`,
    );
  }
  for (const lane of lanes) {
    run(process.execPath, ['--import', 'tsx', lane.spec], {
      env: {
        ...process.env,
        STATION_TAURI_E2E_BINARY: binary,
        STATION_TAURI_E2E_SOURCE_SHA: revision.stdout.trim(),
      },
    });
  }
}

if (invokedDirectly(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(
      `tauri-shell-e2e: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
