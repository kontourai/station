/**
 * Station's engine host-auth vault: the credentials Station holds to issue to
 * engines that delegate their sign-in to the host, and the engine-held
 * secrets it keeps for them (docs/decisions/engine-credential-provider.md).
 *
 * One document, `<home>/security/engine-host-auth.json` (0600, its own trust
 * domain in the shared credential store), with two bucket families:
 *
 * - `<kind>:<connectionId>:<profile>` (`engineCredentialBucketKey`): one
 *   signed-in credential, stored as a single JSON value so a refresh replaces
 *   it whole with compare-and-swap.
 * - `engine-secret:<connectionId>:<profile>`: an engine's persisted secrets,
 *   one entry per key.
 *
 * Refreshing a credential takes a cross-process lock per bucket, so two
 * Station processes (or two engines of one) never spend one refresh token
 * twice. This module imports nothing of Station's own principals.
 */
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  ENGINE_CREDENTIAL_DEFAULT_PROFILE,
  type EngineCredentialKind,
  type EngineCredentialScope,
  type EngineHostAuthIdentity,
  engineCredentialBucketKey,
} from '@kontourai/station-contracts/engine-credential-provider';
import { acquireFileMutationLockAsync } from '@kontourai/station-shared/lifecycle-events';
import { ToolServerCredentialStore } from '@kontourai/station-shared/tool-server-credential-store';

/** The single entry a credential bucket holds. */
const CREDENTIAL_ENTRY = 'credential';
const SECRET_FAMILY = 'engine-secret';
/** Long enough for a refresh round trip and its retries; a stuck holder fails the waiter, never blocks it forever. */
const REFRESH_LOCK_TIMEOUT_MS = 45_000;

/**
 * A signed-in credential as the vault keeps it. The refresh token and client
 * secret never leave this module's callers in the engine-host-auth service;
 * an issue hands over only `accessToken` and `expiresAt`.
 */
export interface StoredEngineCredential {
  readonly identity: EngineHostAuthIdentity;
  readonly accessToken: string;
  /** ISO 8601. */
  readonly expiresAt: string;
  readonly refreshToken?: string;
  /** SSO-OIDC client registration the refresh grant needs. */
  readonly clientId?: string;
  readonly clientSecret?: string;
  /** Epoch seconds. */
  readonly clientSecretExpiresAt?: number;
  /** Non-secret attributes the vendor's answer carries beside the token. */
  readonly attributes?: Readonly<Record<string, string>>;
  /** ISO 8601: the issuer refused the refresh grant; a new sign-in is needed. */
  readonly refreshRejectedAt?: string;
  /** ISO 8601. */
  readonly signedInAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const IDENTITY_KINDS: ReadonlySet<string> = new Set([
  'builder-id',
  'identity-center',
  'external-idp',
  'social',
]);

function optionalString(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === 'string' ? value : null;
}

function readIdentity(value: unknown): EngineHostAuthIdentity | undefined {
  if (!isRecord(value) || typeof value.kind !== 'string') return undefined;
  if (!IDENTITY_KINDS.has(value.kind)) return undefined;
  const provider = optionalString(value.provider);
  const startUrl = optionalString(value.startUrl);
  const region = optionalString(value.region);
  if (provider === null || startUrl === null || region === null)
    return undefined;
  return {
    kind: value.kind as EngineHostAuthIdentity['kind'],
    ...(provider !== undefined ? { provider } : {}),
    ...(startUrl !== undefined ? { startUrl } : {}),
    ...(region !== undefined ? { region } : {}),
  };
}

function readAttributes(
  value: unknown,
): Readonly<Record<string, string>> | undefined | null {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return null;
  const entries = Object.entries(value);
  return entries.every(([, entry]) => typeof entry === 'string')
    ? (Object.fromEntries(entries) as Record<string, string>)
    : null;
}

/**
 * Reads a credential Station itself wrote, field by field: a record whose
 * shape no longer matches (an older or hand-edited file) reads as absent.
 */
function readCredential(
  raw: string | undefined,
): StoredEngineCredential | undefined {
  if (raw === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (
    !isRecord(value) ||
    typeof value.accessToken !== 'string' ||
    typeof value.expiresAt !== 'string' ||
    !Number.isFinite(Date.parse(value.expiresAt)) ||
    typeof value.signedInAt !== 'string'
  )
    return undefined;
  const identity = readIdentity(value.identity);
  const refreshToken = optionalString(value.refreshToken);
  const clientId = optionalString(value.clientId);
  const clientSecret = optionalString(value.clientSecret);
  const refreshRejectedAt = optionalString(value.refreshRejectedAt);
  const attributes = readAttributes(value.attributes);
  const clientSecretExpiresAt = value.clientSecretExpiresAt;
  if (
    !identity ||
    refreshToken === null ||
    clientId === null ||
    clientSecret === null ||
    refreshRejectedAt === null ||
    attributes === null ||
    (clientSecretExpiresAt !== undefined &&
      (typeof clientSecretExpiresAt !== 'number' ||
        !Number.isFinite(clientSecretExpiresAt)))
  )
    return undefined;
  return {
    identity,
    accessToken: value.accessToken,
    expiresAt: value.expiresAt,
    signedInAt: value.signedInAt,
    ...(refreshToken !== undefined ? { refreshToken } : {}),
    ...(clientId !== undefined ? { clientId } : {}),
    ...(clientSecret !== undefined ? { clientSecret } : {}),
    ...(typeof clientSecretExpiresAt === 'number'
      ? { clientSecretExpiresAt }
      : {}),
    ...(attributes !== undefined ? { attributes } : {}),
    ...(refreshRejectedAt !== undefined ? { refreshRejectedAt } : {}),
  };
}

/** A read credential and the exact stored text it came from, for compare-and-swap. */
export interface VaultRead {
  readonly credential: StoredEngineCredential;
  readonly revision: string;
}

function engineSecretBucketKey(scope: EngineCredentialScope): string {
  const profile =
    scope.credentialProfileRef || ENGINE_CREDENTIAL_DEFAULT_PROFILE;
  if (!scope.connectionId || scope.connectionId.includes(':'))
    throw new Error('connectionId must be non-empty and contain no ":"');
  if (profile.includes(':'))
    throw new Error('credentialProfileRef must contain no ":"');
  return `${SECRET_FAMILY}:${scope.connectionId}:${profile}`;
}

/** Whether a bucket id belongs to `connectionId`, in either family. */
function bucketBelongsTo(bucketId: string, connectionId: string): boolean {
  const parts = bucketId.split(':');
  return parts.length === 3 && parts[1] === connectionId;
}

export class EngineHostAuthVault {
  readonly #homeDir: string;
  #opened: ToolServerCredentialStore | null = null;

  constructor(homeDir: string) {
    this.#homeDir = homeDir;
  }

  /** Opened on first use, so an unsafe security folder fails a sign-in, never startup. */
  get #store(): ToolServerCredentialStore {
    this.#opened ??= new ToolServerCredentialStore(
      this.#homeDir,
      'engine-host-auth',
    );
    return this.#opened;
  }

  read(
    kind: EngineCredentialKind,
    scope: EngineCredentialScope,
  ): VaultRead | undefined {
    const raw = this.#store.read(
      engineCredentialBucketKey(kind, scope),
      CREDENTIAL_ENTRY,
    );
    const credential = readCredential(raw);
    return credential && raw !== undefined
      ? { credential, revision: raw }
      : undefined;
  }

  /**
   * Write `credential` only if the bucket still holds `expected` (`null`: is
   * still empty). Returns whether it was written.
   */
  async compareAndWrite(
    kind: EngineCredentialKind,
    scope: EngineCredentialScope,
    expected: string | null,
    credential: StoredEngineCredential,
  ): Promise<boolean> {
    const bucket = engineCredentialBucketKey(kind, scope);
    const value = JSON.stringify(credential);
    if (expected === null)
      return this.#store.compareAndUpsertMany(
        bucket,
        { [CREDENTIAL_ENTRY]: value },
        { [CREDENTIAL_ENTRY]: null },
      );
    return this.#store.compareAndSwap(
      bucket,
      CREDENTIAL_ENTRY,
      expected,
      value,
    );
  }

  /** Replace whatever the bucket holds (a completed sign-in). */
  async write(
    kind: EngineCredentialKind,
    scope: EngineCredentialScope,
    credential: StoredEngineCredential,
  ): Promise<void> {
    await this.#store.upsert(
      engineCredentialBucketKey(kind, scope),
      CREDENTIAL_ENTRY,
      JSON.stringify(credential),
    );
  }

  /**
   * Remove the credential only if the bucket still holds `expected` (a
   * revision `read` returned). Returns whether it was removed.
   */
  async compareAndRemove(
    kind: EngineCredentialKind,
    scope: EngineCredentialScope,
    expected: string,
  ): Promise<boolean> {
    return this.#store.compareAndRemove(
      engineCredentialBucketKey(kind, scope),
      CREDENTIAL_ENTRY,
      expected,
    );
  }

  async remove(
    kind: EngineCredentialKind,
    scope: EngineCredentialScope,
  ): Promise<void> {
    await this.#store.removeServer(engineCredentialBucketKey(kind, scope));
  }

  // --- engine-held secrets ---------------------------------------------------

  readSecret(scope: EngineCredentialScope, key: string): string | undefined {
    return this.#store.read(engineSecretBucketKey(scope), key);
  }

  async writeSecret(
    scope: EngineCredentialScope,
    key: string,
    value: string,
  ): Promise<void> {
    await this.#store.upsert(engineSecretBucketKey(scope), key, value);
  }

  /** Remove `key` only if it still holds `expected`. */
  async removeSecretIf(
    scope: EngineCredentialScope,
    key: string,
    expected: string,
  ): Promise<boolean> {
    return this.#store.compareAndRemove(
      engineSecretBucketKey(scope),
      key,
      expected,
    );
  }

  async removeSecret(scope: EngineCredentialScope, key: string): Promise<void> {
    await this.#store.remove(engineSecretBucketKey(scope), key);
  }

  /** Every credential and secret held for a connection that was removed. */
  async removeConnection(connectionId: string): Promise<void> {
    if (!connectionId || connectionId.includes(':')) return;
    await this.#store.removeServers((bucketId) =>
      bucketBelongsTo(bucketId, connectionId),
    );
  }

  /** Bucket ids present (names only), for tests and diagnostics. */
  bucketIds(): string[] {
    return this.#store.bucketIds();
  }

  /**
   * Run `work` holding the cross-process refresh lock for one bucket. The
   * lock file's name is a digest of the bucket, so it names no connection.
   */
  async withRefreshLock<T>(
    kind: EngineCredentialKind,
    scope: EngineCredentialScope,
    work: () => Promise<T>,
  ): Promise<T> {
    const digest = createHash('sha256')
      .update(engineCredentialBucketKey(kind, scope))
      .digest('hex')
      .slice(0, 32);
    const directory = join(this.#homeDir, 'security', 'engine-host-auth-locks');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const release = await acquireFileMutationLockAsync(
      join(directory, `${digest}.refresh`),
      { timeoutMs: REFRESH_LOCK_TIMEOUT_MS },
    );
    try {
      return await work();
    } finally {
      await release();
    }
  }
}
