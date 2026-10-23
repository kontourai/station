import { execFile } from 'node:child_process';
import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, posix, win32 } from 'node:path';

const DEVICE_TOOL_RUNTIME_SETUP =
  'Install Node.js 24 or later with npm and make node available on your PATH to use device tools. Restart Station after changing your PATH.';

export class DeviceToolRuntimeUnavailableError extends Error {
  constructor(reason: string) {
    super(`${reason} ${DEVICE_TOOL_RUNTIME_SETUP}`);
    this.name = 'DeviceToolRuntimeUnavailableError';
  }
}

export interface DeviceToolRuntime {
  nodePath: string;
  version: string;
  npm: { command: string; prefixArgs: string[] };
}

function regularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Only npm associated with this Node installation; never a later PATH entry. */
export function resolveNpmCommand(
  nodePath: string,
  platform: NodeJS.Platform = process.platform,
  isFile: (path: string) => boolean = regularFile,
  realpath: (path: string) => string = realpathSync,
): DeviceToolRuntime['npm'] | undefined {
  const path = platform === 'win32' ? win32 : posix;
  if (
    !path.isAbsolute(nodePath) ||
    /^station-node(?:\.exe)?$/i.test(path.basename(nodePath))
  )
    return undefined;
  const bin = path.dirname(nodePath);
  const candidates = [
    path.join(bin, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(
      path.dirname(bin),
      'lib',
      'node_modules',
      'npm',
      'bin',
      'npm-cli.js',
    ),
  ];
  // Homebrew and distro packages may link bin/npm to their own npm CLI.
  // Windows npm.cmd cannot be spawned without a shell; use its adjacent JS.
  if (platform !== 'win32') {
    try {
      const sibling = realpath(path.join(bin, 'npm'));
      if (path.basename(sibling) === 'npm-cli.js') candidates.push(sibling);
    } catch {
      // No sibling npm; the explicit distribution layouts above still apply.
    }
  }
  const cli = candidates.find(isFile);
  return cli ? { command: nodePath, prefixArgs: [cli] } : undefined;
}

function probeEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    'PATH',
    'HOME',
    'USER',
    'LOGNAME',
    'SHELL',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'SystemRoot',
    'windir',
    'TMPDIR',
    'TMP',
    'TEMP',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'XDG_CACHE_HOME',
    'MISE_CONFIG_DIR',
    'MISE_DATA_DIR',
    'MISE_CACHE_DIR',
    'MISE_ENV',
    'NVM_DIR',
    'ASDF_DATA_DIR',
    'ASDF_DIR',
    'NODENV_ROOT',
    'VOLTA_HOME',
    'FNM_DIR',
    'FNM_MULTISHELL_PATH',
  ]) {
    if (source[key] !== undefined) env[key] = source[key];
  }
  return env;
}

/** Resolve the user's Node, including mise/nvm shims, without altering PATH. */
export async function resolveDeviceToolRuntime(
  env: NodeJS.ProcessEnv = process.env,
): Promise<DeviceToolRuntime> {
  let candidate: string | undefined;
  for (const entry of (env.PATH ?? '').split(
    process.platform === 'win32' ? ';' : ':',
  )) {
    const directory = entry.replace(/^"(.*)"$/, '$1');
    if (!isAbsolute(directory)) continue;
    const executable = join(
      directory,
      process.platform === 'win32' ? 'node.exe' : 'node',
    );
    try {
      if (!regularFile(executable)) continue;
      accessSync(executable, constants.X_OK);
      if (/^station-node(?:\.exe)?$/i.test(basename(realpathSync(executable))))
        continue;
      candidate = executable;
      break;
    } catch {
      // Continue only past absent or non-executable PATH entries.
    }
  }
  if (!candidate)
    throw new DeviceToolRuntimeUnavailableError(
      'A user-installed Node.js was not found.',
    );
  const executable = candidate;
  let output: string;
  try {
    output = await new Promise<string>((resolve, reject) => {
      execFile(
        executable,
        [
          '-p',
          'JSON.stringify({nodePath:process.execPath,version:process.versions.node})',
        ],
        {
          env: probeEnvironment(env),
          windowsHide: true,
          timeout: 10_000,
          maxBuffer: 4096,
        },
        (error, stdout) => (error ? reject(error) : resolve(stdout)),
      );
    });
  } catch {
    throw new DeviceToolRuntimeUnavailableError(
      'The user-installed Node.js could not start.',
    );
  }
  let identity: { nodePath?: unknown; version?: unknown };
  try {
    const value: unknown = JSON.parse(output);
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('invalid Node report');
    identity = {
      nodePath: 'nodePath' in value ? value.nodePath : undefined,
      version: 'version' in value ? value.version : undefined,
    };
  } catch {
    throw new DeviceToolRuntimeUnavailableError(
      'The user-installed Node.js did not report its version.',
    );
  }
  if (
    typeof identity.nodePath !== 'string' ||
    !isAbsolute(identity.nodePath) ||
    typeof identity.version !== 'string' ||
    !/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(identity.version)
  )
    throw new DeviceToolRuntimeUnavailableError(
      'The user-installed Node.js identity is invalid.',
    );
  let nodePath: string;
  try {
    nodePath = realpathSync(identity.nodePath);
    if (!regularFile(nodePath)) throw new Error('not a regular executable');
    accessSync(nodePath, constants.X_OK);
  } catch {
    throw new DeviceToolRuntimeUnavailableError(
      'The selected user-installed Node.js is no longer available.',
    );
  }
  if (/^station-node(?:\.exe)?$/i.test(basename(nodePath)))
    throw new DeviceToolRuntimeUnavailableError(
      'Device tools require a user-installed Node.js.',
    );
  if (Number(identity.version.split('.')[0]) < 24)
    throw new DeviceToolRuntimeUnavailableError(
      `The user-installed Node.js ${identity.version} is too old.`,
    );
  const npm = resolveNpmCommand(nodePath);
  if (!npm)
    throw new DeviceToolRuntimeUnavailableError(
      'npm was not found in the selected Node.js installation.',
    );
  return { nodePath, version: identity.version, npm };
}
