/**
 * #3557: personal access tokens, kept apart from the paired-device registry.
 * The registry's strict key check makes any field an older Station does not
 * know unreadable on a rollback, which would lock out every device; a
 * separate file is simply ignored by an older Station (its tokens stop
 * working, nothing else does).
 *
 * Secrets are never stored: each record keeps the sha256 of its secret,
 * compared in constant time. Writes are atomic (temp file, fsync, rename),
 * owner-only, and made under a cross-process lock from a fresh read, so a
 * second Station process on the same home never writes a stale view back
 * (which could resurrect a revoked token). Reads follow the file: a change
 * another process made is seen on the next lookup. Revoked and expired
 * records are dropped on every write.
 */
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { DevicePrincipalBinding } from '@kontourai/station-contracts/environment-security';
import { acquireFileMutationLockAsync } from '@kontourai/station-shared/lifecycle-events';

export const PERSONAL_TOKENS_FILE = 'personal-tokens.json';
const RECORD_VERSION = 1;
const PRIVATE_FILE_MODE = 0o600;

export interface StoredPersonalToken {
  id: string;
  name: string;
  ownerPrincipalId: string;
  binding: DevicePrincipalBinding;
  scope: string;
  credentialHash: string;
  createdAt: number;
  expiresAt: number | null;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

interface StoredTokens {
  version: typeof RECORD_VERSION;
  tokens: StoredPersonalToken[];
}

const SECRET_PATTERN = /^stp_[A-Za-z0-9_-]{43}$/;

/**
 * #3586: whether `candidate` has the shape of a personal access token
 * secret (`stp_` and 32 random bytes, base64url). A paired device's own
 * credential is 32 random bytes with no prefix, so the two never collide.
 * The shape proves nothing; only {@link PersonalTokenStore.find} does.
 */
export function isPersonalTokenSecret(candidate: string): boolean {
  return SECRET_PATTERN.test(candidate);
}

function digest(secret: string): Buffer {
  return createHash('sha256').update(secret).digest();
}

function isRecord(value: unknown): value is StoredPersonalToken {
  if (!value || typeof value !== 'object') return false;
  const token = value as Record<string, unknown>;
  const binding = token.binding as Record<string, unknown> | undefined;
  return (
    typeof token.id === 'string' &&
    typeof token.name === 'string' &&
    typeof token.ownerPrincipalId === 'string' &&
    typeof token.scope === 'string' &&
    typeof token.credentialHash === 'string' &&
    typeof token.createdAt === 'number' &&
    (token.expiresAt === null || typeof token.expiresAt === 'number') &&
    (token.lastUsedAt === null || typeof token.lastUsedAt === 'number') &&
    (token.revokedAt === null || typeof token.revokedAt === 'number') &&
    !!binding &&
    typeof binding === 'object' &&
    typeof binding.subject === 'string'
  );
}

export class PersonalTokenUnavailableError extends Error {
  constructor() {
    super('The personal token record is unsafe or unreadable.');
    this.name = 'PersonalTokenUnavailableError';
  }
}

interface LoadedTokens {
  /** False when the file is unsafe or unreadable: nothing authenticates. */
  usable: boolean;
  tokens: StoredPersonalToken[];
}

export class PersonalTokenStore {
  readonly #path: string;
  readonly #now: () => number;
  #cache: { key: string; loaded: LoadedTokens } | undefined;

  constructor(options: { securityDir: string; now?: () => number }) {
    this.#path = join(options.securityDir, PERSONAL_TOKENS_FILE);
    this.#now = options.now ?? Date.now;
  }

  /** The active token whose secret is `candidate`, compared in constant time. */
  find(candidate: string): StoredPersonalToken | undefined {
    const candidateHash = digest(candidate);
    let match: StoredPersonalToken | undefined;
    for (const token of this.#active(this.#current().tokens)) {
      const stored = Buffer.from(token.credentialHash, 'base64url');
      if (
        stored.length === candidateHash.length &&
        timingSafeEqual(candidateHash, stored)
      )
        match = token;
    }
    return match;
  }

  /** Every active token (not revoked, not expired). */
  list(): StoredPersonalToken[] {
    return this.#active(this.#current().tokens).map((token) =>
      structuredClone(token),
    );
  }

  /** Whether the file can be trusted (a mint or revoke would be refused). */
  usable(): boolean {
    return this.#current().usable;
  }

  /**
   * Records a new token and returns its secret, the only time it exists;
   * `undefined` when its owner already holds `maxPerOwner` active tokens
   * (decided under the lock, so two processes cannot both pass it).
   */
  async mint(
    input: {
      name: string;
      ownerPrincipalId: string;
      binding: DevicePrincipalBinding;
      scope: string;
      expiresAt: number | null;
    },
    maxPerOwner: number,
  ): Promise<{ token: StoredPersonalToken; secret: string } | undefined> {
    const secret = `stp_${randomBytes(32).toString('base64url')}`;
    const token: StoredPersonalToken = {
      id: randomUUID(),
      name: input.name,
      ownerPrincipalId: input.ownerPrincipalId,
      binding: structuredClone(input.binding),
      scope: input.scope,
      credentialHash: digest(secret).toString('base64url'),
      createdAt: this.#now(),
      expiresAt: input.expiresAt,
      lastUsedAt: null,
      revokedAt: null,
    };
    let full = false;
    await this.#mutate((tokens) => {
      full =
        this.#active(tokens).filter(
          (held) => held.ownerPrincipalId === input.ownerPrincipalId,
        ).length >= maxPerOwner;
      return full ? tokens : [...tokens, token];
    });
    return full ? undefined : { token: structuredClone(token), secret };
  }

  /** Revokes one token; `false` when it is unknown or no longer active. */
  async revoke(id: string): Promise<boolean> {
    let found = false;
    await this.#mutate((tokens) =>
      tokens.filter((token) => {
        if (token.id !== id) return true;
        found = true;
        return false;
      }),
    );
    return found;
  }

  /**
   * Revokes every token (an environment reset), including whatever an
   * untrusted file held: a reset discards it rather than refusing.
   */
  async clear(): Promise<void> {
    const release = await acquireFileMutationLockAsync(
      `${this.#path}.mutation`,
    );
    try {
      if (existsSync(this.#path)) this.#write([]);
    } finally {
      await release();
      this.#cache = undefined;
    }
  }

  /**
   * Bookkeeping on use; touches only that token's record. Never awaited on
   * the request path: a contended lock must not hold up authentication.
   */
  async touch(id: string, at: number): Promise<void> {
    await this.#mutate((tokens) =>
      tokens.map((token) =>
        token.id === id ? { ...token, lastUsedAt: at } : token,
      ),
    );
  }

  #active(tokens: readonly StoredPersonalToken[]): StoredPersonalToken[] {
    const now = this.#now();
    return tokens.filter(
      (token) =>
        token.revokedAt === null &&
        (token.expiresAt === null || token.expiresAt > now),
    );
  }

  /** The file as it is now, re-read whenever it changed. */
  #current(): LoadedTokens {
    let key: string;
    try {
      const status = statSync(this.#path);
      key = `${status.ino}:${status.size}:${status.mtimeMs}:${status.ctimeMs}`;
    } catch {
      return { usable: !existsSync(this.#path), tokens: [] };
    }
    if (this.#cache?.key === key) return this.#cache.loaded;
    const loaded = this.#load();
    this.#cache = { key, loaded };
    return loaded;
  }

  #load(): LoadedTokens {
    if (!existsSync(this.#path)) return { usable: true, tokens: [] };
    try {
      const status = lstatSync(this.#path);
      if (
        !status.isFile() ||
        status.isSymbolicLink() ||
        (process.platform !== 'win32' &&
          (status.mode & 0o777) !== PRIVATE_FILE_MODE)
      )
        // Fail closed: an unsafe file authenticates nobody.
        return { usable: false, tokens: [] };
      const parsed = JSON.parse(readFileSync(this.#path, 'utf8')) as {
        version?: unknown;
        tokens?: unknown;
      };
      if (parsed.version !== RECORD_VERSION || !Array.isArray(parsed.tokens))
        return { usable: false, tokens: [] };
      return { usable: true, tokens: parsed.tokens.filter(isRecord) };
    } catch {
      return { usable: false, tokens: [] };
    }
  }

  /**
   * Applies `update` to a fresh read under the cross-process lock. Refuses
   * to write over a file it cannot trust, which would discard its records.
   */
  async #mutate(
    update: (tokens: StoredPersonalToken[]) => StoredPersonalToken[],
  ): Promise<void> {
    const release = await acquireFileMutationLockAsync(
      `${this.#path}.mutation`,
    );
    try {
      const loaded = this.#load();
      if (!loaded.usable) throw new PersonalTokenUnavailableError();
      this.#write(this.#active(update(loaded.tokens)));
    } finally {
      await release();
      this.#cache = undefined;
    }
  }

  #write(tokens: StoredPersonalToken[]): void {
    const record: StoredTokens = { version: RECORD_VERSION, tokens };
    const candidate = `${this.#path}.${randomUUID()}.tmp`;
    let descriptor: number | undefined;
    try {
      descriptor = openSync(candidate, 'wx', PRIVATE_FILE_MODE);
      writeFileSync(descriptor, JSON.stringify(record), { encoding: 'utf8' });
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(candidate, this.#path);
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      rmSync(candidate, { force: true });
    }
  }
}
