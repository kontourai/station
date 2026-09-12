import type { DatabaseSync } from 'node:sqlite';

export interface LocalAccountView {
  accountId: string;
  name: string;
  email: string;
  emailVerified: boolean;
  disabled: boolean;
}

/** Station-owned account policy; no dependency on an authentication library's administrator roles. */
export class LocalAccountAdministration {
  constructor(private readonly database: DatabaseSync) {
    database.exec(`CREATE TABLE IF NOT EXISTS station_account_policy (
      account_id TEXT PRIMARY KEY NOT NULL,
      disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1)),
      sessions_revoked_at INTEGER NOT NULL
    ) STRICT`);
  }

  list(): LocalAccountView[] {
    // Better Auth's pinned, documented user schema; passwords/tokens live in
    // separate tables and never enter this operator projection.
    const rows = this.database
      .prepare(`SELECT u.id, u.name, u.email, u.emailVerified,
      COALESCE(p.disabled, 0) AS disabled FROM user u
      LEFT JOIN station_account_policy p ON p.account_id = u.id ORDER BY u.id LIMIT 1001`)
      .all();
    if (rows.length > 1000)
      throw new Error(
        'Local account administration requires pagination for this account population.',
      );
    return rows.map((row) => {
      if (
        typeof row.id !== 'string' ||
        typeof row.name !== 'string' ||
        typeof row.email !== 'string' ||
        ![0, 1].includes(Number(row.emailVerified)) ||
        ![0, 1].includes(Number(row.disabled))
      ) {
        throw new Error('Local account projection is unreadable.');
      }
      return {
        accountId: row.id,
        name: row.name,
        email: row.email,
        emailVerified: row.emailVerified === 1,
        disabled: row.disabled === 1,
      };
    });
  }

  setDisabled(accountId: string, disabled: boolean): void {
    const changed = this.database
      .prepare(`INSERT INTO station_account_policy(account_id, disabled, sessions_revoked_at)
      SELECT id, ?, ? FROM user WHERE id = ?
      ON CONFLICT(account_id) DO UPDATE SET disabled = excluded.disabled,
      sessions_revoked_at = MAX(station_account_policy.sessions_revoked_at, excluded.sessions_revoked_at)`)
      .run(disabled ? 1 : 0, Date.now(), accountId);
    if (changed.changes !== 1) throw new Error('Local account not found.');
  }

  revokeSessions(accountId: string): void {
    const changed = this.database
      .prepare(`INSERT INTO station_account_policy(account_id, disabled, sessions_revoked_at)
      SELECT id, 0, ? FROM user WHERE id = ?
      ON CONFLICT(account_id) DO UPDATE SET sessions_revoked_at = MAX(station_account_policy.sessions_revoked_at, excluded.sessions_revoked_at)`)
      .run(Date.now(), accountId);
    if (changed.changes !== 1) throw new Error('Local account not found.');
  }

  permits(accountId: string, sessionCreatedAt?: Date): boolean {
    const row = this.database
      .prepare(
        'SELECT disabled, sessions_revoked_at FROM station_account_policy WHERE account_id = ?',
      )
      .get(accountId);
    if (!row) return true;
    if (row.disabled !== 0 || typeof row.sessions_revoked_at !== 'number')
      return false;
    return (
      sessionCreatedAt === undefined ||
      sessionCreatedAt.getTime() > row.sessions_revoked_at
    );
  }
}
