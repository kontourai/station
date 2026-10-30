import fs, { readFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { publishJsonFileWithOwnedLock } from '@kontourai/station-shared/json-file-storage';
import {
  acquireStationHomeMaintenanceLease,
  StationHomeActiveError,
} from '@kontourai/station-shared/station-home-lifecycle';
import { expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { HomeWriterOwner } from '../../../services/ssh/home-writer-owner.js';
import type { RuntimePublicationParticipant } from '../runtime-publication-participant.js';
import { StationRuntime } from '../station-runtime.js';

const temp = trackTempDirs();

test('real bootstrap holds home and storage until admitted publication completes', async () => {
  const home = temp('runtime-publication-real-');
  const runtime = new StationRuntime({ projectHomeDir: home });
  const participant = Reflect.get(
    runtime,
    'runtimePublicationParticipant',
  ) as RuntimePublicationParticipant;
  let resume!: () => void;
  let entered!: () => void;
  const barrier = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const bodyDone = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const close = vi.spyOn(
    Reflect.get(runtime, 'orchestrationEventStore'),
    'close',
  );
  const path = join(home, 'publication.json');
  const publication = participant.run(async (lease) => {
    entered();
    await barrier;
    await publishJsonFileWithOwnedLock(
      path,
      { revision: 1 },
      {
        finalizeCommit: () => {
          lease.assertCurrent();
          return undefined;
        },
      },
    );
  });
  await bodyDone;
  const shutdown = runtime.shutdown();
  const repeatedShutdown = runtime.shutdown();
  expect(close).not.toHaveBeenCalled();
  expect(() => participant.acquire()).toThrow('publication');
  expect(() => acquireStationHomeMaintenanceLease(home)).toThrow(
    StationHomeActiveError,
  );
  resume();
  await publication;
  await Promise.all([shutdown, repeatedShutdown]);
  expect(close).toHaveBeenCalledOnce();
  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ revision: 1 });
  const maintenance = acquireStationHomeMaintenanceLease(home);
  maintenance.release();
}, 30_000);

test('shutdown retries an uncertain real home writer release before closing storage', async () => {
  const home = temp('runtime-publication-cleanup-real-');
  const runtime = new StationRuntime({ projectHomeDir: home });
  const participant = Reflect.get(
    runtime,
    'runtimePublicationParticipant',
  ) as RuntimePublicationParticipant;
  const close = vi.spyOn(
    Reflect.get(runtime, 'orchestrationEventStore'),
    'close',
  );
  const parent = participant.acquire();
  const writer = await HomeWriterOwner.forHome(home);
  const hold = await writer.acquire();
  let released = false;
  const cleanup = participant.retainCleanup(async () => {
    parent.assertReleasable();
    if (!released) {
      await hold.release();
      released = true;
    }
    parent.release();
  });
  const remove = fs.rmSync;
  const fault = vi.spyOn(fs, 'rmSync').mockImplementation((path, options) => {
    if (String(path).includes('.home-writer.mutation.guard.stale-'))
      throw new Error('injected home release failure');
    return remove(path, options);
  });
  syncBuiltinESMExports();
  try {
    await expect(cleanup()).rejects.toThrow('injected home release failure');
    expect(close).not.toHaveBeenCalled();
    expect(() => acquireStationHomeMaintenanceLease(home)).toThrow(
      StationHomeActiveError,
    );
  } finally {
    fault.mockRestore();
    syncBuiltinESMExports();
  }
  await runtime.shutdown();
  expect(close).toHaveBeenCalledOnce();
  const maintenance = acquireStationHomeMaintenanceLease(home);
  maintenance.release();
}, 30_000);

test('unsettled publication leaves storage and home held until shutdown is retried', async () => {
  const home = temp('runtime-publication-pending-');
  const runtime = new StationRuntime({ projectHomeDir: home });
  const participant = Reflect.get(
    runtime,
    'runtimePublicationParticipant',
  ) as RuntimePublicationParticipant;
  const eventStore = Reflect.get(runtime, 'orchestrationEventStore');
  const close = vi.spyOn(eventStore, 'close');
  let resume!: () => void;
  let entered!: () => void;
  const barrier = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const publication = participant.run(async () => {
    entered();
    await barrier;
  });
  await started;
  try {
    await expect(runtime.shutdown()).rejects.toMatchObject({
      code: 'runtime_publication_pending',
    });
    expect(close).not.toHaveBeenCalled();
    expect(() => acquireStationHomeMaintenanceLease(home)).toThrow(
      StationHomeActiveError,
    );
    expect(() => participant.acquire()).toThrow('publication');
  } finally {
    resume();
  }
  await publication;
  await runtime.shutdown();
  expect(close).toHaveBeenCalledOnce();
  const maintenance = acquireStationHomeMaintenanceLease(home);
  maintenance.release();
}, 30_000);
