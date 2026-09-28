import { expect, it } from 'vitest';
import { createRelayAccountStationGroupOwner } from '../lib/local-collaboration-relay-account.js';

it('unwinds owned Stations in reverse order and preserves the startup failure', async () => {
  const calls: string[] = [];
  const startupFailure = new Error('second_station_start_failed');
  const stationCleanupFailure = new Error('first_station_cleanup_failed');
  const leaseCleanupFailure = new Error('account_lab_lease_release_failed');
  const owner = createRelayAccountStationGroupOwner(async () => {
    calls.push('lease');
    throw leaseCleanupFailure;
  });
  owner.own({
    async stop() {
      calls.push('first');
      throw stationCleanupFailure;
    },
  });
  owner.own({
    async stop() {
      calls.push('second');
    },
  });

  let failure: unknown;
  try {
    await owner.start(async () => {
      throw startupFailure;
    });
  } catch (error) {
    failure = error;
  }

  expect(failure).toBeInstanceOf(AggregateError);
  expect((failure as AggregateError).cause).toBe(startupFailure);
  expect((failure as AggregateError).errors[0]).toBe(startupFailure);
  const cleanupFailure = (failure as AggregateError)
    .errors[1] as AggregateError;
  expect(cleanupFailure.errors).toEqual([
    stationCleanupFailure,
    leaseCleanupFailure,
  ]);
  expect(calls).toEqual(['second', 'first', 'lease']);
  const stop = owner.stop();
  expect(owner.stop()).toBe(stop);
  await expect(stop).rejects.toBe(cleanupFailure);
});
