import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import type { Stats } from 'node:fs';
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { hostname as resolveHostname } from 'node:os';
import { dirname, join } from 'node:path';
import {
  buildStationProofMessage,
  DEFAULT_GRANT_PAIRING_SCOPE,
  DEVICE_PAIRING_PROTOCOL_VERSION,
  ENVIRONMENT_SECURITY_SCHEMA_VERSION,
  type EnvironmentSecurityRecord,
  type PairedDevice,
  PUBLIC_HANDSHAKE_SCHEMA_VERSION,
  type PublicStationHandshake,
  type PublicStationProofResponse,
  REMOTE_AUTH_PROTOCOL_VERSION,
  STATION_COMPAT_MIN_CLIENT_PROTOCOL,
  STATION_COMPAT_PROTOCOL_VERSION,
  STATION_PROOF_PROTOCOL_VERSION,
  type StationCompatibility,
} from '@kontourai/station-contracts';
import { admitStationRuntimeHome } from '@kontourai/station-shared/runtime-path-resolver';
import {
  readStationHomeSchemaVersion,
  STATION_HOME_SCHEMA_VERSION,
} from '@kontourai/station-shared/station-home-schema';
import packageJson from '../../../package.json' with { type: 'json' };
import { STATION_CAPABILITY_FLAGS } from '../../capabilities/station-capability-flags.js';
import { DevicePairingService } from './device-pairing-service.js';

const SECURITY_DIRECTORY = 'security';
const RECORD_FILE = 'environment.json';
const LOCK_FILE = '.environment.lock';
const REVISION_EVIDENCE_KEY_PREFIX = 'revision-evidence-';
const LOCK_RETRY_MS = 10;
const LOCK_TIMEOUT_MS = 5_000;
const STALE_LOCK_AGE_MS = 2_000;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * What this host advertises about the client/server contract it speaks.
 *
 * `serverVersion` is read from the real package manifest rather than being
 * restated here, so a release can never ship a handshake that disagrees with
 * the build it came from. The version numbers next to it are contract
 * versions, not release versions — see `STATION_COMPAT_PROTOCOL_VERSION`.
 *
 * `capabilities` reuses the sub-protocol constants that already existed
 * (remote auth, device pairing, environment proof) instead of inventing a
 * parallel set: a client that only cares whether pairing changed can read one
 * entry without waiting on a whole-contract bump.
 */
const STATION_COMPATIBILITY: StationCompatibility = {
  serverVersion: packageJson.version,
  protocolVersion: STATION_COMPAT_PROTOCOL_VERSION,
  minClientProtocol: STATION_COMPAT_MIN_CLIENT_PROTOCOL,
  capabilities: {
    remoteAuth: REMOTE_AUTH_PROTOCOL_VERSION,
    devicePairing: DEVICE_PAIRING_PROTOCOL_VERSION,
    environmentProof: STATION_PROOF_PROTOCOL_VERSION,
  },
};

export interface EnvironmentSecurityServiceOptions {
  homeDir: string;
  /** Endpoint inputs are intentionally ignored: identity is endpoint-neutral. */
  hostname?: string;
  port?: number;
  /** Test seams for bounded lock behavior; production callers should omit. */
  lockRetryMs?: number;
  lockTimeoutMs?: number;
  staleLockAgeMs?: number;
  now?: () => number;
  isProcessAlive?: (pid: number) => boolean;
  hostIdentity?: string;
}

interface EnvironmentSecurityLockRecord {
  pid: number;
  nonce: string;
  createdAt: number;
  host: string;
}

export class EnvironmentSecurityRecordError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'EnvironmentSecurityRecordError';
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

function validateRecord(value: unknown): EnvironmentSecurityRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new EnvironmentSecurityRecordError(
      'Invalid environment security record: expected an object',
    );
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== 3 ||
    keys[0] !== 'credential' ||
    keys[1] !== 'environmentId' ||
    keys[2] !== 'schemaVersion'
  ) {
    throw new EnvironmentSecurityRecordError(
      'Invalid environment security record schema',
    );
  }
  if (record.schemaVersion !== ENVIRONMENT_SECURITY_SCHEMA_VERSION) {
    throw new EnvironmentSecurityRecordError(
      'Unsupported environment security record version',
    );
  }
  if (
    typeof record.environmentId !== 'string' ||
    !UUID_PATTERN.test(record.environmentId)
  ) {
    throw new EnvironmentSecurityRecordError(
      'Invalid environment security record environment id',
    );
  }
  if (
    typeof record.credential !== 'string' ||
    !BASE64URL_PATTERN.test(record.credential) ||
    Buffer.from(record.credential, 'base64url').byteLength !== 32
  ) {
    throw new EnvironmentSecurityRecordError(
      'Invalid environment security record credential',
    );
  }
  return {
    schemaVersion: ENVIRONMENT_SECURITY_SCHEMA_VERSION,
    environmentId: record.environmentId,
    credential: record.credential,
  };
}

function createRecord(
  environmentId: string = randomUUID(),
): EnvironmentSecurityRecord {
  return {
    schemaVersion: ENVIRONMENT_SECURITY_SCHEMA_VERSION,
    environmentId,
    credential: randomBytes(32).toString('base64url'),
  };
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but is owned by another user.
    return !isNodeError(error, 'ESRCH');
  }
}

function parseLockRecord(value: unknown): EnvironmentSecurityLockRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new EnvironmentSecurityRecordError(
      'Invalid environment security lock record',
    );
  }
  const lock = value as Record<string, unknown>;
  if (
    Object.keys(lock).sort().join(',') !== 'createdAt,host,nonce,pid' ||
    !Number.isSafeInteger(lock.pid) ||
    (lock.pid as number) <= 0 ||
    typeof lock.nonce !== 'string' ||
    !UUID_PATTERN.test(lock.nonce) ||
    typeof lock.createdAt !== 'number' ||
    !Number.isFinite(lock.createdAt) ||
    typeof lock.host !== 'string' ||
    lock.host.length === 0
  ) {
    throw new EnvironmentSecurityRecordError(
      'Invalid environment security lock record',
    );
  }
  return lock as unknown as EnvironmentSecurityLockRecord;
}

/**
 * The exact `/api/pairing` leaves a promoted device may act on
 * (archive#1887): read the pending-request list, and confirm or deny ONE
 * pending request.
 *
 * Matched positively and exactly — no prefix, no wildcard. `/api/pairing` is
 * where the authority to mint further authority lives, so a route added under
 * it later must be denied to promoted devices by default and admitted only by
 * someone editing this list on purpose. The id segment is bounded to the
 * shapes the routes actually accept so a traversal-ish path cannot widen the
 * match.
 */
const PAIRING_APPROVAL_LEAVES: readonly {
  method: string;
  pattern: RegExp;
}[] = [
  { method: 'GET', pattern: /^\/api\/pairing\/requests$/ },
  {
    method: 'POST',
    pattern: /^\/api\/pairing\/requests\/[A-Za-z0-9._~-]{1,128}\/confirm$/,
  },
  {
    method: 'DELETE',
    pattern: /^\/api\/pairing\/requests\/[A-Za-z0-9._~-]{1,128}$/,
  },
];

function isPairingApprovalLeaf(request: {
  method: string;
  path: string;
}): boolean {
  const method = request.method.toUpperCase();
  // Compare against the path only; a query string must never participate in
  // an authorization match.
  const path = request.path.split('?')[0] ?? request.path;
  return PAIRING_APPROVAL_LEAVES.some(
    (leaf) => leaf.method === method && leaf.pattern.test(path),
  );
}

/**
 * Owns Station's stable environment identity and remote bearer credential.
 * The private record never belongs in an HTTP response; use getPublicHandshake
 * for remote discovery and verifyCredential at the authorization boundary.
 */
export class EnvironmentSecurityService {
  readonly #homeDir: string;
  readonly #securityDir: string;
  readonly #recordPath: string;
  readonly #lockPath: string;
  readonly #lockRetryMs: number;
  readonly #lockTimeoutMs: number;
  readonly #staleLockAgeMs: number;
  readonly #now: () => number;
  readonly #isProcessAlive: (pid: number) => boolean;
  readonly #hostIdentity: string;
  #devicePairingService?: DevicePairingService;

  constructor(options: EnvironmentSecurityServiceOptions) {
    this.#homeDir = options.homeDir;
    this.#securityDir = join(this.#homeDir, SECURITY_DIRECTORY);
    this.#recordPath = join(this.#securityDir, RECORD_FILE);
    this.#lockPath = join(this.#securityDir, LOCK_FILE);
    this.#lockRetryMs = options.lockRetryMs ?? LOCK_RETRY_MS;
    this.#lockTimeoutMs = options.lockTimeoutMs ?? LOCK_TIMEOUT_MS;
    this.#staleLockAgeMs = options.staleLockAgeMs ?? STALE_LOCK_AGE_MS;
    this.#now = options.now ?? Date.now;
    this.#isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
    this.#hostIdentity = options.hostIdentity ?? resolveHostname();
  }

  async initialize(): Promise<EnvironmentSecurityRecord> {
    await this.#ensureSecurityDirectory();
    const record = await this.#withExclusiveLock(async () => {
      const recordExists = existsSync(this.#recordPath);
      const current = recordExists ? this.#readRecord() : createRecord();
      if (!recordExists) {
        this.#writeRecordAtomically(current);
      }
      this.#ensureRevisionEvidenceKey(current.environmentId);
      return current;
    });
    this.#devicePairingService ??= new DevicePairingService({
      homeDir: this.#homeDir,
      environmentId: record.environmentId,
      now: this.#now,
    });
    return record;
  }

  /**
   * Reads an already-provisioned environment record without changing the
   * selected Station home. This is deliberately separate from initialize():
   * profile-selected CLI reads must never bootstrap a missing or malformed
   * home merely because they need its operator credential.
   */
  async readExistingRecord(): Promise<EnvironmentSecurityRecord> {
    const homeDir = admitStationRuntimeHome(this.#homeDir);
    // This is the exact, read-only schema observation used by backup/export
    // admission. It refuses missing, malformed, or incompatible homes without
    // acquiring the bootstrap lock or writing a schema marker.
    const schemaVersion = readStationHomeSchemaVersion(homeDir);
    if (schemaVersion !== STATION_HOME_SCHEMA_VERSION) {
      throw new EnvironmentSecurityRecordError(
        `Unsupported Station home schema version ${schemaVersion}; expected ${STATION_HOME_SCHEMA_VERSION}`,
      );
    }
    const securityDir = join(homeDir, SECURITY_DIRECTORY);
    this.#assertExistingSecurityDirectory(securityDir);
    return this.#readRecord(join(securityDir, RECORD_FILE));
  }

  async rotateCredential(): Promise<EnvironmentSecurityRecord> {
    await this.#ensureSecurityDirectory();
    return this.#withExclusiveLock(async () => {
      const current = this.#readRecord();
      const rotated = createRecord(current.environmentId);
      this.#writeRecordAtomically(rotated);
      return rotated;
    });
  }

  async resetEnvironment(): Promise<EnvironmentSecurityRecord> {
    await this.#ensureSecurityDirectory();
    return this.#withExclusiveLock(async () => {
      // A reset is explicit, but still refuses to overwrite corrupt state.
      const current = this.#readRecord();
      this.#devicePairingService ??= new DevicePairingService({
        homeDir: this.#homeDir,
        environmentId: current.environmentId,
        now: this.#now,
      });
      const reset = createRecord();
      const resetKeyPath = this.#revisionEvidenceKeyPath(reset.environmentId);
      this.#ensureRevisionEvidenceKey(reset.environmentId);
      try {
        // Publish the new identity only after its authority key is durable.
        // A restart can therefore never observe a reset environment without
        // the key needed to validate its revision evidence.
        this.#writeRecordAtomically(reset);
      } catch (error) {
        rmSync(resetKeyPath, { force: true });
        this.#fsyncSecurityDirectory();
        throw error;
      }
      rmSync(this.#revisionEvidenceKeyPath(current.environmentId), {
        force: true,
      });
      this.#fsyncSecurityDirectory();
      this.#devicePairingService.resetEnvironment(reset.environmentId);
      return reset;
    });
  }

  verifyCredential(candidate: string): boolean {
    return (
      this.verifyOperatorCredential(candidate) ||
      (this.#devicePairingService?.verifyCredential(candidate) ?? false)
    );
  }

  /**
   * Resolves a credential to the paired device it belongs to. Deliberately
   * distinct from {@link verifyCredential}: the operator credential is never
   * a device, so an operator-only caller (loopback, or the master bearer
   * token) resolves to null here even though verifyCredential accepts it.
   * Web Push subscription routes require this — not verifyCredential — to
   * enforce that only a paired device can subscribe.
   */
  identifyDevice(candidate: string): PairedDevice | null {
    return this.#devicePairingService?.identifyDevice(candidate) ?? null;
  }

  /**
   * Mint-time home-possession stamp for a paired-device credential.
   * Operator credentials never carry it.
   */
  credentialLocality(candidate: string): 'home-possession' | undefined {
    return this.#devicePairingService?.credentialLocality(candidate);
  }

  /** Pass-through to the pairing store's mint-kind lookup (archive#3677 PR 3). */
  credentialMintKind(
    candidate: string,
  ): 'local-grant' | 'ui-bootstrap' | undefined {
    return this.#devicePairingService?.credentialMintKind(candidate);
  }

  /**
   * The space-delimited {@link PairingScope} string granted to a credential
   * (archive#1098), or `undefined` when the credential is invalid/revoked.
   * The operator bootstrap credential — which predates scoping — resolves to
   * {@link DEFAULT_GRANT_PAIRING_SCOPE}, the frozen historical four-token
   * string; a paired device resolves to whatever scope its grant was created
   * with. Note since archive#1398 that the default grant is no longer
   * the whole vocabulary: the bootstrap credential deliberately does NOT
   * carry `inference:invoke`, because widening it on a build upgrade would
   * grant fleet invocation to a credential nobody re-consented for. Reaching
   * `/api/inference/**` requires a grant minted with the `inference` preset,
   * even for the operator (`docs/design/inference-fleet.md` §11 slice 2).
   * This is the single source `runtime-http.ts`'s scope-enforcement
   * middleware and the terminal/voice WebSocket auth wiring both call
   * through — see `src-server/security/pairing-route-scopes.ts`.
   */
  resolveGrantedScope(candidate: string): string | undefined {
    if (this.verifyOperatorCredential(candidate))
      return DEFAULT_GRANT_PAIRING_SCOPE;
    return this.#devicePairingService?.identifyDevice(candidate)?.scope;
  }

  verifyOperatorCredential(candidate: string): boolean {
    let stored: string;
    try {
      stored = this.#readRecord().credential;
    } catch {
      return false;
    }
    // Hashing both values makes timingSafeEqual length-independent and avoids
    // exposing credential length through an early-return comparison.
    const candidateDigest = createHash('sha256').update(candidate).digest();
    const storedDigest = createHash('sha256').update(stored).digest();
    return timingSafeEqual(candidateDigest, storedDigest);
  }

  /**
   * Returns a stable, keyed pseudonym for public-pairing audit evidence. The
   * Station credential is already a durable owner-only secret, so this does
   * not add another private-key lifecycle. Corrupt or unavailable security
   * state deliberately propagates instead of weakening audit correlation.
   */
  pseudonymizePairingAuditSource(source: string): string {
    const { credential } = this.#readRecord();
    return createHmac('sha256', Buffer.from(credential, 'base64url'))
      .update('station.pairing.audit.source.v1\0')
      .update(source)
      .digest('base64url');
  }

  /**
   * Domain-separated authority receipt for immutable revision evidence.
   * This deliberately does not reuse the public pairing-audit pseudonym API:
   * the two domains have different disclosure and verification contracts.
   */
  signRevisionEvidenceAuthorityBinding(canonicalBinding: string): string {
    const { environmentId } = this.#readRecord();
    const signature = createHmac(
      'sha256',
      this.#readRevisionEvidenceKey(environmentId),
    )
      .update('station.revision-evidence.authority.v1\0')
      .update(canonicalBinding)
      .digest('base64url');
    if (this.#readRecord().environmentId !== environmentId) {
      throw new EnvironmentSecurityRecordError(
        'Environment identity changed while signing revision evidence',
      );
    }
    return signature;
  }

  #revisionEvidenceKeyPath(environmentId: string): string {
    return join(
      this.#securityDir,
      `${REVISION_EVIDENCE_KEY_PREFIX}${environmentId}.key`,
    );
  }

  #ensureRevisionEvidenceKey(environmentId: string): Buffer {
    const path = this.#revisionEvidenceKeyPath(environmentId);
    if (existsSync(path)) return this.#readRevisionEvidenceKey(environmentId);
    const key = randomBytes(32);
    const candidate = `${path}.candidate.${randomUUID()}`;
    let descriptor: number | undefined;
    try {
      descriptor = openSync(
        candidate,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        PRIVATE_FILE_MODE,
      );
      if (process.platform !== 'win32') {
        fchmodSync(descriptor, PRIVATE_FILE_MODE);
      }
      writeFileSync(descriptor, key.toString('base64url'), {
        encoding: 'utf8',
      });
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      linkSync(candidate, path);
    } catch (error) {
      if (!isNodeError(error, 'EEXIST')) throw error;
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      rmSync(candidate, { force: true });
    }
    this.#fsyncSecurityDirectory();
    return this.#readRevisionEvidenceKey(environmentId);
  }

  #readRevisionEvidenceKey(environmentId: string): Buffer {
    const path = this.#revisionEvidenceKeyPath(environmentId);
    const status = lstatSync(path);
    if (
      !status.isFile() ||
      status.isSymbolicLink() ||
      (process.platform !== 'win32' && (status.mode & 0o777) !== 0o600)
    )
      throw new EnvironmentSecurityRecordError(
        'Unsafe revision evidence authority key',
      );
    const encoded = readFileSync(path, 'utf8');
    if (!BASE64URL_PATTERN.test(encoded))
      throw new EnvironmentSecurityRecordError(
        'Invalid revision evidence authority key',
      );
    const key = Buffer.from(encoded, 'base64url');
    if (key.length !== 32 || key.toString('base64url') !== encoded)
      throw new EnvironmentSecurityRecordError(
        'Invalid revision evidence authority key',
      );
    return key;
  }

  #fsyncSecurityDirectory(): void {
    if (process.platform === 'win32') return;
    const descriptor = openSync(this.#securityDir, constants.O_RDONLY);
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  }

  authorizeCredential(
    candidate: string,
    request: {
      method: string;
      path: string;
      activity?: {
        lastSeenFrom?: Exclude<PairedDevice['lastSeenFrom'], null>;
      };
    },
  ): boolean {
    if (this.verifyOperatorCredential(candidate)) return true;
    if (request.path.startsWith('/api/pairing')) {
      // archive#1887: the family stays operator-only, with ONE narrow
      // exception. A device the operator explicitly promoted (scope carries
      // `access:approve`) may act on PENDING REQUESTS — list, confirm, deny —
      // and nothing else here: not creating offers, not revoking devices, not
      // reading the device inventory.
      //
      // The exception is expressed as an allow-list of exact leaves rather
      // than a prefix, because `/api/pairing` is where the authority to mint
      // further authority lives; a prefix match would silently absorb every
      // route added under it later. `access:manage` is deliberately NOT
      // honoured here — it is inherited through the default grant by migrated,
      // scope-omitting, and continuity-flow credentials that never chose it,
      // so honouring it would elevate all of them at once.
      if (!isPairingApprovalLeaf(request)) return false;
      const approved =
        this.#devicePairingService?.credentialMayApprovePairing(candidate) ??
        false;
      return approved && request.activity
        ? (this.#devicePairingService?.recordCredentialActivity(
            candidate,
            request.activity.lastSeenFrom,
          ) ?? false)
        : approved;
    }
    return request.activity
      ? (this.#devicePairingService?.recordCredentialActivity(
          candidate,
          request.activity.lastSeenFrom,
        ) ?? false)
      : (this.#devicePairingService?.verifyCredential(candidate) ?? false);
  }

  get devicePairing(): DevicePairingService {
    if (!this.#devicePairingService) {
      throw new EnvironmentSecurityRecordError(
        'Environment security service is not initialized',
      );
    }
    return this.#devicePairingService;
  }

  async getPublicHandshake(): Promise<PublicStationHandshake> {
    const { environmentId } = await this.initialize();
    return {
      schemaVersion: PUBLIC_HANDSHAKE_SCHEMA_VERSION,
      environmentId,
      authentication: {
        scheme: 'bearer',
        protocolVersion: REMOTE_AUTH_PROTOCOL_VERSION,
      },
      transports: {
        http: REMOTE_AUTH_PROTOCOL_VERSION,
        sse: REMOTE_AUTH_PROTOCOL_VERSION,
        websocket: REMOTE_AUTH_PROTOCOL_VERSION,
      },
      // Additive: every field above is byte-identical to what pre-contract
      // clients already parse, so adding this cannot change their behavior.
      compatibility: { ...STATION_COMPATIBILITY },
      // Additive (archive#1095): same guarantee as `compatibility` above.
      // STATION_CAPABILITY_FLAGS is the single source of truth — add a flag
      // there, not here.
      capabilities: { ...STATION_CAPABILITY_FLAGS },
    };
  }

  async createPublicProof(nonce: string): Promise<PublicStationProofResponse> {
    const { environmentId, credential } = await this.initialize();
    const signature = createHmac('sha256', Buffer.from(credential, 'base64url'))
      .update(buildStationProofMessage(environmentId, nonce))
      .digest('base64url');
    return {
      protocolVersion: STATION_PROOF_PROTOCOL_VERSION,
      environmentId,
      nonce,
      signature,
    };
  }

  async #ensureSecurityDirectory(): Promise<void> {
    await mkdir(this.#homeDir, {
      recursive: true,
      mode: PRIVATE_DIRECTORY_MODE,
    });
    let created = false;
    try {
      await mkdir(this.#securityDir, { mode: PRIVATE_DIRECTORY_MODE });
      created = true;
    } catch (error) {
      if (!isNodeError(error, 'EEXIST')) throw error;
    }
    this.#assertExistingSecurityDirectory(this.#securityDir, !created);
    if (created && process.platform !== 'win32') {
      const descriptor = openSync(this.#securityDir, constants.O_RDONLY);
      try {
        fchmodSync(descriptor, PRIVATE_DIRECTORY_MODE);
      } finally {
        closeSync(descriptor);
      }
    }
  }

  /** Validates an existing security directory without creating or repairing it. */
  #assertExistingSecurityDirectory(
    securityDir = this.#securityDir,
    enforcePrivateMode = true,
  ): Stats {
    let status: Stats;
    try {
      status = lstatSync(securityDir);
    } catch (error) {
      throw new EnvironmentSecurityRecordError(
        'Environment security directory is missing',
        { cause: error },
      );
    }
    if (!status.isDirectory() || status.isSymbolicLink()) {
      throw new EnvironmentSecurityRecordError(
        'Invalid environment security directory',
      );
    }
    if (
      enforcePrivateMode &&
      process.platform !== 'win32' &&
      (status.mode & 0o777) !== PRIVATE_DIRECTORY_MODE
    ) {
      throw new EnvironmentSecurityRecordError(
        'Unsafe environment security directory permissions',
      );
    }
    return status;
  }

  async #withExclusiveLock<T>(operation: () => Promise<T>): Promise<T> {
    const deadline = this.#now() + this.#lockTimeoutMs;
    const nonce = randomUUID();
    const lock: EnvironmentSecurityLockRecord = {
      pid: process.pid,
      nonce,
      createdAt: this.#now(),
      host: this.#hostIdentity,
    };
    const candidatePath = join(
      this.#securityDir,
      `${LOCK_FILE}.candidate.${nonce}`,
    );
    const candidate = openSync(
      candidatePath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      PRIVATE_FILE_MODE,
    );
    try {
      writeFileSync(candidate, `${JSON.stringify(lock)}\n`, {
        encoding: 'utf8',
      });
      fsyncSync(candidate);
    } catch (error) {
      rmSync(candidatePath, { force: true });
      throw error;
    } finally {
      closeSync(candidate);
    }
    let acquired = false;
    while (!acquired) {
      try {
        // A hard link makes the already-complete candidate visible at the
        // canonical lock path without replacing an existing owner.
        linkSync(candidatePath, this.#lockPath);
        rmSync(candidatePath);
        acquired = true;
      } catch (error) {
        if (!isNodeError(error, 'EEXIST')) {
          rmSync(candidatePath, { force: true });
          throw error;
        }
        this.#recoverStaleLockIfSafe();
        if (this.#now() >= deadline) {
          rmSync(candidatePath, { force: true });
          throw new EnvironmentSecurityRecordError(
            'Timed out acquiring environment security record lock',
            { cause: error },
          );
        }
        await sleep(this.#lockRetryMs);
      }
    }
    let result: T | undefined;
    let operationError: unknown;
    try {
      result = await operation();
    } catch (error) {
      operationError = error;
    }
    const current = this.#readLockRecord();
    if (current.record.nonce !== nonce) {
      throw new EnvironmentSecurityRecordError(
        'Environment security lock ownership changed unexpectedly',
      );
    }
    await rm(this.#lockPath);
    if (operationError) throw operationError;
    return result as T;
  }

  #readLockRecord(): { record: EnvironmentSecurityLockRecord; status: Stats } {
    this.#normalizeInterruptedLockPublication();
    const status = lstatSync(this.#lockPath);
    if (!status.isFile() || status.isSymbolicLink() || status.nlink !== 1) {
      throw new EnvironmentSecurityRecordError(
        'Unsafe environment security lock type',
      );
    }
    if (process.platform !== 'win32' && (status.mode & 0o077) !== 0) {
      throw new EnvironmentSecurityRecordError(
        'Unsafe environment security lock permissions',
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.#lockPath, 'utf8'));
    } catch (error) {
      throw new EnvironmentSecurityRecordError(
        'Invalid environment security lock record',
        { cause: error },
      );
    }
    return { record: parseLockRecord(parsed), status };
  }

  #normalizeInterruptedLockPublication(): void {
    const status = lstatSync(this.#lockPath);
    if (status.nlink !== 2) return;
    const prefix = `${LOCK_FILE}.candidate.`;
    const candidates = readdirSync(this.#securityDir)
      .filter((entry) => entry.startsWith(prefix))
      .map((entry) => join(this.#securityDir, entry))
      .filter((path) => {
        const candidate = lstatSync(path);
        return (
          candidate.isFile() &&
          !candidate.isSymbolicLink() &&
          candidate.dev === status.dev &&
          candidate.ino === status.ino
        );
      });
    if (candidates.length !== 1) {
      throw new EnvironmentSecurityRecordError(
        'Unsafe environment security lock type',
      );
    }
    const candidatePath = candidates[0];
    const candidateNonce = candidatePath.slice(
      candidatePath.lastIndexOf(prefix) + prefix.length,
    );
    const record = parseLockRecord(
      JSON.parse(readFileSync(this.#lockPath, 'utf8')),
    );
    if (record.nonce !== candidateNonce) {
      throw new EnvironmentSecurityRecordError(
        'Unsafe environment security lock publication',
      );
    }
    rmSync(candidatePath);
    const normalized = lstatSync(this.#lockPath);
    if (
      normalized.dev !== status.dev ||
      normalized.ino !== status.ino ||
      normalized.nlink !== 1
    ) {
      throw new EnvironmentSecurityRecordError(
        'Environment security lock changed during publication recovery',
      );
    }
  }

  #recoverStaleLockIfSafe(): void {
    let lock: { record: EnvironmentSecurityLockRecord; status: Stats };
    try {
      lock = this.#readLockRecord();
    } catch (error) {
      // Acquisition publishes only complete records. Unknown or legacy lock
      // shapes cannot prove ownership and therefore remain fail-closed.
      if (isNodeError(error, 'ENOENT')) return;
      throw error;
    }
    const recordAge = this.#now() - lock.record.createdAt;
    const fileAge = this.#now() - lock.status.mtimeMs;
    if (recordAge < this.#staleLockAgeMs || fileAge < this.#staleLockAgeMs) {
      return;
    }
    // Host mismatch and a live PID are both ambiguous (including PID reuse),
    // so they are deliberately never stolen.
    if (
      lock.record.host !== this.#hostIdentity ||
      this.#isProcessAlive(lock.record.pid)
    ) {
      return;
    }
    this.#quarantineStaleLock(lock.status, lock.record.nonce);
  }

  #quarantineStaleLock(status: Stats, expectedNonce: string): void {
    let unchanged: Stats;
    try {
      unchanged = lstatSync(this.#lockPath);
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return;
      throw error;
    }
    if (
      unchanged.dev !== status.dev ||
      unchanged.ino !== status.ino ||
      unchanged.mtimeMs !== status.mtimeMs ||
      unchanged.size !== status.size
    ) {
      return;
    }
    const quarantinePath = join(
      this.#securityDir,
      `.environment.lock.stale.${randomUUID()}`,
    );
    try {
      renameSync(this.#lockPath, quarantinePath);
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return;
      throw error;
    }
    try {
      const quarantined = lstatSync(quarantinePath);
      if (
        quarantined.dev !== status.dev ||
        quarantined.ino !== status.ino ||
        quarantined.size !== status.size
      ) {
        throw new EnvironmentSecurityRecordError(
          'Environment security stale lock changed during recovery',
        );
      }
      const quarantinedRecord = parseLockRecord(
        JSON.parse(readFileSync(quarantinePath, 'utf8')),
      );
      if (quarantinedRecord.nonce !== expectedNonce) {
        throw new EnvironmentSecurityRecordError(
          'Environment security stale lock changed during recovery',
        );
      }
    } finally {
      rmSync(quarantinePath, { force: true });
    }
  }

  #readRecord(recordPath = this.#recordPath): EnvironmentSecurityRecord {
    let status: Stats;
    try {
      status = lstatSync(recordPath);
    } catch (error) {
      throw new EnvironmentSecurityRecordError(
        'Environment security record is missing',
        { cause: error },
      );
    }
    if (!status.isFile() || status.isSymbolicLink() || status.nlink !== 1) {
      throw new EnvironmentSecurityRecordError(
        'Unsafe environment security record type',
      );
    }
    if (process.platform !== 'win32' && (status.mode & 0o777) !== 0o600) {
      throw new EnvironmentSecurityRecordError(
        'Unsafe environment security record permissions',
      );
    }
    try {
      return validateRecord(JSON.parse(readFileSync(recordPath, 'utf8')));
    } catch (error) {
      if (error instanceof EnvironmentSecurityRecordError) throw error;
      throw new EnvironmentSecurityRecordError(
        'Corrupt environment security record',
        { cause: error },
      );
    }
  }

  #writeRecordAtomically(record: EnvironmentSecurityRecord): void {
    const temporaryPath = join(
      dirname(this.#recordPath),
      `.${RECORD_FILE}.${process.pid}.${randomUUID()}.tmp`,
    );
    let descriptor: number | undefined;
    try {
      descriptor = openSync(
        temporaryPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        PRIVATE_FILE_MODE,
      );
      if (process.platform !== 'win32') {
        fchmodSync(descriptor, PRIVATE_FILE_MODE);
      }
      writeFileSync(descriptor, `${JSON.stringify(record)}\n`, 'utf8');
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(temporaryPath, this.#recordPath);
      if (process.platform !== 'win32') {
        const directoryDescriptor = openSync(
          this.#securityDir,
          constants.O_RDONLY,
        );
        try {
          fsyncSync(directoryDescriptor);
        } finally {
          closeSync(directoryDescriptor);
        }
      }
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      rmSync(temporaryPath, { force: true });
    }
  }
}
