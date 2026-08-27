import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { npmBuildInvocation } from './lib/desktop-build-command.mjs';
import {
  WINDOWS_DESKTOP_RUNTIME_RESOURCE_DIR,
  WINDOWS_DESKTOP_RUNTIME_TAURI_CONFIG,
} from './lib/desktop-server-runtime.mjs';

const projectRoot = resolve(import.meta.dirname, '..');
const tauriBuildArgs = [
  'run',
  'tauri',
  '--',
  'build',
  ...process.argv.slice(2),
];

function run(args, env = process.env) {
  const invocation = npmBuildInvocation(args, {
    npmExecPath: env.npm_execpath,
  });
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: projectRoot,
    env,
    stdio: 'inherit',
    shell: false,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (process.platform !== 'win32') {
  run(tauriBuildArgs);
  process.exit(0);
}

// WiX 3.14 and NSIS cannot bind Station's ordinary deeply nested runtime
// tree (station#2424): the platform config's `../dist-desktop-runtime` source
// paths exceed MAX_PATH once the bundler prefixes them with `src-desktop\..\`.
// Stage shallow package aliases first, then hand the staged config to the CLI
// with `--config`, which merges AFTER tauri.windows.conf.json and so actually
// null-removes the deep resource entry. The previous TAURI_CONFIG env-var
// approach was a Tauri v1 mechanism: the v2 CLI only ever SETS that variable
// (from its --config arguments, for tauri-build/codegen) and never reads it,
// so the staged aliases silently never reached either bundler.
run(['run', 'build:desktop:resources']);
const configPath = join(
  projectRoot,
  WINDOWS_DESKTOP_RUNTIME_RESOURCE_DIR,
  WINDOWS_DESKTOP_RUNTIME_TAURI_CONFIG,
);
if (!existsSync(configPath)) {
  throw new Error(
    `Windows desktop resource config was not staged: ${configPath}`,
  );
}
run([...tauriBuildArgs, '--config', configPath]);
