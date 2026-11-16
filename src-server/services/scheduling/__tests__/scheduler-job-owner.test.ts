/**
 * #2377 slice D (owner decision 2026-11-16): every scheduled job records who
 * its runs act as. A personal Station's older ownerless jobs are the
 * operator's; a shared or hosted Station never guesses, and shows why such a
 * job has no Station tools. Real SQLite ledger and the real scheduler.
 */
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { isPersonalStation } from '../../../runtime/routes/runtime-route-support.js';
import { LOCAL_OPERATOR_PRINCIPAL_ID } from '../../identity/principal-resolver.js';
import { BuiltinScheduler } from '../builtin-scheduler.js';
import {
  createSchedulerLedger,
  JOB_OWNER_NEEDED_REASON,
  type SchedulerLedger,
} from '../scheduler-ledger.js';

const makeTempDir = trackTempDirs();
const schedulers: BuiltinScheduler[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const scheduler of schedulers.splice(0)) await scheduler.stop();
});

/** A ledger holding one untargeted job stored before owners were recorded. */
function ledgerWithOlderJob(): SchedulerLedger {
  const ledger = createSchedulerLedger({
    directory: join(makeTempDir('station-job-owner-'), 'scheduler'),
  });
  expect(
    ledger.create({
      name: 'older',
      cron: '0 9 * * *',
      prompt: 'tidy',
      enabled: true,
      createdAt: new Date().toISOString(),
    } as never).kind,
  ).toBe('created');
  return ledger;
}

function views(ledger: SchedulerLedger) {
  const read = ledger.listViews();
  if (read.kind !== 'available') throw new Error(`ledger read failed: ${read.kind}`);
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
