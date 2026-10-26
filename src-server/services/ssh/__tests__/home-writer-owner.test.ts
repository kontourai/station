import fs, { mkdirSync, renameSync, symlinkSync, unlinkSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { DevicePairingService } from '../device-pairing-service.js';
import {
  HomeWriterOwner,
  HomeWriterUnavailableError,
} from '../home-writer-owner.js';

const temporary = trackTempDirs();
function home() {
  const path = temporary('station-home-writer-');
  mkdirSync(join(path, 'security'), { mode: 0o700 });
  return path;
}

test('one canonical home excludes independent writes while explicit synchronous borrowing remains available', async () => {
  const path = home();
  const owner = await HomeWriterOwner.forHome(path);
  const other = await HomeWriterOwner.forHome(path);
  const lease = await owner.acquire();
  let writes = 0;
  try {
    expect(() => other.runSynchronous(() => writes++)).toThrow(
      HomeWriterUnavailableError,
    );
    expect(writes).toBe(0);
    expect(
      owner.runWithLease(lease, () => other.runSynchronous(() => ++writes)),
    ).toBe(1);
    lease.assertCurrent();
  } finally {
    await lease.release();
  }
  expect(other.runSynchronous(() => ++writes)).toBe(2);
});

test('late async descendants cannot borrow a completed synchronous span', async () => {
  const owner = await HomeWriterOwner.forHome(home());
  const lease = await owner.acquire();
  let writes = 0;
  let late: Promise<unknown> | undefined;
  try {
    owner.runWithLease(lease, () => {
      late = Promise.resolve().then(() => owner.runSynchronous(() => writes++));
    });
    await expect(late).rejects.toMatchObject({ reason: 'borrow-unavailable' });
    expect(writes).toBe(0);
    owner.runWithLease(lease, () => {
      writes++;
    });
    expect(writes).toBe(1);
  } finally {
    await lease.release();
  }
});

test('thenable callbacks and foreign-home leases cannot become synchronous borrowing authority', async () => {
  const owner = await HomeWriterOwner.forHome(home());
  const foreign = await HomeWriterOwner.forHome(home());
  const lease = await owner.acquire();
  try {
    expect(() =>
      owner.runWithLease(lease, () => Promise.resolve('later')),
    ).toThrow('must be synchronous');
    expect(() => foreign.runWithLease(lease, () => 'foreign')).toThrow(
      HomeWriterUnavailableError,
    );
    expect(owner.runWithLease(lease, () => 'current')).toBe('current');
  } finally {
    await lease.release();
  }
  expect(() => owner.runWithLease(lease, () => 'released')).toThrow(
    HomeWriterUnavailableError,
  );
});

test('a replaced security directory cannot inherit the prepared home identity', async () => {
  const path = home();
  const owner = await HomeWriterOwner.forHome(path);
  renameSync(join(path, 'security'), join(path, 'retained-security'));
  mkdirSync(join(path, 'security'), { mode: 0o700 });
  expect(() => owner.runSynchronous(() => 'replacement')).toThrow(
    HomeWriterUnavailableError,
  );
});

test('a later acquire settles a retained failed release without invalidating its successor', async () => {
  const owner = await HomeWriterOwner.forHome(home());
  const lease = await owner.acquire();
  const remove = fs.rmSync;
  const fault = vi.spyOn(fs, 'rmSync').mockImplementation((path, options) => {
    if (String(path).includes('.home-writer.mutation.guard.stale-'))
      throw new Error('injected retained release');
    return remove(path, options);
  });
  syncBuiltinESMExports();
  try {
    await expect(lease.release()).rejects.toThrow('injected retained release');
    expect(() => owner.runSynchronous(() => 'unowned')).toThrow(
      HomeWriterUnavailableError,
    );
  } finally {
    fault.mockRestore();
    syncBuiltinESMExports();
  }
  const successor = await owner.acquire();
  await lease.release();
  successor.assertCurrent();
  await successor.release();
});

test('cleanup failure reports that the callback ran and never replays it during settlement', async () => {
  const owner = await HomeWriterOwner.forHome(home());
  const remove = fs.rmSync;
  const fault = vi.spyOn(fs, 'rmSync').mockImplementation((path, options) => {
    if (String(path).includes('.home-writer.mutation.guard.stale-'))
      throw new Error('injected retained release');
    return remove(path, options);
  });
  let calls = 0;
  let outcome: unknown;
  syncBuiltinESMExports();
  try {
    try {
      owner.runSynchronous(() => {
        calls++;
      });
    } catch (error) {
      outcome = error;
    }
    expect(outcome).toMatchObject({
      reason: 'cleanup-required',
      operationRan: true,
    });
    expect(calls).toBe(1);
  } finally {
    fault.mockRestore();
    syncBuiltinESMExports();
  }
  const lease = await owner.acquire();
  expect(calls).toBe(1);
  await lease.release();
});

test('the real pairing writer and authentication reader join the home hold', async () => {
  const path = home();
  const environmentId = '11111111-1111-4111-8111-111111111111';
  const pairing = await DevicePairingService.create({
    homeDir: path,
    environmentId,
  });
  const offer = pairing.createOffer({ endpoint: 'http://127.0.0.1:43979' });
  const requested = pairing.requestPairing({
    offerId: offer.offerId,
    proof: offer.challenge,
    deviceName: 'owned fixture',
    requesterPosition: 'unproven',
  });
  pairing.confirmRequest(requested.requestId, { kind: 'presented-credential' });
  const paired = pairing.exchange({
    offerId: offer.offerId,
    proof: offer.challenge,
    requestId: requested.requestId,
  });
  const owner = await HomeWriterOwner.forHome(path);
  const lease = await owner.acquire();
  try {
    expect(() =>
      pairing.revokeDevice(paired.device.id, 'operator-credential'),
    ).toThrow(HomeWriterUnavailableError);
    expect(() => pairing.recordCredentialActivity(paired.credential)).toThrow(
      HomeWriterUnavailableError,
    );
    expect(() => pairing.verifyCredential(paired.credential)).toThrow(
      HomeWriterUnavailableError,
    );
    expect(
      owner.runWithLease(lease, () =>
        pairing.verifyCredential(paired.credential),
      ),
    ).toBe(true);
    owner.runWithLease(lease, () =>
      pairing.revokeDevice(paired.device.id, 'operator-credential'),
    );
  } finally {
    await lease.release();
  }
  expect(pairing.verifyCredential(paired.credential)).toBe(false);
});

test('pairing construction rejects a runtime constructor bypass and a foreign held lease', async () => {
  const options = {
    homeDir: home(),
    environmentId: '11111111-1111-4111-8111-111111111111',
  };
  expect(() => Reflect.construct(DevicePairingService, [options])).toThrow(
    'prepared factory',
  );
  const foreign = await HomeWriterOwner.forHome(home());
  const lease = await foreign.acquire();
  try {
    await expect(
      DevicePairingService.create(options, lease),
    ).rejects.toMatchObject({ reason: 'borrow-unavailable' });
    lease.assertCurrent();
  } finally {
    await lease.release();
  }
  const admitted = await DevicePairingService.create(options);
  expect(admitted.listDevices()).toEqual([]);
});

test.skipIf(process.platform === 'win32')(
  'aliases join one home while a retargeted alias refuses',
  async () => {
    const path = home();
    const second = home();
    const alias = join(temporary('station-home-writer-alias-'), 'home');
    symlinkSync(path, alias);
    const owner = await HomeWriterOwner.forHome(path);
    const throughAlias = await HomeWriterOwner.forHome(alias);
    const lease = await owner.acquire();
    try {
      expect(() => throughAlias.runSynchronous(() => 'independent')).toThrow(
        HomeWriterUnavailableError,
      );
      expect(throughAlias.runWithLease(lease, () => 'same home')).toBe(
        'same home',
      );
      unlinkSync(alias);
      symlinkSync(second, alias);
      expect(() =>
        throughAlias.runWithLease(lease, () => 'retargeted'),
      ).toThrow(HomeWriterUnavailableError);
    } finally {
      await lease.release();
    }
  },
);
