import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { isIP } from 'node:net';
import { dirname, join } from 'node:path';
import { acquireFileMutationLock } from '@kontourai/station-shared/lifecycle-events';
import {
  admitStationRuntimeHome,
  resolveRuntimeHome,
} from '@kontourai/station-shared/runtime-path-resolver';

interface ActiveLocalStationRecord {
  schemaVersion: 1;
  apiBase: string;
  ownerPid: number;
}

export function activeLocalStationPath(stationHome?: string): string {
  const home = stationHome ?? resolveRuntimeHome();
  admitStationRuntimeHome(home);
  return join(home, 'runtime', 'active-local.json');
}

function safeLoopbackOrigin(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return undefined;
  }
  if (
    parsed.protocol !== 'http:' ||
    !(
      parsed.hostname === 'localhost' ||
      parsed.hostname === '::1' ||
      parsed.hostname === '[::1]' ||
      (isIP(parsed.hostname) === 4 && parsed.hostname.split('.')[0] === '127')
    ) ||
    !parsed.port ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash
  ) {
    return undefined;
  }
  return parsed.origin;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function syncDirectory(path: string): void {
  if (process.platform === 'win32') return;
  const fd = openSync(path, fsConstants.O_RDONLY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function ensureTrustedRuntimeDirectory(path: string): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const info = lstatSync(directory);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (typeof process.getuid === 'function' && info.uid !== process.getuid()) ||
    (process.platform !== 'win32' && (info.mode & 0o077) !== 0)
  ) {
    throw new Error(
      `Station runtime directory is not owner-controlled: ${directory}`,
    );
  }
}

export function publishActiveLocalStation(
  record: { apiBase: string; ownerPid: number },
  stationHome?: string,
): void {
  const apiBase = safeLoopbackOrigin(record.apiBase);
  if (
    !apiBase ||
    !Number.isSafeInteger(record.ownerPid) ||
    record.ownerPid <= 0
  ) {
    throw new Error(
      'Active local Station requires a loopback API base and live owner PID',
    );
  }
  const path = activeLocalStationPath(stationHome);
  ensureTrustedRuntimeDirectory(path);
  const release = acquireFileMutationLock(`${path}.mutation`);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(
      temporary,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        (fsConstants.O_NOFOLLOW ?? 0),
      0o600,
    );
    chmodSync(temporary, 0o600);
    writeFileSync(
      fd,
      JSON.stringify({ schemaVersion: 1, apiBase, ownerPid: record.ownerPid }),
      'utf8',
    );
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, path);
    syncDirectory(dirname(path));
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(temporary, { force: true });
    release();
  }
}

export function removeOwnedActiveLocalStation(
  record: { apiBase: string; ownerPid: number },
  stationHome?: string,
  hooks: { afterOpened?: (path: string) => void } = {},
): void {
  const path = activeLocalStationPath(stationHome);
  const expectedApiBase = safeLoopbackOrigin(record.apiBase);
  if (!expectedApiBase) return;
  if (!existsSync(path)) return;
  let release: (() => void) | undefined;
  try {
    release = acquireFileMutationLock(`${path}.mutation`);
  } catch (error) {
    if (!existsSync(path)) return;
    throw error;
  }
  let fd: number | undefined;
  let quarantine: string | undefined;
  try {
    const pathInfo = lstatSync(path);
    if (!pathInfo.isFile() || pathInfo.isSymbolicLink()) return;
    fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const openedInfo = fstatSync(fd);
    const raw = readFileSync(fd, 'utf8');
    const parsed = JSON.parse(raw) as Partial<ActiveLocalStationRecord>;
    if (
      parsed.schemaVersion !== 1 ||
      parsed.ownerPid !== record.ownerPid ||
      safeLoopbackOrigin(parsed.apiBase) !== expectedApiBase
    ) {
      return;
    }
    hooks.afterOpened?.(path);
    quarantine = `${path}.quarantine-${process.pid}-${randomUUID()}`;
    renameSync(path, quarantine);
    const currentInfo = lstatSync(quarantine);
    if (
      currentInfo.dev !== openedInfo.dev ||
      currentInfo.ino !== openedInfo.ino ||
      readFileSync(quarantine, 'utf8') !== raw
    ) {
      throw new Error(`Active local Station changed during removal: ${path}`);
    }
    unlinkSync(quarantine);
    quarantine = undefined;
    syncDirectory(dirname(path));
  } catch (error) {
    if (quarantine && !existsSync(path) && existsSync(quarantine)) {
      renameSync(quarantine, path);
      syncDirectory(dirname(path));
      quarantine = undefined;
    }
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
    release?.();
  }
}

export function readActiveLocalStation(
  options: { path?: string; isProcessAlive?: (pid: number) => boolean } = {},
): string | undefined {
  const path = options.path ?? activeLocalStationPath();
  const isProcessAlive = options.isProcessAlive ?? processIsAlive;
  let fd: number | undefined;
  try {
    const pathInfo = lstatSync(path);
    if (!pathInfo.isFile() || pathInfo.isSymbolicLink()) return undefined;
    fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const info = fstatSync(fd);
    if (
      !info.isFile() ||
      (typeof process.getuid === 'function' && info.uid !== process.getuid()) ||
      (process.platform !== 'win32' && (info.mode & 0o077) !== 0)
    ) {
      return undefined;
    }
    const parsed = JSON.parse(
      readFileSync(fd, 'utf8'),
    ) as Partial<ActiveLocalStationRecord>;
    if (
      parsed.schemaVersion !== 1 ||
      !Number.isSafeInteger(parsed.ownerPid) ||
      (parsed.ownerPid ?? 0) <= 0 ||
      !isProcessAlive(parsed.ownerPid as number)
    ) {
      return undefined;
    }
    return safeLoopbackOrigin(parsed.apiBase);
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
