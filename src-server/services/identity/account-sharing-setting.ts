/**
 * The operator's stored choice to run Project sharing with built-in local
 * accounts (#4305), and the boot-time protocol that keeps a bad choice from
 * making the Station unbootable.
 *
 * A change is never adopted in the generation that accepted it. The route
 * stages it (`pending`), asks the process supervisor for a handoff, and the
 * next generation reads it at startup:
 *
 * 1. an unattempted `pending` is first marked `attempted` on disk, then used;
 * 2. once runtime initialization succeeds, `pending` becomes `committed`;
 * 3. a boot that finds an `attempted` `pending` knows a previous boot started
 *    with it and never committed, so it drops it, records why, and boots with
 *    `committed`. The supervisor's rollback relaunch therefore comes back
 *    with the previous setting instead of repeating the failure.
 *
 * Deployment configuration always wins: when any variable in
 * `ACCOUNT_SHARING_DEPLOYMENT_VARIABLES` is set, startup never reads this
 * file. Custom authentication modules are deliberately absent from the
 * stored shape; only process configuration can load deployment code.
 */
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  AccountSharingChoice,
  AccountSharingLastApply,
} from '@kontourai/station-contracts/local-accounts';
import { openRegularFileSync } from '@kontourai/station-shared/regular-file';
import { z } from 'zod/v3';
import { HOSTED_TENANT_REGISTRY_FILE_ENV } from '../../runtime/bootstrap/hosted-tenant-mode.js';
import { assertPrivateDirectory } from '../../utils/private-sqlite.js';

/**
 * Process configuration that owns sharing or authentication. Any of these
 * being set, even to `0`, means the deployment decided, and the stored
 * setting is neither read at startup nor writable from Settings.
 */
export const ACCOUNT_SHARING_DEPLOYMENT_VARIABLES = Object.freeze([
  'STATION_PROJECT_SHARING',
  'STATION_LOCAL_ACCOUNTS',
  'STATION_AUTHENTICATION_MODULE',
  'STATION_AUTHENTICATION_ORIGIN',
  'STATION_AUTHENTICATION_BROWSER_ORIGINS',
  'STATION_LOCAL_ACCOUNT_OIDC_FILE',
  HOSTED_TENANT_REGISTRY_FILE_ENV,
] as const);

export function deploymentAccountSharingVariables(
  environment: Readonly<Record<string, string | undefined>>,
): string[] {
  return ACCOUNT_SHARING_DEPLOYMENT_VARIABLES.filter(
    (name) => environment[name] !== undefined,
  );
}

export function accountSharingSettingPath(homeDirectory: string): string {
  return join(homeDirectory, 'config', 'account-sharing.json');
}

const MAX_RECORD_BYTES = 16 * 1024;
const choiceSchema = z.discriminatedUnion('enabled', [
  z.object({ enabled: z.literal(false) }).strict(),
  z
    .object({ enabled: z.literal(true), publicOrigin: z.string().max(2048) })
    .strict(),
]);
const recordSchema = z
  .object({
    version: z.literal(1),
    committed: choiceSchema,
    pending: z
      .object({
        choice: choiceSchema,
        stagedAt: z.string().max(64),
        attempted: z.boolean(),
        ready: z.boolean().optional(),
      })
      .strict()
      .optional(),
    lastApply: z
      .object({
        outcome: z.enum(['applied', 'rolled-back', 'withdrawn']),
        choice: choiceSchema,
        at: z.string().max(64),
        reason: z.string().max(512).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type AccountSharingRecord = z.infer<typeof recordSchema>;

/** The rename published bytes, but syncing the containing directory failed. */
export class AccountSharingPublishedWriteError extends Error {
  constructor(cause: unknown) {
    super('Account sharing publication could not be confirmed durable.', {
      cause,
    });
  }
}

const DEFAULT_RECORD: AccountSharingRecord = Object.freeze({
  version: 1,
  committed: Object.freeze({ enabled: false }),
}) as AccountSharingRecord;

export type AccountSharingRecordRead =
  | { kind: 'absent'; record: AccountSharingRecord }
  | { kind: 'present'; record: AccountSharingRecord }
  /** Present but not a record this Station wrote: treated as off. */
  | { kind: 'unreadable'; record: AccountSharingRecord };

export function readAccountSharingRecord(
  homeDirectory: string,
): AccountSharingRecordRead {
  let text: string;
  try {
    const path = accountSharingSettingPath(homeDirectory);
    assertPrivateDirectory(dirname(path), 'Account sharing');
    const entry = lstatSync(path);
    const fd = openRegularFileSync(path);
    if (fd === null) throw new Error('Not a regular file');
    try {
      const file = fstatSync(fd);
      if (
        !entry.isFile() ||
        entry.isSymbolicLink() ||
        entry.dev !== file.dev ||
        entry.ino !== file.ino ||
        file.nlink !== 1 ||
        (process.platform !== 'win32' &&
          (file.uid !== process.getuid?.() || (file.mode & 0o077) !== 0)) ||
        file.size > MAX_RECORD_BYTES
      )
        throw new Error('Not a private file');
      const buffer = Buffer.alloc(file.size);
      let offset = 0;
      while (offset < buffer.length) {
        const count = readSync(
          fd,
          buffer,
          offset,
          buffer.length - offset,
          offset,
        );
        if (count === 0) throw new Error('Short read');
        offset += count;
      }
      text = buffer.toString('utf8');
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { kind: 'absent', record: DEFAULT_RECORD };
    return { kind: 'unreadable', record: DEFAULT_RECORD };
  }
  try {
    const parsed = recordSchema.safeParse(JSON.parse(text));
    return parsed.success
      ? { kind: 'present', record: parsed.data }
      : { kind: 'unreadable', record: DEFAULT_RECORD };
  } catch {
    return { kind: 'unreadable', record: DEFAULT_RECORD };
  }
}

/** Atomic, fsynced replacement: a crash leaves the old record or the new one. */
export function writeAccountSharingRecord(
  homeDirectory: string,
  record: AccountSharingRecord,
): void {
  const path = accountSharingSettingPath(homeDirectory);
  const value = recordSchema.parse(record);
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  assertPrivateDirectory(parent, 'Account sharing');
  try {
    const existing = lstatSync(path);
    if (
      !existing.isFile() ||
      existing.isSymbolicLink() ||
      existing.nlink !== 1 ||
      (process.platform !== 'win32' &&
        (existing.uid !== process.getuid?.() || (existing.mode & 0o077) !== 0))
    )
      throw new Error(
        'Account sharing requires a private operator-owned file.',
      );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor: number | undefined;
  let published = false;
  try {
    try {
      descriptor = openSync(temporary, 'wx', 0o600);
      writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(temporary, path);
      published = true;
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      rmSync(temporary, { force: true });
    }
    // Windows cannot open a directory for fsync; the rename is still atomic.
    if (process.platform === 'win32') return;
    const directory = openSync(parent, 'r');
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } catch (error) {
    if (published) throw new AccountSharingPublishedWriteError(error);
    throw error;
  }
}

export interface AccountSharingBoot {
  choice: AccountSharingChoice;
  /** This boot is trying a staged change; commit it once startup succeeds. */
  applying: boolean;
  /** The stored file exists but could not be read; sharing stays off. */
  unreadable: boolean;
}

/**
 * Decides which stored choice this boot starts with. Never throws for a
 * stored-state problem: an unreadable file, or a staged change that cannot
 * first be marked attempted, falls back to the committed choice (or off), so
 * the stored setting alone cannot stop a Station from starting.
 */
export function resolveAccountSharingAtBoot(
  homeDirectory: string,
  now: () => Date = () => new Date(),
  write: typeof writeAccountSharingRecord = writeAccountSharingRecord,
): AccountSharingBoot {
  const read = readAccountSharingRecord(homeDirectory);
  if (read.kind === 'unreadable')
    return { choice: { enabled: false }, applying: false, unreadable: true };
  const { record } = read;
  const pending = record.pending;
  if (!pending)
    return { choice: record.committed, applying: false, unreadable: false };
  if (pending.attempted) {
    try {
      write(homeDirectory, {
        version: 1,
        committed: record.committed,
        lastApply: {
          outcome: 'rolled-back',
          choice: pending.choice,
          at: now().toISOString(),
          reason: 'Station did not start with this setting.',
        },
      });
    } catch {
      // Still boot with the committed choice; the next boot retries this.
    }
    return { choice: record.committed, applying: false, unreadable: false };
  }
  if (!pending.ready)
    return { choice: record.committed, applying: false, unreadable: false };
  try {
    write(homeDirectory, {
      ...record,
      pending: { ...pending, attempted: true },
    });
  } catch {
    // Without a durable attempt mark a failure here could repeat forever.
    return { choice: record.committed, applying: false, unreadable: false };
  }
  return { choice: pending.choice, applying: true, unreadable: false };
}

/** Called once runtime initialization succeeded with an applying choice. */
export function commitAccountSharingAtBoot(
  homeDirectory: string,
  now: () => Date = () => new Date(),
): void {
  const read = readAccountSharingRecord(homeDirectory);
  const pending = read.record.pending;
  if (read.kind !== 'present' || !pending?.attempted) return;
  writeAccountSharingRecord(homeDirectory, {
    version: 1,
    committed: pending.choice,
    lastApply: {
      outcome: 'applied',
      choice: pending.choice,
      at: now().toISOString(),
    },
  });
}

/**
 * Called when this boot tried a staged change and it failed to load: the
 * Station keeps running with sharing off, and the stored choice reverts to
 * the committed one.
 */
export function rollBackAccountSharingAtBoot(
  homeDirectory: string,
  reason: string,
  now: () => Date = () => new Date(),
): void {
  const read = readAccountSharingRecord(homeDirectory);
  const pending = read.record.pending;
  if (read.kind !== 'present' || !pending?.attempted) return;
  writeAccountSharingRecord(homeDirectory, {
    version: 1,
    committed: read.record.committed,
    lastApply: {
      outcome: 'rolled-back',
      choice: pending.choice,
      at: now().toISOString(),
      reason: reason.slice(0, 512),
    },
  });
}

/** Stages a validated change for the next generation to try. */
export function stageAccountSharingChange(
  homeDirectory: string,
  choice: AccountSharingChoice,
  now: () => Date = () => new Date(),
): void {
  const read = readAccountSharingRecord(homeDirectory);
  writeAccountSharingRecord(homeDirectory, {
    version: 1,
    // An unreadable file was booted as off; staging over it records that.
    committed: read.record.committed,
    pending: {
      choice,
      stagedAt: now().toISOString(),
      attempted: false,
      ready: false,
    },
    ...(read.record.lastApply ? { lastApply: read.record.lastApply } : {}),
  });
}

/** Only a handoff that has begun draining may arm a staged choice. */
export function armStagedAccountSharingChange(homeDirectory: string): void {
  const read = readAccountSharingRecord(homeDirectory);
  if (
    read.kind !== 'present' ||
    !read.record.pending ||
    read.record.pending.attempted
  )
    throw new Error('No unattempted account sharing change to arm.');
  writeAccountSharingRecord(homeDirectory, {
    ...read.record,
    pending: { ...read.record.pending, ready: true },
  });
}

/**
 * Withdraws a staged change the handoff never reached. A change a boot has
 * already marked attempted belongs to that boot and is left alone.
 */
export function withdrawStagedAccountSharingChange(
  homeDirectory: string,
  reason: string,
  now: () => Date = () => new Date(),
): void {
  const read = readAccountSharingRecord(homeDirectory);
  const pending = read.record.pending;
  if (read.kind === 'unreadable')
    throw new Error('Account sharing record is unreadable.');
  if (read.kind !== 'present' || !pending || pending.attempted) return;
  writeAccountSharingRecord(homeDirectory, {
    version: 1,
    committed: read.record.committed,
    lastApply: {
      outcome: 'withdrawn',
      choice: pending.choice,
      at: now().toISOString(),
      reason,
    },
  });
}

export type { AccountSharingChoice, AccountSharingLastApply };
