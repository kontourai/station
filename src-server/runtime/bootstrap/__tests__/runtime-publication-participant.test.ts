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
    expect(() =>
      participant.assertHome(join(temp('foreign-home-'), 'home')),
    ).toThrow();
    const lease = participant.acquire();
    const child = lease.borrow();
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
  homeLease.release();
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
