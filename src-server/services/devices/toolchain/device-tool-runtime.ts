import { execFile } from 'node:child_process';
import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, posix, win32 } from 'node:path';

/**
 * Reached only when neither a Node.js on Station's PATH nor the Node.js
 * running Station has a usable npm: in practice an archive built before its
 * runtime carried npm, or the desktop app, whose private Node is never used.
 * Updating Station is the route that needs no other software.
 */
export const DEVICE_TOOL_RUNTIME_SETUP =
  'Update Station on this computer; current Station releases include the npm device tools need. With the Station desktop app, or if updating does not help, install Node.js 24 or later with npm and restart Station.';

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

/** The first executable `node` on PATH, unresolved, or undefined. */
function firstPathNode(env: NodeJS.ProcessEnv): string | undefined {
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
      return executable;
    } catch {
      // Continue only past absent or non-executable PATH entries.
    }
  }
  return undefined;
}

export interface DeviceToolRuntimeOptions {
  /**
   * The Node.js running Station, tried when PATH offers no usable Node with
   * npm. Defaults to `process.execPath`: an archive's runtime, which carries
   * its distribution's npm. `null` means there is none.
   */
  bundledNodePath?: string | null;
}

/**
 * Resolve Node and its own npm for device tools without altering PATH: the
 * first `node` on PATH (following mise/nvm shims) when it is usable, else the
 * Node.js running Station. The desktop's private `station-node` never is.
 */
export async function resolveDeviceToolRuntime(
  env: NodeJS.ProcessEnv = process.env,
  options: DeviceToolRuntimeOptions = {},
): Promise<DeviceToolRuntime> {
  const bundled =
    options.bundledNodePath === undefined
      ? process.execPath
      : options.bundledNodePath;
  const failures: DeviceToolRuntimeUnavailableError[] = [];
  for (const candidate of [firstPathNode(env), bundled ?? undefined]) {
    if (!candidate) continue;
    try {
      return await probeRuntime(candidate, env);
    } catch (error) {
      if (!(error instanceof DeviceToolRuntimeUnavailableError)) throw error;
      failures.push(error);
    }
  }
  throw (
    failures[0] ??
    new DeviceToolRuntimeUnavailableError('Node.js with npm was not found.')
  );
}

async function probeRuntime(
  executable: string,
  env: NodeJS.ProcessEnv,
): Promise<DeviceToolRuntime> {
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
      'The selected Node.js could not start.',
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
      'The selected Node.js did not report its version.',
    );
  }
  if (
    typeof identity.nodePath !== 'string' ||
    !isAbsolute(identity.nodePath) ||
    typeof identity.version !== 'string' ||
    !/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(identity.version)
  )
    throw new DeviceToolRuntimeUnavailableError(
      'The selected Node.js identity is invalid.',
    );
  let nodePath: string;
  try {
    nodePath = realpathSync(identity.nodePath);
    if (!regularFile(nodePath)) throw new Error('not a regular executable');
    accessSync(nodePath, constants.X_OK);
  } catch {
    throw new DeviceToolRuntimeUnavailableError(
      'The selected Node.js is no longer available.',
    );
  }
  if (/^station-node(?:\.exe)?$/i.test(basename(nodePath)))
    throw new DeviceToolRuntimeUnavailableError(
      "Device tools cannot use the desktop app's private Node.js.",
    );
  if (Number(identity.version.split('.')[0]) < 24)
    throw new DeviceToolRuntimeUnavailableError(
      `The selected Node.js ${identity.version} is too old.`,
    );
  const npm = resolveNpmCommand(nodePath);
  if (!npm)
    throw new DeviceToolRuntimeUnavailableError(
      'npm was not found in the selected Node.js installation.',
    );
  return { nodePath, version: identity.version, npm };
}
