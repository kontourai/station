/**
 * #3557: personal access tokens, kept apart from the paired-device registry.
 * The registry's strict key check makes any field an older Station does not
 * know unreadable on a rollback, which would lock out every device; a
 * separate file is simply ignored by an older Station (its tokens stop
 * working, nothing else does).
 *
 * Secrets are never stored: each record keeps the sha256 of its secret,
 * compared in constant time. Writes are atomic (temp file, fsync, rename)
 * and owner-only.
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
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { DevicePrincipalBinding } from '@kontourai/station-contracts/environment-security';

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

export class PersonalTokenStore {
  readonly #path: string;
  readonly #now: () => number;
  #tokens: StoredPersonalToken[];

  constructor(options: { securityDir: string; now?: () => number }) {
    this.#path = join(options.securityDir, PERSONAL_TOKENS_FILE);
    this.#now = options.now ?? Date.now;
    this.#tokens = this.#load();
  }

  /** The active token whose secret is `candidate`, compared in constant time. */
  find(candidate: string): StoredPersonalToken | undefined {
    const candidateHash = digest(candidate);
    const now = this.#now();
    let match: StoredPersonalToken | undefined;
    for (const token of this.#tokens) {
      const stored = Buffer.from(token.credentialHash, 'base64url');
      const matches =
        stored.length === candidateHash.length &&
        timingSafeEqual(candidateHash, stored);
      if (
        matches &&
        token.revokedAt === null &&
        (token.expiresAt === null || token.expiresAt > now)
      )
        match = token;
    }
    return match;
  }

  list(): StoredPersonalToken[] {
    return this.#tokens.map((token) => structuredClone(token));
  }

  /** Records a new token and returns its secret, the only time it exists. */
  mint(input: {
    name: string;
    ownerPrincipalId: string;
    binding: DevicePrincipalBinding;
    scope: string;
    expiresAt: number | null;
  }): { token: StoredPersonalToken; secret: string } {
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
    this.#write([...this.#tokens, token]);
    return { token: structuredClone(token), secret };
  }

  /** Revokes one token; `false` when it is unknown or already revoked. */
  revoke(id: string): boolean {
    const target = this.#tokens.find(
      (token) => token.id === id && token.revokedAt === null,
    );
    if (!target) return false;
    this.#write(
      this.#tokens.map((token) =>
        token.id === id ? { ...token, revokedAt: this.#now() } : token,
      ),
    );
    return true;
  }

  /** Bookkeeping on use; a failed write keeps serving (see the caller). */
  touch(id: string, at: number): void {
    this.#write(
      this.#tokens.map((token) =>
        token.id === id ? { ...token, lastUsedAt: at } : token,
      ),
    );
  }

  #load(): StoredPersonalToken[] {
    if (!existsSync(this.#path)) return [];
    const status = lstatSync(this.#path);
    if (
      !status.isFile() ||
      status.isSymbolicLink() ||
      (process.platform !== 'win32' &&
        (status.mode & 0o777) !== PRIVATE_FILE_MODE)
    )
      // Fail closed: an unsafe file authenticates nobody.
      return [];
    try {
      const parsed = JSON.parse(readFileSync(this.#path, 'utf8')) as {
        version?: unknown;
        tokens?: unknown;
      };
      if (parsed.version !== RECORD_VERSION || !Array.isArray(parsed.tokens))
        return [];
      return parsed.tokens.filter(isRecord);
    } catch {
      return [];
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
    this.#tokens = tokens;
  }
}
