#!/usr/bin/env node

import { spawn } from 'node:child_process';
import {
  accessSync,
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { sanitizePath } from '@kontourai/station-shared/launch-path';

export const SUPPORTED_CLIENT_COMMANDS = Object.freeze([
  'claude',
  'codex',
  'kiro-cli',
  'cursor-agent',
  'opencode',
]);

const BEGIN = '__STATION_PATH_BEGIN__';
const END = '__STATION_PATH_END__';
const LOGIN_COMMAND = `printf '${BEGIN}%s${END}\\n' "$PATH"`;

export { sanitizePath };

function modeIsCrossUserWritable(info) {
  return (info.mode & 0o022) !== 0;
}

export function isTrustedClientMetadata(info, currentUid = process.getuid?.()) {
  const ownerIsTrusted =
    currentUid === undefined || info.uid === 0 || info.uid === currentUid;
  return ownerIsTrusted && !modeIsCrossUserWritable(info);
}

function trustedOwner(info) {
  return isTrustedClientMetadata(
    { uid: info.uid, mode: 0 },
    process.getuid?.(),
  );
}

function validateTrustedDirectoryAncestry(directory) {
  let current = realpathSync(directory);
  while (true) {
    const info = lstatSync(current);
    if (!info.isDirectory() || !trustedOwner(info)) return false;
    const rootOwnedStickyDirectory =
      info.uid === 0 && (info.mode & 0o1000) !== 0;
    if (modeIsCrossUserWritable(info) && !rootOwnedStickyDirectory)
      return false;
    const parent = path.dirname(current);
    if (parent === current) return true;
    current = parent;
  }
}

export function validateResolvedClientTarget(targetInput) {
  let target;
  try {
    target = realpathSync(targetInput);
    const info = lstatSync(target);
    if (
      !path.isAbsolute(target) ||
      !info.isFile() ||
      !isTrustedClientMetadata(info)
    ) {
      return null;
    }
    accessSync(target, constants.X_OK);
    if (!validateTrustedDirectoryAncestry(path.dirname(target))) return null;
  } catch {
    return null;
  }
  return target;
}

function defaultAllowedShells() {
  try {
    return readFileSync('/etc/shells', 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith('/'))
      .map((shell) => {
        try {
          return realpathSync(shell);
        } catch {
          return shell;
        }
      });
  } catch {
    return ['/bin/sh', '/bin/zsh', '/bin/bash'];
  }
}

export async function captureLoginShellPath(
  shell,
  { timeoutMs = 5_000, allowedShells = defaultAllowedShells() } = {},
) {
  if (!shell || !path.isAbsolute(shell) || !existsSync(shell)) {
    throw new Error(`login shell is unavailable: ${shell || '(unset)'}`);
  }
  const resolvedShell = realpathSync(shell);
  const resolvedAllowedShells = allowedShells.flatMap((entry) => {
    try {
      return [realpathSync(entry)];
    } catch {
      return [];
    }
  });
  if (!resolvedAllowedShells.includes(resolvedShell)) {
    throw new Error(`unsupported login shell: ${shell}`);
  }
  accessSync(resolvedShell, constants.X_OK);
  return await new Promise((resolve, reject) => {
    const child = spawn(resolvedShell, ['-l', '-c', LOGIN_COMMAND], {
      detached: true,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    timer = setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
      child.stdout.destroy();
      child.stderr.destroy();
      finish(() =>
        reject(
          new Error(`login shell PATH capture timed out after ${timeoutMs}ms`),
        ),
      );
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.length > 1024 * 1024) child.kill('SIGKILL');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (stderr.length > 1024 * 1024) child.kill('SIGKILL');
    });
    child.once('error', (error) => {
      finish(() =>
        reject(new Error(`login shell could not start: ${error.message}`)),
      );
    });
    child.once('close', (status) => {
      if (settled) return;
      if (status !== 0)
        return finish(() =>
          reject(
            new Error(`login shell PATH capture exited with status ${status}`),
          ),
        );
      const begin = stdout.indexOf(BEGIN);
      const end = begin < 0 ? -1 : stdout.indexOf(END, begin + BEGIN.length);
      if (begin < 0 || end < 0 || stdout.indexOf(BEGIN, begin + 1) >= 0) {
        return finish(() =>
          reject(
            new Error(
              'login shell PATH capture did not contain exactly one sentinel value',
            ),
          ),
        );
      }
      const value = stdout.slice(begin + BEGIN.length, end);
      if (
        value.includes('\0') ||
        value.includes('\n') ||
        value.includes('\r')
      ) {
        return finish(() =>
          reject(
            new Error('login shell PATH capture returned a malformed value'),
          ),
        );
      }
      finish(() => resolve(value));
    });
  });
}

export function resolveSupportedClients(directories) {
  const selected = {};
  for (const command of SUPPORTED_CLIENT_COMMANDS) {
    for (const directory of directories) {
      const candidate = path.join(directory, command);
      try {
        const info = lstatSync(candidate);
        if (!info.isFile() && !info.isSymbolicLink()) continue;
        accessSync(candidate, constants.X_OK);
        const target = validateResolvedClientTarget(candidate);
        if (!target) continue;
        selected[command] = target;
        break;
      } catch {
        // A missing or non-executable candidate is not selected.
      }
    }
  }
  return selected;
}

function validateShimParent(shimDirectory, expectedParent) {
  if (path.basename(shimDirectory) !== 'clients') {
    throw new Error('client shim directory must be named clients');
  }
  const parent = path.dirname(shimDirectory);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const parentLinkInfo = lstatSync(parent);
  if (parentLinkInfo.isSymbolicLink()) {
    throw new Error(`${parent} must be a real directory, not a symlink`);
  }
  const realParent = realpathSync(parent);
  const realExpectedParent = realpathSync(expectedParent);
  if (realParent !== realExpectedParent || parent !== expectedParent) {
    throw new Error('client shim path escaped its expected Station-owned root');
  }
  const info = lstatSync(realParent);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error(`${parent} must be a real directory`);
  if (process.getuid && info.uid !== process.getuid())
    throw new Error(`${parent} must be owned by the current user`);
  chmodSync(realParent, 0o700);
  return realParent;
}

export function materializeClientShims(
  shimDirectory,
  selected,
  { expectedParent = path.dirname(shimDirectory) } = {},
) {
  if (!path.isAbsolute(shimDirectory))
    throw new Error('client shim directory must be absolute');
  if (!path.isAbsolute(expectedParent))
    throw new Error('expected client shim parent must be absolute');
  const parent = validateShimParent(shimDirectory, expectedParent);
  const stage = path.join(
    parent,
    `.clients.stage-${process.pid}-${Date.now()}`,
  );
  mkdirSync(stage, { mode: 0o700 });
  try {
    for (const [command, targetInput] of Object.entries(selected)) {
      if (
        !SUPPORTED_CLIENT_COMMANDS.includes(command) ||
        path.basename(command) !== command
      ) {
        throw new Error(`unsupported client shim name: ${command}`);
      }
      const target = validateResolvedClientTarget(targetInput);
      if (!target) throw new Error(`${command} target is not trusted`);
      symlinkSync(target, path.join(stage, command));
      const publishedTarget = validateResolvedClientTarget(
        path.join(stage, command),
      );
      if (publishedTarget !== target)
        throw new Error(`${command} shim verification failed`);
    }
    chmodSync(stage, 0o700);
    const backup = path.join(
      parent,
      `.clients.old-${process.pid}-${Date.now()}`,
    );
    if (existsSync(shimDirectory)) renameSync(shimDirectory, backup);
    try {
      renameSync(stage, shimDirectory);
      rmSync(backup, { recursive: true, force: true });
    } catch (error) {
      if (existsSync(backup) && !existsSync(shimDirectory))
        renameSync(backup, shimDirectory);
      throw error;
    }
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

function describeTree(directory) {
  const walk = (current, relative = '') => {
    const info = lstatSync(current);
    const record = {
      path: relative,
      type: info.isDirectory()
        ? 'directory'
        : info.isSymbolicLink()
          ? 'symlink'
          : info.isFile()
            ? 'file'
            : 'other',
      uid: info.uid,
      gid: info.gid,
      mode: info.mode & 0o7777,
      link: info.isSymbolicLink() ? readlinkSync(current) : null,
    };
    const records = [record];
    if (info.isDirectory()) {
      for (const name of readdirSync(current).sort()) {
        records.push(
          ...walk(path.join(current, name), path.join(relative, name)),
        );
      }
    }
    return records;
  };
  return walk(directory);
}

export function snapshotClientShims(source, snapshot) {
  const description = describeTree(source);
  rmSync(snapshot, { recursive: true, force: true });
  mkdirSync(snapshot, { mode: description[0].mode });
  for (const record of description.slice(1)) {
    const from = path.join(source, record.path);
    const to = path.join(snapshot, record.path);
    if (record.type === 'directory') mkdirSync(to, { mode: record.mode });
    else if (record.type === 'symlink') symlinkSync(record.link, to);
    else if (record.type === 'file')
      copyFileSync(from, to, constants.COPYFILE_EXCL);
    else throw new Error(`unsupported shim snapshot entry: ${record.path}`);
    if (record.type !== 'symlink') chmodSync(to, record.mode);
  }
  chmodSync(snapshot, description[0].mode);
  if (JSON.stringify(describeTree(snapshot)) !== JSON.stringify(description)) {
    throw new Error('client shim snapshot verification failed');
  }
}

export function restoreClientShims(snapshot, target, hooks = {}) {
  const expected = describeTree(snapshot);
  const stage = path.join(
    path.dirname(target),
    `.clients.restore-${process.pid}-${Date.now()}`,
  );
  snapshotClientShims(snapshot, stage);
  const backup = path.join(
    path.dirname(target),
    `.clients.rollback-backup-${process.pid}-${Date.now()}`,
  );
  try {
    hooks.beforePublish?.();
    if (existsSync(target)) renameSync(target, backup);
    try {
      renameSync(stage, target);
      hooks.afterPublish?.();
      if (JSON.stringify(describeTree(target)) !== JSON.stringify(expected)) {
        throw new Error('restored client shim tree differs from its snapshot');
      }
      for (const record of expected) {
        if (record.type === 'symlink') {
          const restored = path.join(target, record.path);
          if (!validateResolvedClientTarget(restored)) {
            throw new Error(
              `restored client shim target is not trusted: ${record.path}`,
            );
          }
        }
      }
      rmSync(backup, { recursive: true, force: true });
    } catch (error) {
      rmSync(target, { recursive: true, force: true });
      if (existsSync(backup)) renameSync(backup, target);
      throw error;
    }
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

async function main() {
  const args = Object.fromEntries(
    process.argv.slice(2).map((arg) => {
      const [key, ...rest] = arg.replace(/^--/, '').split('=');
      return [key, rest.join('=')];
    }),
  );
  if (args.materialize) {
    if (!args.input || !args.shim || !args.root) {
      throw new Error(
        'materialize requires --input=FILE, --shim=PATH, and --root=PATH',
      );
    }
    const input = JSON.parse(readFileSync(args.input, 'utf8'));
    materializeClientShims(args.shim, input.selected ?? {}, {
      expectedParent: args.root,
    });
    return;
  }
  if (args.snapshot) {
    if (!args.shim || !args.root) {
      throw new Error('snapshot requires --shim=PATH and --root=PATH');
    }
    validateShimParent(args.shim, args.root);
    snapshotClientShims(args.shim, args.snapshot);
    return;
  }
  if (args.restore) {
    if (!args.shim || !args.root) {
      throw new Error('restore requires --shim=PATH and --root=PATH');
    }
    validateShimParent(args.shim, args.root);
    restoreClientShims(args.restore, args.shim);
    return;
  }
  if (!args.shell || !args.output)
    throw new Error(
      'usage: station-dogfood-launch-path.mjs --shell=PATH --output=FILE',
    );
  const result = { accepted: [], rejected: [], selected: {}, warning: null };
  try {
    const captured = await captureLoginShellPath(args.shell);
    const sanitized = sanitizePath(captured);
    // The transient artifact feeds materialization and diagnostics, so retain
    // selections and rejection reasons but never persist login PATH entries.
    result.rejected = sanitized.rejected.map(({ reason }) => ({ reason }));
    result.selected = resolveSupportedClients(sanitized.accepted);
  } catch (error) {
    result.warning = error instanceof Error ? error.message : String(error);
  }
  const { writeFileSync } = await import('node:fs');
  writeFileSync(args.output, `${JSON.stringify(result, null, 2)}\n`, {
    mode: 0o600,
  });
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
