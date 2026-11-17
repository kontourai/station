/**
 * #2377 slice D (owner decision 2026-11-16): every scheduled job records who
 * its runs act as. A personal Station's older ownerless jobs are the
 * operator's; a shared or hosted Station never guesses, and shows why such a
 * job has no Station tools. Real SQLite ledger and the real scheduler.
 */
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { isPersonalStation } from '../../../runtime/routes/runtime-route-support.js';
import { LOCAL_OPERATOR_PRINCIPAL_ID } from '../../identity/principal-resolver.js';
import { BuiltinScheduler } from '../builtin-scheduler.js';
import {
  createSchedulerLedger,
  JOB_OWNER_CANDIDATES_KEY,
  JOB_OWNER_MIGRATION_KEY,
  JOB_OWNER_NEEDED_REASON,
  PROJECT_JOB_OWNER_NEEDED_REASON,
  type SchedulerLedger,
} from '../scheduler-ledger.js';

const makeTempDir = trackTempDirs();
const schedulers: BuiltinScheduler[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const scheduler of schedulers.splice(0)) await scheduler.stop();
});

function sqlite<T>(directory: string, work: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(join(directory, 'scheduler.sqlite'));
  try {
    return work(db);
  } finally {
    db.close();
  }
}

function olderJob(name: string) {
  return {
    name,
    cron: '0 9 * * *',
    prompt: 'tidy',
    enabled: true,
    createdAt: new Date().toISOString(),
  } as never;
}

/**
 * A ledger home as code from before owners were recorded left it: the jobs
 * are stored and neither owner migration key exists yet.
 */
function preOwnerHome(...names: string[]): string {
  const directory = join(makeTempDir('station-job-owner-'), 'scheduler');
  const seed = createSchedulerLedger({ directory });
  for (const name of names)
    expect(seed.create(olderJob(name)).kind).toBe('created');
  seed.close();
  sqlite(directory, (db) =>
    db
      .prepare('DELETE FROM scheduler_ledger_meta WHERE key IN (?, ?)')
      .run(JOB_OWNER_CANDIDATES_KEY, JOB_OWNER_MIGRATION_KEY),
  );
  return directory;
}

/** A ledger holding one untargeted job stored before owners were recorded. */
function ledgerWithOlderJob(): SchedulerLedger {
  return createSchedulerLedger({ directory: preOwnerHome('older') });
}

/** The stored owner of one job, read from the raw row. */
function storedOwner(directory: string, name: string): unknown {
  return sqlite(directory, (db) => {
    const row = db
      .prepare('SELECT data FROM scheduler_jobs WHERE name = ?')
      .get(name) as { data: string } | undefined;
    if (!row) throw new Error(`no job ${name}`);
    return (JSON.parse(row.data) as { createdBy?: unknown }).createdBy;
  });
}

function migrationMarker(directory: string): unknown {
  return sqlite(
    directory,
    (db) =>
      db
        .prepare('SELECT value FROM scheduler_ledger_meta WHERE key = ?')
        .get(JOB_OWNER_MIGRATION_KEY) as unknown,
  );
}

function views(ledger: SchedulerLedger) {
  const read = ledger.listViews();
  if (read.kind !== 'available')
    throw new Error(`ledger read failed: ${read.kind}`);
  return read.value;
}

function schedulerOver(
  ledger: SchedulerLedger,
  personalJobOwner?: { userId: string },
) {
  const scheduler = new BuiltinScheduler({
    ledger,
    turnAdapter: { invoke: vi.fn() } as never,
    ...(personalJobOwner ? { personalJobOwner } : {}),
  });
  schedulers.push(scheduler);
  return scheduler;
}

test('a personal Station records the operator as owner of an older job', () => {
  const ledger = ledgerWithOlderJob();
  // The control: before the scheduler starts, the job has no owner.
  expect(views(ledger)[0]).toMatchObject({
    ownerNeeded: JOB_OWNER_NEEDED_REASON,
  });
  schedulerOver(ledger, { userId: LOCAL_OPERATOR_PRINCIPAL_ID });
  const [job] = views(ledger);
  expect(job?.createdBy).toEqual({ userId: LOCAL_OPERATOR_PRINCIPAL_ID });
  expect(job).not.toHaveProperty('ownerNeeded');
});

test('a shared or hosted Station leaves an older job without an owner, and says why', () => {
  const ledger = ledgerWithOlderJob();
  schedulerOver(ledger);
  const [job] = views(ledger);
  expect(job).not.toHaveProperty('createdBy');
  expect(job?.ownerNeeded).toBe(JOB_OWNER_NEEDED_REASON);
});

test('a new untargeted job records its creator as owner', async () => {
  const ledger = createSchedulerLedger({
    directory: join(makeTempDir('station-job-owner-new-'), 'scheduler'),
  });
  const scheduler = schedulerOver(ledger);
  await scheduler.addJob({
    name: 'fresh',
    cron: '0 9 * * *',
    prompt: 'tidy',
    createdBy: { userId: 'human:local:someone' },
  } as never);
  const [job] = views(ledger);
  expect(job?.createdBy).toEqual({ userId: 'human:local:someone' });
  expect(job).not.toHaveProperty('ownerNeeded');
});

test('only a Station with no other accounts and no hosting is personal', () => {
  expect(isPersonalStation({})).toBe(true);
  expect(isPersonalStation({ localAccounts: {} as never })).toBe(false);
  expect(isPersonalStation({ deploymentAuthentication: {} as never })).toBe(
    false,
  );
  vi.stubEnv('STATION_HOSTED_TENANT_REGISTRY_FILE', '/hosted-tenants.json');
  expect(isPersonalStation({})).toBe(false);
});

test('the operator backfill is a one-time migration: a job created ownerless afterwards keeps no owner across a restart', async () => {
  const directory = join(makeTempDir('station-job-owner-once-'), 'scheduler');
  const operator = { userId: LOCAL_OPERATOR_PRINCIPAL_ID };
  // First start: the migration runs (and records itself) on an empty ledger.
  const first = schedulerOver(createSchedulerLedger({ directory }), operator);
  await first.stop();
  // A job stored afterwards with no owner (e.g. an owner that did not
  // resolve), before the next start.
  const between = createSchedulerLedger({ directory });
  expect(
    between.create({
      name: 'later',
      cron: '0 9 * * *',
      prompt: 'tidy',
      enabled: true,
      createdAt: new Date().toISOString(),
    } as never).kind,
  ).toBe('created');
  // Restart: the migration does not run again.
  const restartedLedger = createSchedulerLedger({ directory });
  schedulerOver(restartedLedger, operator);
  const [job] = views(restartedLedger);
  expect(job).not.toHaveProperty('createdBy');
  expect(job?.ownerNeeded).toBe(JOB_OWNER_NEEDED_REASON);
});

test('a Station that starts shared and later becomes personal does not hand later ownerless jobs to the operator', async () => {
  const directory = join(makeTempDir('station-job-owner-shared-'), 'scheduler');
  // First start on a shared Station: the migration settles, backfilling
  // nothing.
  const shared = schedulerOver(createSchedulerLedger({ directory }));
  await shared.stop();
  const between = createSchedulerLedger({ directory });
  expect(
    between.create({
      name: 'stored-while-shared',
      cron: '0 9 * * *',
      prompt: 'tidy',
      enabled: true,
      createdAt: new Date().toISOString(),
    } as never).kind,
  ).toBe('created');
  // The Station becomes personal (its other accounts removed) and restarts.
  const personalLedger = createSchedulerLedger({ directory });
  schedulerOver(personalLedger, { userId: LOCAL_OPERATOR_PRINCIPAL_ID });
  const [job] = views(personalLedger);
  expect(job).not.toHaveProperty('createdBy');
  expect(job?.ownerNeeded).toBe(JOB_OWNER_NEEDED_REASON);
});

test('an unreadable job record on first start does not hold the migration back, and repairing it later hands no newer job to the operator', async () => {
  const operator = { userId: LOCAL_OPERATOR_PRINCIPAL_ID };
  const directory = preOwnerHome('older', 'damaged');
  sqlite(directory, (db) =>
    db
      .prepare(`UPDATE scheduler_jobs SET data = '{"name":' WHERE name = ?`)
      .run('damaged'),
  );
  // First start on a personal Station: the readable older job is the
  // operator's, the damaged one is set aside, and the migration settles.
  const first = schedulerOver(createSchedulerLedger({ directory }), operator);
  expect(storedOwner(directory, 'older')).toEqual(operator);
  expect(migrationMarker(directory)).toBeDefined();
  await first.stop();
  // Later: the damaged record is repaired, and a job is stored ownerless.
  sqlite(directory, (db) =>
    db.prepare('UPDATE scheduler_jobs SET data = ? WHERE name = ?').run(
      JSON.stringify({
        name: 'damaged',
        cron: '0 9 * * *',
        prompt: 'tidy',
        enabled: true,
        createdAt: new Date().toISOString(),
      }),
      'damaged',
    ),
  );
  const between = createSchedulerLedger({ directory });
  expect(between.create(olderJob('newer')).kind).toBe('created');
  between.close();
  const restarted = createSchedulerLedger({ directory });
  schedulerOver(restarted, operator);
  expect(storedOwner(directory, 'newer')).toBeUndefined();
  expect(storedOwner(directory, 'damaged')).toBeUndefined();
});

test('a database locked during the first-start migration does not widen it to jobs stored afterwards', async () => {
  const operator = { userId: LOCAL_OPERATOR_PRINCIPAL_ID };
  const warn = vi.fn();
  const directory = preOwnerHome('older');
  const ledger = createSchedulerLedger({ directory, busyTimeoutMs: 10 });
  // Another writer holds the lock for the whole first-start migration.
  const holder = new DatabaseSync(join(directory, 'scheduler.sqlite'));
  holder.exec('BEGIN IMMEDIATE');
  try {
    schedulers.push(
      new BuiltinScheduler({
        ledger,
        turnAdapter: { invoke: vi.fn() } as never,
        personalJobOwner: operator,
        logger: { warn, info: vi.fn(), error: vi.fn() } as never,
      }),
    );
  } finally {
    holder.exec('ROLLBACK');
    holder.close();
  }
  // The control: the migration really did fail to settle.
  expect(warn).toHaveBeenCalledWith(
    'Could not record owners of older jobs',
    expect.anything(),
  );
  expect(migrationMarker(directory)).toBeUndefined();
  expect(storedOwner(directory, 'older')).toBeUndefined();
  // A job stored ownerless before the next start.
  expect(ledger.create(olderJob('newer')).kind).toBe('created');
  await schedulers.splice(-1)[0]?.stop();
  const restarted = createSchedulerLedger({ directory });
  schedulerOver(restarted, operator);
  expect(storedOwner(directory, 'older')).toEqual(operator);
  expect(storedOwner(directory, 'newer')).toBeUndefined();
});

test('an ownerless Project job is labelled as needing an owner, like any other job (#5126)', () => {
  const ledger = createSchedulerLedger({
    directory: join(makeTempDir('station-job-owner-project-'), 'scheduler'),
  });
  for (const job of [
    { ...(olderJob('plain') as object), name: 'plain' },
    { ...(olderJob('project') as object), name: 'project', projectId: 'p-1' },
  ])
    expect(ledger.create(job as never).kind).toBe('created');
  const byName = new Map(views(ledger).map((job) => [job.name, job]));
  expect(byName.get('plain')?.ownerNeeded).toBe(JOB_OWNER_NEEDED_REASON);
  // A Project run starts nothing without an owner, and the label says so.
  expect(byName.get('project')?.ownerNeeded).toBe(
    PROJECT_JOB_OWNER_NEEDED_REASON,
  );
  expect(byName.get('project')).not.toHaveProperty('createdBy');
  ledger.close();
});

test('the personal backfill makes the operator the owner of an older Project job too', () => {
  const directory = join(makeTempDir('station-job-owner-'), 'scheduler');
  const seed = createSchedulerLedger({ directory });
  expect(
    seed.create({
      ...(olderJob('project') as object),
      projectId: 'p-1',
    } as never).kind,
  ).toBe('created');
  seed.close();
  sqlite(directory, (db) =>
    db
      .prepare('DELETE FROM scheduler_ledger_meta WHERE key IN (?, ?)')
      .run(JOB_OWNER_CANDIDATES_KEY, JOB_OWNER_MIGRATION_KEY),
  );
  const ledger = createSchedulerLedger({ directory });
  // The control: before the scheduler starts, it is an ownerless Project job.
  expect(views(ledger)[0]).toMatchObject({
    projectId: 'p-1',
    ownerNeeded: PROJECT_JOB_OWNER_NEEDED_REASON,
  });
  schedulerOver(ledger, { userId: LOCAL_OPERATOR_PRINCIPAL_ID });
  expect(storedOwner(directory, 'project')).toEqual({
    userId: LOCAL_OPERATOR_PRINCIPAL_ID,
  });
  expect(views(ledger)[0]).not.toHaveProperty('ownerNeeded');
});
