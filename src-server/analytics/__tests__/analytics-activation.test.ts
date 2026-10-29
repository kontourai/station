import {
  lstatSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  createStationHomeBackup,
  createStationHomeUpdateBackup,
  readStationHomeRecovery,
  restoreStationHomeBackup,
  restoreStationHomeUpdateBackup,
  STATION_HOME_RECOVERY_RECORD,
} from '@kontourai/station-shared/station-home-archive';
import { ensureStationHomeSchemaSync } from '@kontourai/station-shared/station-home-schema';
import { afterEach, expect, test } from 'vitest';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import { EventStore } from '../../services/orchestration/event-store.js';
import { analyticsHomeExportActivation } from '../analytics-activation.js';

const makeTempDir = trackTempDirs();
const stores = new Set<EventStore>();
afterEach(() => {
  for (const store of stores) store.close();
  stores.clear();
});
function open(home: string) {
  const store = new EventStore(join(home, 'data', 'orchestration.sqlite'));
  stores.add(store);
  store.bindUsageExportActivation(analyticsHomeExportActivation(home));
  return store;
}
function close(store: EventStore) {
  store.close();
  stores.delete(store);
}
const query = {
  ownerUserIds: ['person-one'],
  from: '2026-10-01',
  to: '2026-10-02',
  after: 0,
  limit: 1,
};

test('the actual home restore changes private export generation without rewriting generic stream identity', () => {
  const root = makeTempDir('station-analytics-activation-'),
    home = join(root, 'home');
  ensureStationHomeSchemaSync(home);
  let store = open(home);
  const generic = store.streamEpoch(),
    epoch = store.readUsageReceiptExportPage(query).streamEpoch;
  expect(
    store.readUsageReceiptExportPage({ ...query, streamEpoch: epoch })
      .streamEpoch,
  ).toBe(epoch);
  close(store);
  const backup = createStationHomeBackup({
    homeDir: home,
    outputDir: join(root, 'backup'),
  });
  restoreStationHomeBackup({
    homeDir: home,
    backupDir: backup.backupDir,
    confirm: true,
  });
  expect(readStationHomeRecovery(home).kind).toBe('recovered');
  store = open(home);
  expect(store.streamEpoch()).toBe(generic);
  const restored = store.readUsageReceiptExportPage(query).streamEpoch;
  expect(restored).not.toBe(epoch);
  expect(() =>
    store.readUsageReceiptExportPage({ ...query, streamEpoch: epoch }),
  ).toThrow('Usage export source changed');
  expect(
    store.readUsageExportInvalidations({
      ownerUserIds: ['person-one'],
      after: 0,
      limit: 1,
      streamEpoch: epoch,
    }),
  ).toEqual({ kind: 'changed' });
  close(store);
  store = open(home);
  expect(store.usageExportEpoch()).toBe(restored);
  expect(store.streamEpoch()).toBe(generic);
});

test('an unreadable or changed activation refuses private exports while generic stream reads remain available', () => {
  const root = makeTempDir('station-analytics-activation-refuse-'),
    home = join(root, 'home');
  ensureStationHomeSchemaSync(home);
  const store = open(home),
    generic = store.streamEpoch();
  writeFileSync(join(home, STATION_HOME_RECOVERY_RECORD), '{}');
  expect(() => store.readUsageReceiptExportPage(query)).toThrow(
    'Analytics home activation unavailable',
  );
  expect(store.streamEpoch()).toBe(generic);
});

test('unavailable startup activation installs a refusing export boundary, not a generic startup failure or fallback epoch', () => {
  const root = makeTempDir('station-analytics-unavailable-start-'),
    home = join(root, 'home');
  ensureStationHomeSchemaSync(home);
  writeFileSync(join(home, STATION_HOME_RECOVERY_RECORD), '{}');
  const store = open(home),
    generic = store.streamEpoch();
  expect(() => store.readUsageReceiptExportPage(query)).toThrow(
    'Analytics home activation unavailable',
  );
  expect(store.streamEpoch()).toBe(generic);
  unlinkSync(join(home, STATION_HOME_RECOVERY_RECORD));
  expect(() => store.usageExportEpoch()).toThrow(
    'Analytics home activation unavailable',
  );
  close(store);
  const restarted = open(home);
  expect(restarted.readUsageReceiptExportPage(query).streamEpoch).not.toBe(
    generic,
  );
  expect(restarted.streamEpoch()).toBe(generic);
});

function recoveredUpdateFixture() {
  const root = makeTempDir('station-analytics-update-'),
    home = join(root, 'home');
  ensureStationHomeSchemaSync(home);
  mkdirSync(join(home, 'config'), { recursive: true });
  writeFileSync(join(home, 'config', 'activation-control.json'), 'before');
  const original = open(home),
    generic = original.streamEpoch();
  close(original);
  const normal = createStationHomeBackup({
    homeDir: home,
    outputDir: join(root, 'normal'),
  });
  restoreStationHomeBackup({
    homeDir: home,
    backupDir: normal.backupDir,
    confirm: true,
  });
  const before = readStationHomeRecovery(home);
  if (before.kind !== 'recovered')
    throw new Error('missing genuine recovery record');
  const backup = createStationHomeUpdateBackup({
    homeDir: home,
    backupDir: join(root, 'update'),
  });
  return { root, home, generic, before: before.recovery, backup };
}

test('in-place update rollback advances activation on every replay and does not restore its older marker', () => {
  const h = recoveredUpdateFixture(),
    inode = lstatSync(h.home).ino;
  let store = open(h.home);
  const epoch = store.usageExportEpoch();
  close(store);
  writeFileSync(join(h.home, 'config', 'activation-control.json'), 'trial');
  restoreStationHomeUpdateBackup({
    homeDir: h.home,
    backupDir: h.backup.backupDir,
  });
  expect(lstatSync(h.home).ino).toBe(inode);
  expect(
    readFileSync(join(h.home, 'config', 'activation-control.json'), 'utf8'),
  ).toBe('before');
  store = open(h.home);
  expect(store.streamEpoch()).toBe(h.generic);
  expect(store.usageExportEpoch()).not.toBe(epoch);
  close(store);
  const first = readStationHomeRecovery(h.home);
  if (first.kind !== 'recovered') throw new Error('missing rollback record');
  expect(first.recovery.recoveryId).not.toBe(h.before.recoveryId);
  restoreStationHomeUpdateBackup({
    homeDir: h.home,
    backupDir: h.backup.backupDir,
  });
  const second = readStationHomeRecovery(h.home);
  if (second.kind !== 'recovered') throw new Error('missing replay record');
  expect(second.recovery.recoveryId).not.toBe(first.recovery.recoveryId);
  expect(second.recovery.authorityTransferred).toBe(false);
});

test('rollback publishes its new activation before destructive state removal and preserves it through interruption', () => {
  const h = recoveredUpdateFixture();
  expect(() =>
    restoreStationHomeUpdateBackup({
      homeDir: h.home,
      backupDir: h.backup.backupDir,
      afterRemove: () => {
        throw new Error('rollback interruption');
      },
    }),
  ).toThrow('update backup could not be restored');
  const failed = readStationHomeRecovery(h.home);
  expect(failed.kind).toBe('recovered');
  if (failed.kind !== 'recovered')
    throw new Error('activation was removed with copied state');
  expect(failed.recovery.recoveryId).not.toBe(h.before.recoveryId);
  restoreStationHomeUpdateBackup({
    homeDir: h.home,
    backupDir: h.backup.backupDir,
  });
  const retried = readStationHomeRecovery(h.home);
  if (retried.kind !== 'recovered')
    throw new Error('missing retried activation');
  expect(retried.recovery.recoveryId).not.toBe(failed.recovery.recoveryId);
  expect(
    readFileSync(join(h.home, 'config', 'activation-control.json'), 'utf8'),
  ).toBe('before');
});
