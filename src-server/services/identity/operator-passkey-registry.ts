/**
 * The operator passkey registry (#3257, S2b): the WebAuthn credentials the
 * Station operator enrolled on the HTTPS consent origin.
 *
 * Private by construction: a SQLite file under the Station home's
 * `authentication/` directory opened with {@link openPrivateSqlite}
 * (operator-owned directory, 0600 files, no symlinks). Only the PUBLIC key
 * is stored. A passkey's private key never leaves the authenticator, so a
 * read of this file cannot sign in as the operator.
 *
 * An operator may hold several passkeys (D5); a revoked row stays for the
 * audit trail but never matches a lookup or an `excludeCredentials` list.
 */
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openPrivateSqlite } from '../../utils/private-sqlite.js';

export interface OperatorPasskey {
  /** Station-side identifier; what `revoke <id>` takes. Not the credential id. */
  readonly id: string;
  readonly label: string;
  readonly rpId: string;
  readonly origin: string;
  readonly transports: readonly string[];
  readonly deviceType: 'singleDevice' | 'multiDevice';
  readonly backedUp: boolean;
  readonly createdAt: number;
  readonly lastUsedAt: number | null;
  readonly revokedAt: number | null;
}

export interface NewOperatorPasskey {
  readonly credentialId: string;
  readonly publicKey: Uint8Array;
  readonly counter: number;
  readonly transports: readonly string[];
  readonly deviceType: 'singleDevice' | 'multiDevice';
  readonly backedUp: boolean;
  readonly label: string;
  readonly rpId: string;
  readonly origin: string;
}

export const OPERATOR_PASSKEY_DB_RELATIVE_PATH = join(
  'authentication',
  'operator-passkeys.sqlite',
);

export class OperatorPasskeyRegistry {
  readonly #db: DatabaseSync;
  readonly #now: () => number;

  constructor(db: DatabaseSync, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
    db.exec(`
      CREATE TABLE IF NOT EXISTS operator_passkeys (
        id TEXT PRIMARY KEY,
        credential_id TEXT NOT NULL UNIQUE,
        public_key BLOB NOT NULL,
        counter INTEGER NOT NULL,
        transports TEXT NOT NULL,
        device_type TEXT NOT NULL,
        backed_up INTEGER NOT NULL,
        label TEXT NOT NULL,
        rp_id TEXT NOT NULL,
        origin TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER,
        revoked_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS operator_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  static open(home: string, now?: () => number): OperatorPasskeyRegistry {
    const db = openPrivateSqlite(
      join(home, OPERATOR_PASSKEY_DB_RELATIVE_PATH),
      'Operator passkeys',
    );
    try {
      return new OperatorPasskeyRegistry(db, now);
    } catch (error) {
      db.close();
      throw error;
    }
  }

  /**
   * The stable WebAuthn user handle shared by every passkey of this operator.
   * Random, generated once, and carrying no personal data (WebAuthn forbids
   * it). One handle per operator lets an authenticator replace, rather than
   * duplicate, a discoverable credential it already holds for this RP.
   */
  userHandle(): Uint8Array<ArrayBuffer> {
    const existing = this.#db
      .prepare("SELECT value FROM operator_meta WHERE key = 'user_handle'")
      .get() as { value: string } | undefined;
    if (existing)
      return Uint8Array.from(Buffer.from(existing.value, 'base64url'));
    const created = randomBytes(32).toString('base64url');
    this.#db
      .prepare(
        "INSERT OR IGNORE INTO operator_meta (key, value) VALUES ('user_handle', ?)",
      )
      .run(created);
    const stored = this.#db
      .prepare("SELECT value FROM operator_meta WHERE key = 'user_handle'")
      .get() as { value: string };
    return Uint8Array.from(Buffer.from(stored.value, 'base64url'));
  }

  /** @throws when the credential id is already registered. */
  add(input: NewOperatorPasskey): OperatorPasskey {
    const id = randomBytes(9).toString('base64url');
    const createdAt = this.#now();
    this.#db
      .prepare(
        `INSERT INTO operator_passkeys
          (id, credential_id, public_key, counter, transports, device_type,
           backed_up, label, rp_id, origin, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.credentialId,
        input.publicKey,
        input.counter,
        JSON.stringify(input.transports),
        input.deviceType,
        input.backedUp ? 1 : 0,
        input.label,
        input.rpId,
        input.origin,
        createdAt,
      );
    return this.get(id) as OperatorPasskey;
  }

  /** Active and revoked passkeys, newest first, public metadata only. */
  list(): OperatorPasskey[] {
    return this.#db
      .prepare(
        `SELECT ${METADATA_COLUMNS} FROM operator_passkeys ORDER BY created_at DESC`,
      )
      .all()
      .map((row) => toPasskey(row));
  }

  listActive(): OperatorPasskey[] {
    return this.list().filter((passkey) => passkey.revokedAt === null);
  }

  get(id: string): OperatorPasskey | null {
    const row = this.#db
      .prepare(`SELECT ${METADATA_COLUMNS} FROM operator_passkeys WHERE id = ?`)
      .get(id);
    return row ? toPasskey(row) : null;
  }

  /** Credential ids of active passkeys, for `excludeCredentials`. */
  activeCredentialIds(): Array<{ id: string; transports: string[] }> {
    return this.#db
      .prepare(
        'SELECT credential_id, transports FROM operator_passkeys WHERE revoked_at IS NULL',
      )
      .all()
      .map((row) => ({
        id: String(row.credential_id),
        transports: parseTransports(String(row.transports)),
      }));
  }

  /** Marks a passkey revoked. Returns false when unknown or already revoked. */
  revoke(id: string): boolean {
    const result = this.#db
      .prepare(
        'UPDATE operator_passkeys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL',
      )
      .run(this.#now(), id);
    return Number(result.changes) === 1;
  }

  close(): void {
    this.#db.close();
  }
}

function parseTransports(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

/** Every column except the key material and counter, which never leave. */
const METADATA_COLUMNS =
  'id, transports, device_type, backed_up, label, rp_id, origin, created_at, last_used_at, revoked_at';

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function toPasskey(row: Record<string, unknown>): OperatorPasskey {
  return {
    id: String(row.id),
    label: String(row.label),
    rpId: String(row.rp_id),
    origin: String(row.origin),
    transports: parseTransports(String(row.transports)),
    deviceType:
      row.device_type === 'multiDevice' ? 'multiDevice' : 'singleDevice',
    backedUp: Number(row.backed_up) === 1,
    createdAt: Number(row.created_at),
    lastUsedAt: nullableNumber(row.last_used_at),
    revokedAt: nullableNumber(row.revoked_at),
  };
}

/**
 * Opens the registry on demand, so a Station that never enrolls a passkey
 * never creates the database. `existing()` opens only a file that is already
 * there (reads and revokes of enrolled passkeys); `ensure()` creates it and is
 * called only once an enrollment ceremony is actually under way.
 */
export class LazyOperatorPasskeyRegistry {
  #registry: OperatorPasskeyRegistry | null = null;

  constructor(
    private readonly home: string,
    private readonly now?: () => number,
  ) {}

  /** Wraps an already-open registry (tests, and callers that opened it themselves). */
  static of(registry: OperatorPasskeyRegistry): LazyOperatorPasskeyRegistry {
    const lazy = new LazyOperatorPasskeyRegistry('');
    lazy.#registry = registry;
    return lazy;
  }

  existing(): OperatorPasskeyRegistry | null {
    if (this.#registry) return this.#registry;
    if (!existsSync(join(this.home, OPERATOR_PASSKEY_DB_RELATIVE_PATH))) {
      return null;
    }
    return this.ensure();
  }

  ensure(): OperatorPasskeyRegistry {
    this.#registry ??= OperatorPasskeyRegistry.open(this.home, this.now);
    return this.#registry;
  }

  close(): void {
    this.#registry?.close();
    this.#registry = null;
  }
}
