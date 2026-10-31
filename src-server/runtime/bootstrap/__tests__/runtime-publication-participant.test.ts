import { join } from 'node:path';
import {
  acquireStationHomeRuntimeLease,
  captureStationHomeRuntimeProof,
} from '@kontourai/station-shared/station-home-lifecycle';
import { expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { RuntimePublicationParticipant } from '../runtime-publication-participant.js';

const temp = trackTempDirs();

test('stopping refuses new work and waits for the admitted body and child release', async () => {
  const home = join(temp('runtime-publication-'), 'home');
  const homeLease = acquireStationHomeRuntimeLease(home);
  try {
    const participant = new RuntimePublicationParticipant(
      captureStationHomeRuntimeProof(home, homeLease),
    );
    const foreignHome = join(temp('foreign-home-'), 'home');
    expect(() => participant.assertHome(foreignHome)).toThrow();
    const lease = participant.acquire();
    expect(() => lease.borrow(foreignHome)).toThrow();
    const child = lease.borrow(home);
    participant.stop();
    expect(() => participant.acquire()).toThrow('publication');
    expect(() => child.assertCurrent()).not.toThrow();
    expect(() => lease.release()).toThrow('publication');
    await expect(participant.drain(1)).rejects.toThrow('publication');
    child.release();
    child.release();
    expect(() => child.assertCurrent()).toThrow('publication');
    lease.release();
    lease.release();
    await expect(participant.drain(100)).resolves.toBeUndefined();
  } finally {
    homeLease.release();
  }
});

test('body failure releases its exact admission and preserves the failure', async () => {
  const home = join(temp('runtime-publication-failure-'), 'home');
  const homeLease = acquireStationHomeRuntimeLease(home);
  try {
    const participant = new RuntimePublicationParticipant(
      captureStationHomeRuntimeProof(home, homeLease),
    );
    const failure = new Error('publication uncertain');
    await expect(
      participant.run(async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    participant.stop();
    await expect(participant.drain(100)).resolves.toBeUndefined();
  } finally {
    homeLease.release();
  }
});

test('lost home proof retains uncertain admission instead of claiming a clean drain', async () => {
  const home = join(temp('runtime-publication-lost-'), 'home');
  const homeLease = acquireStationHomeRuntimeLease(home);
  const participant = new RuntimePublicationParticipant(
    captureStationHomeRuntimeProof(home, homeLease),
  );
  const lease = participant.acquire();
  const child = lease.borrow(home);
  homeLease.release();
  expect(() => child.assertCurrent()).toThrow();
  expect(() => lease.borrow(home)).toThrow();
  expect(() => lease.release()).toThrow();
  participant.stop();
  await expect(participant.drain(1)).rejects.toMatchObject({
    code: 'runtime_publication_pending',
  });
});

test('body and unreleased-child failures retain the admission until explicit cleanup', async () => {
  const home = join(temp('runtime-publication-both-'), 'home');
  const homeLease = acquireStationHomeRuntimeLease(home);
  try {
    const participant = new RuntimePublicationParticipant(
      captureStationHomeRuntimeProof(home, homeLease),
    );
    let parent: ReturnType<typeof participant.acquire> | undefined;
    let child: ReturnType<NonNullable<typeof parent>['borrow']> | undefined;
    const bodyFailure = new Error('body failed after publication');
    await expect(
      participant.run(async (lease) => {
        parent = lease;
        child = lease.borrow();
        throw bodyFailure;
      }),
    ).rejects.toMatchObject({ errors: [bodyFailure, expect.any(Error)] });
    participant.stop();
    await expect(participant.drain(1)).rejects.toMatchObject({
      code: 'runtime_publication_pending',
    });
    child!.release();
    parent!.release();
    await expect(participant.drain(100)).resolves.toBeUndefined();
  } finally {
    homeLease.release();
  }
});

test('shutdown retries retained cleanup without losing an outstanding child', async () => {
  const home = join(temp('runtime-publication-cleanup-'), 'home');
  const homeLease = acquireStationHomeRuntimeLease(home);
  try {
    const participant = new RuntimePublicationParticipant(
      captureStationHomeRuntimeProof(home, homeLease),
    );
    const lease = participant.acquire();
    const child = lease.borrow();
    let attempts = 0;
    const cleanup = participant.retainCleanup(async () => {
      if (++attempts === 1) throw new Error('home cleanup uncertain');
      lease.assertReleasable();
      lease.release();
    });
    await expect(cleanup()).rejects.toThrow('home cleanup uncertain');
    participant.stop();
    await expect(participant.drain(10)).rejects.toMatchObject({
      code: 'runtime_publication_pending',
    });
    expect(() => lease.borrow()).toThrow('publication');
    expect(() => child.assertCurrent()).not.toThrow();
    child.release();
    await expect(participant.drain(100)).resolves.toBeUndefined();
    expect(attempts).toBe(3);
  } finally {
    homeLease.release();
  }
});
