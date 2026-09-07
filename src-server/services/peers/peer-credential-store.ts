import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { parsePairingScope } from '@kontourai/station-contracts/environment-security';
import { fsyncDirectorySync } from '@kontourai/station-shared/fs-windows-compat';
import { acquireFileMutationLockAsync } from '@kontourai/station-shared/lifecycle-events';

/**
 * Outbound peer-credential store (archive#1123,
 * `docs/design/station-peer-pairing.md` §5).
 *
 * Keyed by the REMOTE peer's `environmentId`, this holds the bearer
 * credential THIS Station presents when it calls a peer's orchestration
 * routes, plus the scope that credential carries. It is the server-side
 * mirror of `packages/connect`'s `SavedConnection.credentialRef` — that one
 * is client-side ("what I present when I reach a Station"); this one is
 * server-side and OUTBOUND ("what I present when I delegate to a peer").
 *
 * Deliberately a NEW store, not a reuse of an existing one:
 *  - `paired-devices.json` (`device-pairing-service.ts`) is INBOUND only —
 *    credentials OTHER devices/peers present to reach THIS Station.
 *  - `SshEnvironmentProfile` (`ssh-environment-profile-store.ts`) has no
 *    credential field at all — SSH delegation trust is "I can SSH to this
 *    host", never a bearer credential.
 *  - `KnownEnvironment` (`packages/contracts/src/known-environment.ts`)
 *    explicitly refuses to model secrets (see its own doc comment).
 *
 * Secret-bearing, so it is written with the same hardening as
 * `paired-devices.json` (private directory/file mode, symlink/hardlink
 * rejection on read) PLUS the CLI's `host-credentials.ts` posture
 * (`O_EXCL|O_NOFOLLOW` temp creation, unconditional `fchmod`, best-effort
 * temp cleanup) and `SshEnvironmentProfileStore`'s atomic-write shape
 * (temp file, fsync, rename, then fsync the containing directory).
 */

const SCHEMA_VERSION = 1 as const;
const DIRECTORY = 'security';
const FILE = 'peer-credentials.json';
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const MAX_ENVIRONMENT_ID_LENGTH = 200;
const MAX_LABEL_LENGTH = 120;
/**
 * Printable ASCII, no whitespace or control characters, 16-4096 characters.
 * Device-pairing bearer credentials are 43-character base64url, but a peer's
 * credential is opaque to this store — this bound is a sanity floor/ceiling,
 * not a format assertion.
 */
const CREDENTIAL_PATTERN = /^[\x21-\x7e]{16,4096}$/;

export interface PeerCredential {
  environmentId: string;
  /** Bare origin (`https://host:port`) the peer is reached at directly. */
  apiBase: string;
  /** Space-delimited {@link PairingScope} string the peer granted us. */
  scope: string;
  label: string | null;
  createdAt: number;
  updatedAt: number;
}

/** Never includes the credential — safe to log, serialize, and return over any authenticated route. */
export type PeerCredentialSummary = PeerCredential;

/** Internal-only shape carrying the raw secret; never returned from {@link PeerCredentialStore.list}. */
interface StoredPeerCredential extends PeerCredential {
  credential: string;
}

interface PeerCredentialDocument {
  schemaVersion: typeof SCHEMA_VERSION;
  peers: StoredPeerCredential[];
}

// Async-compatible seam (archive#2646): the default is the ASYNC cross-process lock
// so a contended acquisition yields the event loop; sync test fakes remain
// assignable (awaiting a non-promise is a no-op).
type PeerCredentialMutationLock = (
  lockPath: string,
) => (() => void | Promise<void>) | Promise<() => void | Promise<void>>;

type PeerCredentialWriteOperations = {
  closeSync: typeof closeSync;
  fsyncDirectorySync: typeof fsyncDirectorySync;
  fsyncSync: typeof fsyncSync;
  renameSync: typeof renameSync;
  rmSync: typeof rmSync;
  writeFileSync: typeof writeFileSync;
};

const peerCredentialWriteOperations: PeerCredentialWriteOperations = {
  closeSync,
  fsyncDirectorySync,
  fsyncSync,
  renameSync,
  rmSync,
  writeFileSync,
};

export interface PeerCredentialStoreOptions {
  /** Injectable only for deterministic cross-process mutation tests. */
  acquireMutationLock?: PeerCredentialMutationLock;
  /** Injectable only for durable-write fault-injection tests. */
  writeOperations?: Partial<PeerCredentialWriteOperations>;
}

/** Server-owned current-authority recheck for externally reachable mutations. */
export type PeerCredentialMutationAuthorizer = () => boolean;

export class PeerCredentialMutationAuthorizationError extends Error {
  constructor() {
    super('Peer credential mutation is not authorized');
    this.name = 'PeerCredentialMutationAuthorizationError';
  }
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

function safeEnvironmentId(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('Peer environmentId is invalid');
  }
  const trimmed = value.trim();
  if (
    !trimmed ||
    trimmed.length > MAX_ENVIRONMENT_ID_LENGTH ||
    hasControlCharacters(trimmed)
  ) {
    throw new Error('Peer environmentId is invalid');
  }
  return trimmed;
}

/**
 * The writer stores the trimmed identifier. A stored variation would be
 * silently rewritten by a later mutation, so it is corruption rather than a
 * second spelling of the same peer.
 */
function safePersistedEnvironmentId(value: unknown): string {
  const environmentId = safeEnvironmentId(value);
  if (environmentId !== value) {
    throw new Error('Peer environmentId is invalid');
  }
  return environmentId;
}

/** Validates and normalizes to a bare http(s) origin — no path, query, or fragment. */
function safeApiBase(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('Peer apiBase is invalid');
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Peer apiBase is invalid');
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username ||
    url.password ||
    (url.pathname !== '/' && url.pathname !== '') ||
    url.search ||
    url.hash
  ) {
    throw new Error('Peer apiBase must be a bare http(s) origin');
  }
  return url.origin;
}

/** The writer persists the canonical URL origin and never normalizes on read. */
function safePersistedApiBase(value: unknown): string {
  const apiBase = safeApiBase(value);
  if (apiBase !== value) {
    throw new Error('Peer apiBase is invalid');
  }
  return apiBase;
}

function safeScope(value: unknown): string {
  if (typeof value !== 'string' || parsePairingScope(value) === null) {
    throw new Error('Peer scope is invalid');
  }
  return value;
}

function safeCredential(value: unknown): string {
  if (typeof value !== 'string' || !CREDENTIAL_PATTERN.test(value)) {
    throw new Error('Peer credential is invalid');
  }
  return value;
}

function safeLabel(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new Error('Peer label is invalid');
  }
  const trimmed = value.trim();
  if (
    !trimmed ||
    trimmed.length > MAX_LABEL_LENGTH ||
    hasControlCharacters(trimmed)
  ) {
    throw new Error('Peer label is invalid');
  }
  return trimmed;
}

/** Persisted records always carry an explicit label, including `null`. */
function safePersistedLabel(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') {
    throw new Error('Peer label is invalid');
  }
  const trimmed = value.trim();
  if (
    !trimmed ||
    trimmed.length > MAX_LABEL_LENGTH ||
    hasControlCharacters(trimmed) ||
    trimmed !== value
  ) {
    throw new Error('Peer label is invalid');
  }
  return trimmed;
}

/** Stored observations are never fabricated from the current wall clock. */
function safeStoredTimestamp(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Peer ${field} is invalid`);
  }
  return value;
}

function toSummary(record: StoredPeerCredential): PeerCredentialSummary {
  const { credential: _credential, ...safe } = record;
  return safe;
}

function validateDocument(value: unknown): PeerCredentialDocument {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid peer-credential store');
  }
  const record = value as Partial<PeerCredentialDocument>;
  if (record.schemaVersion !== SCHEMA_VERSION || !Array.isArray(record.peers)) {
    throw new Error('Invalid peer-credential store schema');
  }
  const peers = record.peers.map((peer) => ({
    environmentId: safePersistedEnvironmentId(peer.environmentId),
    apiBase: safePersistedApiBase(peer.apiBase),
    scope: safeScope(peer.scope),
    credential: safeCredential(peer.credential),
    label: safePersistedLabel(peer.label),
    createdAt: safeStoredTimestamp(peer.createdAt, 'createdAt'),
    updatedAt: safeStoredTimestamp(peer.updatedAt, 'updatedAt'),
  }));
  if (new Set(peers.map((peer) => peer.environmentId)).size !== peers.length) {
    throw new Error('Duplicate peer-credential environmentId');
  }
  return { schemaVersion: SCHEMA_VERSION, peers };
}

export class PeerCredentialStore {
  readonly #directory: string;
  readonly #file: string;
  readonly #acquireMutationLock: PeerCredentialMutationLock;
  readonly #writeOperations: PeerCredentialWriteOperations;

  constructor(homeDir: string, options: PeerCredentialStoreOptions = {}) {
    this.#directory = join(homeDir, DIRECTORY);
    this.#file = join(this.#directory, FILE);
    this.#acquireMutationLock =
      options.acquireMutationLock ?? acquireFileMutationLockAsync;
    this.#writeOperations = {
      ...peerCredentialWriteOperations,
      ...options.writeOperations,
    };
    this.#ensureDirectory();
    if (existsSync(this.#file)) this.#read();
  }

  list(): PeerCredentialSummary[] {
    return this.#read().peers.map(toSummary);
  }

  /**
   * Internal accessor for the raw credential — callers MUST gate this behind
   * an internal-only boundary (never expose over an externally-reachable
   * route regardless of scope). See
   * `src-server/routes/environments/peer-credential-routes.ts`.
   */
  get(environmentId: string): (PeerCredential & { credential: string }) | null {
    const record = this.#read().peers.find(
      (peer) => peer.environmentId === environmentId,
    );
    return record ? { ...record } : null;
  }

  async upsert(
    input: {
      environmentId: string;
      apiBase: string;
      scope: string;
      credential: string;
      label?: string;
    },
    authorize?: PeerCredentialMutationAuthorizer,
  ): Promise<PeerCredentialSummary> {
    const environmentId = safeEnvironmentId(input.environmentId);
    const apiBase = safeApiBase(input.apiBase);
    const scope = safeScope(input.scope);
    const credential = safeCredential(input.credential);
    const label = safeLabel(input.label);
    return this.#mutate((document) => {
      const now = Date.now();
      const existing = document.peers.find(
        (peer) => peer.environmentId === environmentId,
      );
      const record: StoredPeerCredential = {
        environmentId,
        apiBase,
        scope,
        credential,
        label,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      const peers = existing
        ? document.peers.map((peer) =>
            peer.environmentId === environmentId ? record : peer,
          )
        : [...document.peers, record];
      return {
        result: toSummary(record),
        next: { schemaVersion: SCHEMA_VERSION, peers },
      };
    }, authorize);
  }

  async remove(
    environmentId: string,
    authorize?: PeerCredentialMutationAuthorizer,
  ): Promise<boolean> {
    return this.#mutate((document) => {
      const peers = document.peers.filter(
        (peer) => peer.environmentId !== environmentId,
      );
      if (peers.length === document.peers.length) return { result: false };
      return {
        result: true,
        next: { schemaVersion: SCHEMA_VERSION, peers },
      };
    }, authorize);
  }

  /**
   * Serializes the entire transition across Station processes. The strict
   * document read occurs only after owning the lock, so a stale upsert cannot
   * recreate a credential a concurrent remove already committed.
   */
  async #mutate<T>(
    mutation: (document: PeerCredentialDocument) => {
      result: T;
      next?: PeerCredentialDocument;
    },
    authorize?: PeerCredentialMutationAuthorizer,
  ): Promise<T> {
    const release = await this.#acquireMutationLock(`${this.#file}.mutation`);
    try {
      if (authorize !== undefined) {
        if (typeof authorize !== 'function') {
          throw new PeerCredentialMutationAuthorizationError();
        }
        try {
          const decision: unknown = authorize();
          if (decision !== true) {
            void Promise.resolve(decision).catch(() => {});
            throw new PeerCredentialMutationAuthorizationError();
          }
        } catch {
          throw new PeerCredentialMutationAuthorizationError();
        }
      }
      const outcome = mutation(this.#read());
      if (outcome.next) this.#write(outcome.next);
      return outcome.result;
    } finally {
      await release();
    }
  }

  #ensureDirectory(): void {
    mkdirSync(this.#directory, { recursive: true, mode: DIRECTORY_MODE });
    const status = lstatSync(this.#directory);
    if (!status.isDirectory() || status.isSymbolicLink()) {
      throw new Error('Invalid peer-credential directory');
    }
    if (process.platform !== 'win32' && (status.mode & 0o077) !== 0) {
      throw new Error('Unsafe peer-credential directory permissions');
    }
  }

  #read(): PeerCredentialDocument {
    if (!existsSync(this.#file)) {
      return { schemaVersion: SCHEMA_VERSION, peers: [] };
    }
    const status = lstatSync(this.#file);
    if (
      !status.isFile() ||
      status.isSymbolicLink() ||
      status.nlink !== 1 ||
      (process.platform !== 'win32' && (status.mode & 0o777) !== FILE_MODE)
    ) {
      throw new Error('Unsafe peer-credential store');
    }
    return validateDocument(JSON.parse(readFileSync(this.#file, 'utf8')));
  }

  #write(document: PeerCredentialDocument): void {
    const payload = `${JSON.stringify(validateDocument(document))}\n`;
    const temporary = join(
      dirname(this.#file),
      `.${FILE}.${process.pid}.${randomUUID()}.tmp`,
    );
    let descriptor: number | undefined;
    try {
      descriptor = openSync(
        temporary,
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_WRONLY |
          (constants.O_NOFOLLOW ?? 0),
        FILE_MODE,
      );
      if (process.platform !== 'win32') fchmodSync(descriptor, FILE_MODE);
      this.#writeOperations.writeFileSync(descriptor, payload, 'utf8');
      this.#writeOperations.fsyncSync(descriptor);
      this.#writeOperations.closeSync(descriptor);
      descriptor = undefined;
      this.#writeOperations.renameSync(temporary, this.#file);
      // The atomic rename is the observable commit point. A later directory
      // sync or cleanup failure cannot reverse the visible credential, so it
      // must not falsely report a failed upsert/remove to the caller.
      try {
        this.#writeOperations.fsyncDirectorySync(this.#directory);
      } catch {
        // The committed private replacement remains the truthful outcome.
      }
    } finally {
      if (descriptor !== undefined) {
        try {
          this.#writeOperations.closeSync(descriptor);
        } catch {
          // Preserve a pre-commit primary failure.
        }
      }
      try {
        this.#writeOperations.rmSync(temporary, { force: true });
      } catch {
        // Cleanup cannot invalidate a committed outcome or mask a failure.
      }
    }
  }
}
