import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  closeSync,
  fchmodSync,
  constants as fsConstants,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import {
  ensureWindowsDirectoriesTrusted,
  hardenWindowsPathsTrusted,
} from '@kontourai/station-shared/windows-path-trust';

function runWindowsTrust(command: string, args: string[]) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 64 * 1024,
  });
}

const LOCAL_GRANT_DIRECTORY_MODE = 0o700;
const LOCAL_GRANT_FILE_MODE = 0o600;

/**
 * Mints a fresh per-boot local-grant secret (station#1715) and durably writes
 * it to `secretPath` (0700/0600 on POSIX, protected current-user ACLs on
 * Windows), atomically replacing
 * any previous boot's value. The file exists only so the desktop shell —
 * running as the same OS user — can read it directly off disk
 * (`src-desktop/src/lib.rs`'s `station_local_self_provision`); the caller's
 * route never re-reads it, it compares every presented candidate
 * against the value returned here, held in a closure for the life of the
 * process.
 */
export function writeLocalGrantSecretFile(secretPath: string): string {
  const secret = randomBytes(32).toString('base64url');
  mkdirSync(dirname(secretPath), {
    recursive: true,
    mode: LOCAL_GRANT_DIRECTORY_MODE,
  });
  ensureWindowsDirectoriesTrusted(runWindowsTrust, [dirname(secretPath)]);
  const temporaryPath = `${secretPath}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      temporaryPath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
      LOCAL_GRANT_FILE_MODE,
    );
    if (process.platform !== 'win32') {
      fchmodSync(descriptor, LOCAL_GRANT_FILE_MODE);
    }
    // Harden the empty temporary file before writing any secret bytes. Atomic
    // rename preserves this explicit DACL; the native reader can verify it.
    hardenWindowsPathsTrusted(runWindowsTrust, [
      { kind: 'file', path: temporaryPath },
    ]);
    writeFileSync(descriptor, secret, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporaryPath, secretPath);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporaryPath, { force: true });
  }
  return secret;
}
