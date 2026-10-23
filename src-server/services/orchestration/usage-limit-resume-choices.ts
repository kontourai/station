/**
 * #3157 follow-up: a person's choice, on one usage-limit stop, about the
 * resume Station would send at the provider's reset: "Resume at <reset>"
 * (`resume`) or "Don't resume" (`hold`). It decides that one stop whatever
 * the `usageLimitAutoResume` setting says; without a choice the setting
 * decides, as before.
 *
 * Keyed by the recovery intent's fingerprint, in its own table so the
 * recovery ledger's rows and transitions are untouched: the choice only
 * replaces the setting's answer when the resume comes due
 * (`SessionRecoveryCoordinator.trackClaimAndResume`), and every pre-dispatch
 * check (a newer turn, an open request, an ended Session) still applies.
 * Durable, so a restart before the reset keeps it.
 */
import type { SqliteDatabase } from './sqlite-database.js';

export type UsageLimitResumeChoice = 'resume' | 'hold';

const SCHEMA = `CREATE TABLE IF NOT EXISTS usage_limit_resume_choices (
  fingerprint TEXT PRIMARY KEY,
  choice TEXT NOT NULL,
  updated_at INTEGER NOT NULL
)`;

export interface UsageLimitResumeChoices {
  read(fingerprint: string): UsageLimitResumeChoice | undefined;
  write(fingerprint: string, choice: UsageLimitResumeChoice, now: number): void;
}

export function createSqliteUsageLimitResumeChoices(
  db: SqliteDatabase,
): UsageLimitResumeChoices {
  db.exec(SCHEMA);
  return {
    read(fingerprint) {
      const row = db
        .prepare(
          'SELECT choice FROM usage_limit_resume_choices WHERE fingerprint = ?',
        )
        .get(fingerprint) as { choice?: unknown } | undefined;
      return row?.choice === 'resume' || row?.choice === 'hold'
        ? row.choice
        : undefined;
    },
    write(fingerprint, choice, now) {
      db.prepare(
        `INSERT INTO usage_limit_resume_choices (fingerprint, choice, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(fingerprint) DO UPDATE SET choice = excluded.choice,
           updated_at = excluded.updated_at`,
      ).run(fingerprint, choice, now);
    },
  };
}
