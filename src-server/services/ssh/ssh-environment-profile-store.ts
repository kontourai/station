import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fsyncDirectorySync } from '@kontourai/station-shared/fs-windows-compat';
import { acquireFileMutationLockAsync } from '@kontourai/station-shared/lifecycle-events';
import { requireOpenSshAlias } from './openssh-config.js';

const PROFILE_SCHEMA_VERSION = 1;
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const MAX_NAME_LENGTH = 120;
/** Exact lowercase UUID-v4 form emitted by {@link randomUUID}. */
const PROFILE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type SshEnvironmentLaunchMode = 'attach' | 'managed';

export interface SshEnvironmentProfile {
  schemaVersion: 1;
  id: string;
  name: string;
  hostAlias: string;
  remoteProjectPath: string;
  remotePort: number;
  /** `'managed'` enables SSH launch bootstrap after the exact probe refusal. */
  launchMode: SshEnvironmentLaunchMode;
  environmentId: string | null;
  hostIdentity: string | null;
  remoteHome: string | null;
  verifiedProjectPath: string | null;
  workerProtocolVersion: number | null;
  createdAt: string;
  updatedAt: string;
  lastConnectedAt: string | null;
}

interface SshEnvironmentProfileDocument {
  schemaVersion: 1;
  profiles: SshEnvironmentProfile[];
}

// Async-compatible seam (#2646): the default is the ASYNC cross-process lock
// so a contended acquisition yields the event loop; sync test fakes remain
// assignable (awaiting a non-promise is a no-op).
type SshEnvironmentProfileMutationLock = (
  lockPath: string,
) => (() => void | Promise<void>) | Promise<() => void | Promise<void>>;

type SshEnvironmentProfileWriteOperations = {
  closeSync: typeof closeSync;
  fsyncDirectorySync: typeof fsyncDirectorySync;
  fsyncSync: typeof fsyncSync;
  renameSync: typeof renameSync;
  rmSync: typeof rmSync;
  writeFileSync: typeof writeFileSync;
};

const sshEnvironmentProfileWriteOperations: SshEnvironmentProfileWriteOperations =
  {
    closeSync,
    fsyncDirectorySync,
    fsyncSync,
    renameSync,
    rmSync,
    writeFileSync,
  };

export interface SshEnvironmentProfileStoreOptions {
  /** Injectable only for deterministic cross-process mutation tests. */
  acquireMutationLock?: SshEnvironmentProfileMutationLock;
  /** Injectable only for durable-write fault-injection tests. */
  writeOperations?: Partial<SshEnvironmentProfileWriteOperations>;
}

export interface VerifiedSshEnvironmentIdentity {
  environmentId: string;
  hostIdentity: string;
  remoteHome: string;
  verifiedProjectPath: string;
  workerProtocolVersion: number;
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

function safeProjectPath(value: string): string {
  const path = value.trim();
  if (!path || path.length > 4096 || hasControlCharacters(path)) {
    throw new Error('Remote project path is invalid');
  }
  return path;
}

function safeName(value: string): string {
  const name = value.trim();
  if (!name || name.length > MAX_NAME_LENGTH || hasControlCharacters(name)) {
    throw new Error('Environment name is invalid');
  }
  return name;
}

function safePersistedName(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('Invalid SSH environment profile schema');
  }
  const name = safeName(value);
  if (name !== value) {
    throw new Error('Invalid SSH environment profile schema');
  }
  return name;
}

function safePersistedHostAlias(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('Invalid SSH environment profile schema');
  }
  const hostAlias = requireOpenSshAlias(value);
  if (hostAlias !== value) {
    throw new Error('Invalid SSH environment profile schema');
  }
  return hostAlias;
}

function safePersistedProjectPath(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('Invalid SSH environment profile schema');
  }
  const remoteProjectPath = safeProjectPath(value);
  if (remoteProjectPath !== value) {
    throw new Error('Invalid SSH environment profile schema');
  }
  return remoteProjectPath;
}

function safePersistedProfileId(value: unknown): string {
  if (typeof value !== 'string' || !PROFILE_ID_PATTERN.test(value)) {
    throw new Error('Invalid SSH environment profile schema');
  }
  return value;
}

function safePersistedTimestamp(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new Error(`Invalid SSH environment ${label}`);
  }
  let canonical: string;
  try {
    canonical = new Date(value).toISOString();
  } catch {
    throw new Error(`Invalid SSH environment ${label}`);
  }
  if (canonical !== value) {
    throw new Error(`Invalid SSH environment ${label}`);
  }
  return canonical;
}

function suffixWithEllipsis(value: string, maximumLength: number): string {
  if (value.length <= maximumLength) return value;
  const suffix: string[] = [];
  let length = 1;
  for (const character of [...value].reverse()) {
    if (length + character.length > maximumLength) break;
    suffix.push(character);
    length += character.length;
  }
  return `…${suffix.reverse().join('')}`;
}

function defaultName(hostAlias: string, remoteProjectPath: string): string {
  const separator = ' · ';
  const full = `${hostAlias}${separator}${remoteProjectPath}`;
  if (full.length <= MAX_NAME_LENGTH) return full;
  const alias =
    hostAlias.length <= 48 ? hostAlias : `${hostAlias.slice(0, 47)}…`;
  const pathBudget = MAX_NAME_LENGTH - alias.length - separator.length;
  return `${alias}${separator}${suffixWithEllipsis(remoteProjectPath, pathBudget)}`;
}

function safePort(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error('Remote Station port must be between 1 and 65535');
  }
  return value;
}

function validateNullableString(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 4096 ||
    hasControlCharacters(value)
  ) {
    throw new Error(`Invalid SSH environment ${label}`);
  }
  return value;
}

function validateProfile(value: unknown): SshEnvironmentProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid SSH environment profile');
  }
  const profile = value as Record<string, unknown>;
  const knownKeys = new Set([
    'schemaVersion',
    'id',
    'name',
    'hostAlias',
    'remoteProjectPath',
    'remotePort',
    'launchMode',
    'environmentId',
    'hostIdentity',
    'remoteHome',
    'verifiedProjectPath',
    'workerProtocolVersion',
    'createdAt',
    'updatedAt',
    'lastConnectedAt',
  ]);
  if (
    Object.keys(profile).some((key) => !knownKeys.has(key)) ||
    profile.schemaVersion !== PROFILE_SCHEMA_VERSION ||
    typeof profile.remotePort !== 'number' ||
    (profile.workerProtocolVersion !== null &&
      (!Number.isInteger(profile.workerProtocolVersion) ||
        (profile.workerProtocolVersion as number) < 1)) ||
    (profile.launchMode !== 'attach' && profile.launchMode !== 'managed')
  ) {
    throw new Error('Invalid SSH environment profile schema');
  }
  const createdAt = safePersistedTimestamp(profile.createdAt, 'createdAt');
  const updatedAt = safePersistedTimestamp(profile.updatedAt, 'updatedAt');
  const lastConnectedAt =
    profile.lastConnectedAt === null
      ? null
      : safePersistedTimestamp(profile.lastConnectedAt, 'lastConnectedAt');
  return {
    schemaVersion: 1,
    id: safePersistedProfileId(profile.id),
    name: safePersistedName(profile.name),
    hostAlias: safePersistedHostAlias(profile.hostAlias),
    remoteProjectPath: safePersistedProjectPath(profile.remoteProjectPath),
    remotePort: safePort(profile.remotePort),
    launchMode: profile.launchMode,
    environmentId: validateNullableString(
      profile.environmentId,
      'environment identity',
    ),
    hostIdentity: validateNullableString(profile.hostIdentity, 'host identity'),
    remoteHome: validateNullableString(profile.remoteHome, 'remote home'),
    verifiedProjectPath: validateNullableString(
      profile.verifiedProjectPath,
      'verified project path',
    ),
    workerProtocolVersion: profile.workerProtocolVersion as number | null,
    createdAt,
    updatedAt,
    lastConnectedAt,
  };
}

function validateDocument(value: unknown): SshEnvironmentProfileDocument {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid SSH environment profile document');
  }
  const document = value as Record<string, unknown>;
  if (
    Object.keys(document).some(
      (key) => key !== 'schemaVersion' && key !== 'profiles',
    ) ||
    document.schemaVersion !== PROFILE_SCHEMA_VERSION ||
    !Array.isArray(document.profiles)
  ) {
    throw new Error('Invalid SSH environment profile document schema');
  }
  const profiles = document.profiles.map(validateProfile);
  if (new Set(profiles.map((profile) => profile.id)).size !== profiles.length) {
    throw new Error('Duplicate SSH environment profile identity');
  }
  return { schemaVersion: 1, profiles };
}

export class SshEnvironmentProfileStore {
  readonly #directory: string;
  readonly #file: string;
  readonly #acquireMutationLock: SshEnvironmentProfileMutationLock;
  readonly #writeOperations: SshEnvironmentProfileWriteOperations;

  constructor(
    homeDir: string,
    options: SshEnvironmentProfileStoreOptions = {},
  ) {
    this.#directory = join(homeDir, 'environments');
    this.#file = join(this.#directory, 'ssh.json');
    this.#acquireMutationLock =
      options.acquireMutationLock ?? acquireFileMutationLockAsync;
    this.#writeOperations = {
      ...sshEnvironmentProfileWriteOperations,
      ...options.writeOperations,
    };
  }

  async initialize(): Promise<void> {
    await mkdir(dirname(this.#directory), {
      recursive: true,
      mode: DIRECTORY_MODE,
    });
    await mkdir(this.#directory, { recursive: true, mode: DIRECTORY_MODE });
    const directory = lstatSync(this.#directory);
    if (!directory.isDirectory() || directory.isSymbolicLink()) {
      throw new Error('Invalid SSH environment profile directory');
    }
    if (process.platform !== 'win32' && (directory.mode & 0o077) !== 0) {
      chmodSync(this.#directory, DIRECTORY_MODE);
    }
    const release = await this.#acquireMutationLock(`${this.#file}.mutation`);
    try {
      if (!existsSync(this.#file)) {
        this.#write({ schemaVersion: 1, profiles: [] });
      } else {
        this.#read();
      }
    } finally {
      await release();
    }
  }

  list(): SshEnvironmentProfile[] {
    return this.#read().profiles;
  }

  get(id: string): SshEnvironmentProfile | null {
    return this.list().find((profile) => profile.id === id) ?? null;
  }

  async add(input: {
    name?: string;
    hostAlias: string;
    remoteProjectPath: string;
    remotePort?: number;
    launchMode?: SshEnvironmentLaunchMode;
  }): Promise<SshEnvironmentProfile> {
    const hostAlias = requireOpenSshAlias(input.hostAlias);
    const remoteProjectPath = safeProjectPath(input.remoteProjectPath);
    const remotePort = safePort(input.remotePort ?? 3141);
    const launchMode: SshEnvironmentLaunchMode =
      input.launchMode === 'managed' ? 'managed' : 'attach';
    return this.#mutate((document) => {
      const existing = document.profiles.find(
        (profile) =>
          profile.hostAlias === hostAlias &&
          profile.remoteProjectPath === remoteProjectPath &&
          profile.remotePort === remotePort,
      );
      if (existing) return { result: existing };
      const now = new Date().toISOString();
      const profile: SshEnvironmentProfile = {
        schemaVersion: 1,
        id: randomUUID(),
        name: safeName(input.name ?? defaultName(hostAlias, remoteProjectPath)),
        hostAlias,
        remoteProjectPath,
        remotePort,
        launchMode,
        environmentId: null,
        hostIdentity: null,
        remoteHome: null,
        verifiedProjectPath: null,
        workerProtocolVersion: null,
        createdAt: now,
        updatedAt: now,
        lastConnectedAt: null,
      };
      return {
        result: profile,
        next: { schemaVersion: 1, profiles: [...document.profiles, profile] },
      };
    });
  }

  async recordVerified(
    id: string,
    identity: VerifiedSshEnvironmentIdentity,
  ): Promise<SshEnvironmentProfile> {
    return this.#mutate((document) => {
      let updated: SshEnvironmentProfile | null = null;
      const now = new Date().toISOString();
      const profiles = document.profiles.map((profile) => {
        if (profile.id !== id) return profile;
        updated = validateProfile({
          ...profile,
          ...identity,
          updatedAt: now,
          lastConnectedAt: now,
        });
        return updated;
      });
      if (!updated) throw new Error('SSH environment not found');
      return {
        result: updated,
        next: { schemaVersion: 1, profiles },
      };
    });
  }

  async remove(id: string): Promise<boolean> {
    return this.#mutate((document) => {
      const profiles = document.profiles.filter((profile) => profile.id !== id);
      if (profiles.length === document.profiles.length)
        return { result: false };
      return {
        result: true,
        next: { schemaVersion: 1, profiles },
      };
    });
  }

  /**
   * Serializes each full read-transition-write across Station processes. A
   * fresh strict read inside the lock prevents stale verification or add from
   * restoring a concurrently removed profile.
   */
  async #mutate<T>(
    mutation: (document: SshEnvironmentProfileDocument) => {
      result: T;
      next?: SshEnvironmentProfileDocument;
    },
  ): Promise<T> {
    const release = await this.#acquireMutationLock(`${this.#file}.mutation`);
    try {
      const outcome = mutation(this.#read());
      if (outcome.next) this.#write(outcome.next);
      return outcome.result;
    } finally {
      await release();
    }
  }

  #read(): SshEnvironmentProfileDocument {
    const status = lstatSync(this.#file);
    if (!status.isFile() || status.isSymbolicLink()) {
      throw new Error('Invalid SSH environment profile file');
    }
    if (process.platform !== 'win32' && (status.mode & 0o077) !== 0) {
      throw new Error('Unsafe SSH environment profile permissions');
    }
    return validateDocument(JSON.parse(readFileSync(this.#file, 'utf8')));
  }

  #write(document: SshEnvironmentProfileDocument): void {
    const payload = `${JSON.stringify(validateDocument(document), null, 2)}\n`;
    const temporary = `${this.#file}.${process.pid}.${randomUUID()}.tmp`;
    let descriptor: number | undefined;
    try {
      descriptor = openSync(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        FILE_MODE,
      );
      this.#writeOperations.writeFileSync(descriptor, payload, 'utf8');
      this.#writeOperations.fsyncSync(descriptor);
      fchmodSync(descriptor, FILE_MODE);
      this.#writeOperations.closeSync(descriptor);
      descriptor = undefined;
      this.#writeOperations.renameSync(temporary, this.#file);
      // Rename is the commit point. A later directory-sync failure cannot
      // truthfully turn a committed profile transition into a failed request.
      try {
        this.#writeOperations.fsyncDirectorySync(this.#directory);
      } catch {
        // The replacement is already durable enough to return the mutation.
      }
    } finally {
      if (descriptor !== undefined) {
        try {
          this.#writeOperations.closeSync(descriptor);
        } catch {
          // Preserve a pre-commit failure and still attempt temp cleanup.
        }
      }
      try {
        this.#writeOperations.rmSync(temporary, { force: true });
      } catch {
        // A cleanup failure must not mask a primary or committed outcome.
      }
    }
  }
}
