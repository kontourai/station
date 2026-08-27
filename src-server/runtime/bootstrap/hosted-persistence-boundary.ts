import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  type Stats,
} from 'node:fs';
import { dirname } from 'node:path';
import { isHostedTenantExecutionRequired } from './runtime-tenant-context.js';

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const GROUP_OR_OTHER_PERMISSIONS = 0o077;
const GROUP_OR_OTHER_WRITE_PERMISSIONS = 0o022;

type FileIdentity = Pick<Stats, 'dev' | 'ino'>;

export interface HostedPersistenceBoundaryDependencies {
  platform: NodeJS.Platform;
  getuid?: () => number;
  lstatSync(path: string): Stats;
  fstatSync(descriptor: number): Stats;
  mkdirSync(path: string, options: { mode: number }): string | undefined;
  openSync(path: string, flags: number, mode?: number): number;
  closeSync(descriptor: number): void;
  fchmodSync(descriptor: number, mode: number): void;
  constants: Pick<
    typeof constants,
    'O_CREAT' | 'O_EXCL' | 'O_NOFOLLOW' | 'O_RDONLY' | 'O_WRONLY'
  > &
    Partial<Pick<typeof constants, 'O_DIRECTORY'>>;
}

const systemDependencies: HostedPersistenceBoundaryDependencies = {
  platform: process.platform,
  getuid: process.getuid?.bind(process),
  lstatSync,
  fstatSync,
  mkdirSync,
  openSync,
  closeSync,
  fchmodSync,
  constants,
};

/** A safe-to-log failure: it identifies the broken boundary, never its tenant. */
export class HostedPersistenceBoundaryError extends Error {
  readonly code = 'HOSTED_PERSISTENCE_BOUNDARY_REJECTED';

  constructor(reason: string) {
    super(
      `Hosted runtime requires a private Station persistence boundary: ${reason}.`,
    );
  }
}

function reject(reason: string): never {
  throw new HostedPersistenceBoundaryError(reason);
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

function isAlreadyPresent(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'EEXIST'
  );
}

function lstatIfPresent(
  path: string,
  dependencies: HostedPersistenceBoundaryDependencies,
): Stats | undefined {
  try {
    return dependencies.lstatSync(path);
  } catch (error) {
    if (isMissing(error)) return undefined;
    reject('the Station home metadata could not be inspected');
  }
}

function identity(stats: FileIdentity): FileIdentity {
  return { dev: stats.dev, ino: stats.ino };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function hostedUid(
  dependencies: HostedPersistenceBoundaryDependencies,
): number {
  if (dependencies.platform === 'win32') {
    reject(
      'Windows hosted mode is unsupported because no ACL boundary is available',
    );
  }
  if (!dependencies.getuid) {
    reject('the effective service UID is unavailable');
  }
  return dependencies.getuid();
}

function assertPrivateDirectory(
  stats: Stats,
  subject: 'Station home' | 'data directory',
  uid: number,
): void {
  if (stats.isSymbolicLink()) reject(`${subject} must not be a symbolic link`);
  if (!stats.isDirectory()) reject(`${subject} must be a directory`);
  if (stats.uid !== uid) reject(`${subject} must be owned by the service user`);
  if ((stats.mode & GROUP_OR_OTHER_PERMISSIONS) !== 0) {
    reject(`${subject} must not grant group or other access`);
  }
  if (
    subject === 'data directory' &&
    (stats.mode & 0o777) !== PRIVATE_DIRECTORY_MODE
  ) {
    reject('data directory must use mode 0700');
  }
}

function assertPrivateFile(stats: Stats, uid: number): void {
  if (stats.isSymbolicLink())
    reject('the orchestration database must not be a symbolic link');
  if (!stats.isFile())
    reject('the orchestration database must be a regular file');
  if (stats.uid !== uid) {
    reject('the orchestration database must be owned by the service user');
  }
  if ((stats.mode & GROUP_OR_OTHER_PERMISSIONS) !== 0) {
    reject('the orchestration database must not grant group or other access');
  }
  if ((stats.mode & 0o777) !== PRIVATE_FILE_MODE) {
    reject('the orchestration database must use mode 0600');
  }
}

/**
 * The runtime controls this immediate parent/child boundary. Do not walk above
 * it: macOS commonly exposes `/var` through a system-owned symlink, which is
 * outside Station's storage authority and cannot be made a hosted invariant.
 */
function assertControlledParentIsNotSymlink(
  path: string,
  dependencies: HostedPersistenceBoundaryDependencies,
): void {
  const parent = lstatIfPresent(dirname(path), dependencies);
  if (!parent) return;
  if (parent.isSymbolicLink()) {
    reject('the Station persistence path must not contain symbolic links');
  }
  if (!parent.isDirectory()) {
    reject('the Station persistence path contains a non-directory component');
  }
}

function assertCreationParent(stats: Stats): void {
  if (stats.isSymbolicLink())
    reject('the Station home parent must not be a symbolic link');
  if (!stats.isDirectory())
    reject('the Station home parent must be a directory');
  // The parent may be a system-owned traversable directory, but it cannot let
  // another user replace the absent home between this check and bootstrap.
  if ((stats.mode & GROUP_OR_OTHER_WRITE_PERMISSIONS) !== 0) {
    reject(
      'the Station home parent must not grant group or other write access',
    );
  }
}

function assertStableDirectory(
  path: string,
  expected: FileIdentity,
  subject: 'Station home' | 'data directory',
  uid: number,
  dependencies: HostedPersistenceBoundaryDependencies,
): Stats {
  const current = lstatIfPresent(path, dependencies);
  if (!current || !sameIdentity(identity(current), expected)) {
    reject(
      `${subject} changed while its persistence boundary was being prepared`,
    );
  }
  assertPrivateDirectory(current, subject, uid);
  return current;
}

function openPrivateDirectory(
  path: string,
  dependencies: HostedPersistenceBoundaryDependencies,
): number {
  return dependencies.openSync(
    path,
    dependencies.constants.O_RDONLY |
      (dependencies.constants.O_DIRECTORY ?? 0) |
      (dependencies.constants.O_NOFOLLOW ?? 0),
  );
}

function createOrValidateDataDirectory(
  dataPath: string,
  homeIdentity: FileIdentity,
  uid: number,
  dependencies: HostedPersistenceBoundaryDependencies,
): FileIdentity {
  let data = lstatIfPresent(dataPath, dependencies);
  if (!data) {
    try {
      dependencies.mkdirSync(dataPath, { mode: PRIVATE_DIRECTORY_MODE });
    } catch (error) {
      if (!isAlreadyPresent(error)) {
        reject(
          'the data directory could not be created with private permissions',
        );
      }
    }
    assertStableDirectory(
      dirname(dataPath),
      homeIdentity,
      'Station home',
      uid,
      dependencies,
    );
    data = lstatIfPresent(dataPath, dependencies);
    if (!data) reject('the data directory disappeared during creation');
    assertPrivateDirectory(data, 'data directory', uid);
    const descriptor = openPrivateDirectory(dataPath, dependencies);
    try {
      dependencies.fchmodSync(descriptor, PRIVATE_DIRECTORY_MODE);
      const descriptorStats = dependencies.fstatSync(descriptor);
      assertPrivateDirectory(descriptorStats, 'data directory', uid);
      data = assertStableDirectory(
        dataPath,
        identity(descriptorStats),
        'data directory',
        uid,
        dependencies,
      );
    } finally {
      dependencies.closeSync(descriptor);
    }
  }
  assertPrivateDirectory(data, 'data directory', uid);
  return identity(data);
}

function createOrValidateDatabase(
  databasePath: string,
  dataIdentity: FileIdentity,
  uid: number,
  dependencies: HostedPersistenceBoundaryDependencies,
): void {
  let database = lstatIfPresent(databasePath, dependencies);
  if (!database) {
    let descriptor: number | undefined;
    try {
      descriptor = dependencies.openSync(
        databasePath,
        dependencies.constants.O_WRONLY |
          dependencies.constants.O_CREAT |
          dependencies.constants.O_EXCL |
          (dependencies.constants.O_NOFOLLOW ?? 0),
        PRIVATE_FILE_MODE,
      );
    } catch (error) {
      if (!isAlreadyPresent(error)) {
        reject(
          'the orchestration database could not be created with private permissions',
        );
      }
    }
    if (descriptor !== undefined) {
      try {
        dependencies.fchmodSync(descriptor, PRIVATE_FILE_MODE);
        const descriptorStats = dependencies.fstatSync(descriptor);
        assertPrivateFile(descriptorStats, uid);
        assertStableDirectory(
          dirname(databasePath),
          dataIdentity,
          'data directory',
          uid,
          dependencies,
        );
        database = lstatIfPresent(databasePath, dependencies);
        if (
          !database ||
          !sameIdentity(identity(database), identity(descriptorStats))
        ) {
          reject(
            'the orchestration database changed while it was being created',
          );
        }
      } finally {
        dependencies.closeSync(descriptor);
      }
    } else {
      database = lstatIfPresent(databasePath, dependencies);
    }
  }
  if (!database)
    reject('the orchestration database disappeared during creation');
  assertPrivateFile(database, uid);
}

/**
 * The first hosted-only gate. It deliberately permits an absent Station home
 * because the schema gate owns the first-home bootstrap and marker creation.
 */
export function assertHostedPersistenceBeforeSchemaSync(
  homeDir: string,
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: HostedPersistenceBoundaryDependencies = systemDependencies,
): void {
  if (!isHostedTenantExecutionRequired(environment)) return;
  const uid = hostedUid(dependencies);
  assertControlledParentIsNotSymlink(homeDir, dependencies);
  const home = lstatIfPresent(homeDir, dependencies);
  if (home) {
    assertPrivateDirectory(home, 'Station home', uid);
    return;
  }
  const parent = lstatIfPresent(dirname(homeDir), dependencies);
  if (!parent) reject('the Station home parent does not exist');
  assertCreationParent(parent);
}

/**
 * The second hosted-only gate. It runs after the schema gate but before any
 * ConfigLoader watcher, TaskGraph, or SQLite/EventStore construction.
 */
export function prepareHostedPersistenceAfterSchemaSync(
  homeDir: string,
  dataDir: string,
  databasePath: string,
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: HostedPersistenceBoundaryDependencies = systemDependencies,
): void {
  if (!isHostedTenantExecutionRequired(environment)) return;
  const uid = hostedUid(dependencies);
  assertControlledParentIsNotSymlink(homeDir, dependencies);
  assertControlledParentIsNotSymlink(dataDir, dependencies);
  assertControlledParentIsNotSymlink(databasePath, dependencies);
  const home = lstatIfPresent(homeDir, dependencies);
  if (!home) reject('the schema gate did not create the Station home');
  assertPrivateDirectory(home, 'Station home', uid);
  const homeIdentity = identity(home);
  const dataIdentity = createOrValidateDataDirectory(
    dataDir,
    homeIdentity,
    uid,
    dependencies,
  );
  assertStableDirectory(
    homeDir,
    homeIdentity,
    'Station home',
    uid,
    dependencies,
  );
  createOrValidateDatabase(databasePath, dataIdentity, uid, dependencies);
  assertStableDirectory(
    dataDir,
    dataIdentity,
    'data directory',
    uid,
    dependencies,
  );
}
