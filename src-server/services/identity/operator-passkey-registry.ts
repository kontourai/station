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

interface PasskeyRow {
  id: string;
  credential_id: string;
  public_key: Uint8Array;
  counter: number;
  transports: string;
  device_type: string;
  backed_up: number;
  label: string;
  rp_id: string;
  origin: string;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
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
  userHandle(): Uint8Array {
    const existing = this.#db
      .prepare("SELECT value FROM operator_meta WHERE key = 'user_handle'")
      .get() as { value: string } | undefined;
    if (existing) return Buffer.from(existing.value, 'base64url');
    const created = randomBytes(32).toString('base64url');
    this.#db
      .prepare(
        "INSERT OR IGNORE INTO operator_meta (key, value) VALUES ('user_handle', ?)",
      )
      .run(created);
    const stored = this.#db
      .prepare("SELECT value FROM operator_meta WHERE key = 'user_handle'")
      .get() as { value: string };
    return Buffer.from(stored.value, 'base64url');
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
    return (
      this.#db
        .prepare('SELECT * FROM operator_passkeys ORDER BY created_at DESC')
        .all() as unknown as PasskeyRow[]
    ).map((row) => toPasskey(row));
  }

  listActive(): OperatorPasskey[] {
    return this.list().filter((passkey) => passkey.revokedAt === null);
  }

  get(id: string): OperatorPasskey | null {
    const row = this.#db
      .prepare('SELECT * FROM operator_passkeys WHERE id = ?')
      .get(id) as unknown as PasskeyRow | undefined;
    return row ? toPasskey(row) : null;
  }

  /** Credential ids of active passkeys, for `excludeCredentials`. */
  activeCredentialIds(): Array<{ id: string; transports: string[] }> {
    return (
      this.#db
        .prepare(
          'SELECT credential_id, transports FROM operator_passkeys WHERE revoked_at IS NULL',
        )
        .all() as unknown as Array<{
        credential_id: string;
        transports: string;
      }>
    ).map((row) => ({
      id: row.credential_id,
      transports: parseTransports(row.transports),
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

function toPasskey(row: PasskeyRow): OperatorPasskey {
  return {
    id: row.id,
    label: row.label,
    rpId: row.rp_id,
    origin: row.origin,
    transports: parseTransports(row.transports),
    deviceType:
      row.device_type === 'multiDevice' ? 'multiDevice' : 'singleDevice',
    backedUp: row.backed_up === 1,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  };
}
