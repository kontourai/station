import fs, {
  mkdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import * as lifecycle from '@kontourai/station-shared/lifecycle-events';
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

test('nested synchronous admission adds no identity probes beyond explicit same-lease admission', async () => {
  const path = home();
  const owner = await HomeWriterOwner.forHome(path);
  const lease = await owner.acquire();
  const realpath = fs.realpathSync;
  let reads = 0;
  let explicitReads = 0;
  let nestedReads = 0;
  const observe = vi.spyOn(fs, 'realpathSync').mockImplementation((...args) => {
    if (args[0] === path) reads++;
    return realpath(...args);
  });
  syncBuiltinESMExports();
  try {
    owner.runWithLease(lease, () => {
      reads = 0;
      expect(owner.runWithLease(lease, () => 'current')).toBe('current');
      explicitReads = reads;
      reads = 0;
      expect(owner.runSynchronous(() => 'current')).toBe('current');
      nestedReads = reads;
    });
    lease.assertCurrent();
  } finally {
    observe.mockRestore();
    syncBuiltinESMExports();
    await lease.release();
  }
  expect(owner.runSynchronous(() => 'released')).toBe('released');
  expect(explicitReads).toBeGreaterThan(0);
  expect(nestedReads).toBe(explicitReads);
});

test.skipIf(process.platform === 'win32')(
  'a replaced Home refuses a nested callback before it can run even when the Home is restored before outer return',
  async () => {
    const path = home();
    const movedPath = `${path}-held`;
    const owner = await HomeWriterOwner.forHome(path);
    const lease = await owner.acquire();
    let moved = false;
    let entered = false;
    let refusal: unknown;
    try {
      owner.runWithLease(lease, () => {
        renameSync(path, movedPath);
        moved = true;
        try {
          mkdirSync(path, { mode: 0o700 });
          try {
            owner.runSynchronous(() => {
              entered = true;
            });
          } catch (error) {
            refusal = error;
          }
        } finally {
          fs.rmSync(path, { recursive: true, force: true });
          renameSync(movedPath, path);
          moved = false;
        }
      });
      expect(entered).toBe(false);
      expect(refusal).toMatchObject({
        reason: 'identity-unavailable',
        operationRan: false,
      });
      expect(owner.runWithLease(lease, () => 'restored')).toBe('restored');
    } finally {
      if (moved) {
        fs.rmSync(path, { recursive: true, force: true });
        renameSync(movedPath, path);
      }
      await lease.release();
    }
    expect(owner.runSynchronous(() => 'released')).toBe('released');
  },
);

test('a queued asynchronous writer cannot be overtaken by an independent synchronous write', async () => {
  const owner = await HomeWriterOwner.forHome(home());
  const unrelated = await HomeWriterOwner.forHome(home());
  let entered!: () => void;
  let resume!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const acquire = lifecycle.acquireFileMutationLeaseAsync;
  const spy = vi
    .spyOn(lifecycle, 'acquireFileMutationLeaseAsync')
    .mockImplementationOnce(async (...args) => {
      entered();
      await gate;
      return acquire(...args);
    });
  const pending = owner.acquire();
  void pending.catch(() => {});
  let writes = 0;
  try {
    await started;
    expect(() => owner.runSynchronous(() => ++writes)).toThrow(
      expect.objectContaining({ reason: 'busy', operationRan: false }),
    );
    expect(writes).toBe(0);
    expect(unrelated.runSynchronous(() => 'independent home')).toBe(
      'independent home',
    );
  } finally {
    resume();
    spy.mockRestore();
    const admitted = await pending;
    await admitted.release();
  }
  expect(owner.runSynchronous(() => ++writes)).toBe(1);
});

test('a local admission timeout leaves the held writer current and removes only its waiting request', async () => {
  const owner = await HomeWriterOwner.forHome(home());
  const held = await owner.acquire();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const pending = owner.acquire();
    const refused = expect(pending).rejects.toMatchObject({
      reason: 'busy',
      operationRan: false,
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await refused;
    held.assertCurrent();
    expect(owner.runWithLease(held, () => 'original writer')).toBe(
      'original writer',
    );
  } finally {
    vi.useRealTimers();
    await held.release();
  }
  const next = await owner.acquire();
  next.assertCurrent();
  await next.release();
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

test('explicit async lifetime borrows the exact lease and expires for late descendants', async () => {
  const owner = await HomeWriterOwner.forHome(home());
  const foreign = await HomeWriterOwner.forHome(home());
  const lease = await owner.acquire();
  let resume!: () => void;
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  let late!: Promise<unknown>;
  try {
    await expect(
      foreign.withLeaseLifetime(lease, async () => undefined),
    ).rejects.toMatchObject({ reason: 'borrow-unavailable' });
    await owner.withLeaseLifetime(lease, async () => {
      await Promise.resolve();
      expect(owner.runSynchronous(() => 'current')).toBe('current');
      late = gate.then(() => owner.runSynchronous(() => 'late'));
      let wakeNested!: () => void;
      const nestedGate = new Promise<void>((resolve) => {
        wakeNested = resolve;
      });
      let lateNested!: Promise<unknown>;
      await owner.runLifetime(async () => {
        expect(owner.runSynchronous(() => 'nested')).toBe('nested');
        lateNested = nestedGate.then(() =>
          owner.runSynchronous(() => 'late nested'),
        );
      });
      wakeNested();
      await expect(lateNested).rejects.toMatchObject({
        reason: 'borrow-unavailable',
      });
      let spanDescendant!: Promise<unknown>;
      let spanDescendantEntered = false;
      owner.runWithLease(lease, () => {
        spanDescendant = Promise.resolve().then(() =>
          owner.runSynchronous(() => {
            spanDescendantEntered = true;
          }),
        );
      });
      await expect(spanDescendant).rejects.toMatchObject({
        reason: 'borrow-unavailable',
      });
      expect(spanDescendantEntered).toBe(false);
      expect(owner.runSynchronous(() => 'parent current')).toBe(
        'parent current',
      );
    });
    resume();
    await expect(late).rejects.toMatchObject({ reason: 'borrow-unavailable' });
  } finally {
    await lease.release();
  }
  await expect(
    owner.withLeaseLifetime(lease, async () => undefined),
  ).rejects.toMatchObject({ reason: 'borrow-unavailable' });
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

test('request admission waits for home custody and refuses a credential revoked while queued', async () => {
  const path = home();
  const pairing = await DevicePairingService.create({
    homeDir: path,
    environmentId: '11111111-1111-4111-8111-111111111111',
  });
  const offer = pairing.createOffer({ endpoint: 'http://127.0.0.1:43979' });
  const request = pairing.requestPairing({
    offerId: offer.offerId,
    proof: offer.challenge,
    deviceName: 'queued reader',
    requesterPosition: 'unproven',
  });
  pairing.confirmRequest(request.requestId, { kind: 'presented-credential' });
  const paired = pairing.exchange({
    offerId: offer.offerId,
    proof: offer.challenge,
    requestId: request.requestId,
  });
  const owner = await HomeWriterOwner.forHome(path);
  const held = await owner.acquire();
  const abort = new AbortController();
  let checks = 0;
  const pending = owner.runRequest(abort.signal, () => {
    checks++;
    if (!pairing.verifyCredential(paired.credential))
      throw new Error('revoked');
    return 'admitted';
  });
  const rejected = expect(pending).rejects.toThrow('revoked');
  owner.runWithLease(held, () =>
    pairing.revokeDevice(paired.device.id, 'operator-credential'),
  );
  await held.release();
  await rejected;
  expect(checks).toBe(1);
  const heldAgain = await owner.acquire();
  const cancelled = new AbortController();
  const pendingCancelled = owner.runRequest(cancelled.signal, () => {
    checks++;
  });
  const cancellation = expect(pendingCancelled).rejects.toMatchObject({
    name: 'AbortError',
  });
  cancelled.abort();
  await heldAgain.release();
  await cancellation;
  expect(checks).toBe(1);
  const heldThird = await owner.acquire();
  let attempted!: () => void;
  const started = new Promise<void>((resolve) => {
    attempted = resolve;
  });
  const acquire = owner.acquire.bind(owner);
  const acquireSpy = vi.spyOn(owner, 'acquire').mockImplementation((signal) => {
    attempted();
    return acquire(signal);
  });
  let completed = false;
  let startSibling!: () => void;
  const sibling = new Promise<void>((resolve) => {
    startSibling = resolve;
  }).then(() => owner.runSynchronous(() => 'sibling current'));
  const pendingAllowed = owner.runRequest(new AbortController().signal, () => {
    completed = true;
    startSibling();
    return 'admitted';
  });
  await started;
  acquireSpy.mockRestore();
  expect(completed).toBe(false);
  await heldThird.release();
  await expect(pendingAllowed).resolves.toBe('admitted');
  await expect(sibling).resolves.toBe('sibling current');
});

test('owned transaction requires its explicit live lease and refuses a cancelled waiter', async () => {
  const owner = await HomeWriterOwner.forHome(home());
  let retained: Parameters<typeof owner.runWithLease>[0] | undefined;
  await owner.runOwnedLease(new AbortController().signal, async (lease) => {
    retained = lease;
    expect(owner.runWithLease(lease, () => 'current')).toBe('current');
    expect(() => owner.runSynchronous(() => undefined)).toThrow();
  });
  expect(() => owner.runWithLease(retained!, () => undefined)).toThrow();

  const held = await owner.acquire();
  const abort = new AbortController();
  let entered = false;
  const pending = owner.runOwnedLease(abort.signal, async () => {
    entered = true;
  });
  const rejected = expect(pending).rejects.toMatchObject({
    name: 'AbortError',
  });
  abort.abort();
  await held.release();
  await rejected;
  expect(entered).toBe(false);
});

test('an uncontended request completes its synchronous check before yielding', async () => {
  const owner = await HomeWriterOwner.forHome(home());
  let checked = false;
  const pending = owner.runRequest(new AbortController().signal, () => {
    checked = true;
    return 'current';
  });
  expect(checked).toBe(true);
  await expect(pending).resolves.toBe('current');
  let attempts = 0;
  await expect(
    owner.runRequest(new AbortController().signal, () => {
      attempts++;
      throw new HomeWriterUnavailableError('busy');
    }),
  ).rejects.toMatchObject({ reason: 'busy' });
  expect(attempts).toBe(1);
});

test('a queued request reports failed release without replaying its check', async () => {
  const owner = await HomeWriterOwner.forHome(home());
  const held = await owner.acquire();
  let calls = 0;
  let fault: ReturnType<typeof vi.spyOn> | undefined;
  const remove = fs.rmSync;
  const pending = owner.runRequest(new AbortController().signal, () => {
    calls++;
    fault = vi.spyOn(fs, 'rmSync').mockImplementation((path, options) => {
      if (String(path).includes('.home-writer.mutation.guard.stale-'))
        throw new Error('injected request release');
      return remove(path, options);
    });
    syncBuiltinESMExports();
  });
  const rejected = expect(pending).rejects.toMatchObject({
    reason: 'cleanup-required',
    operationRan: true,
  });
  await held.release();
  try {
    await rejected;
    expect(calls).toBe(1);
    expect(() => owner.runSynchronous(() => 'unowned')).toThrow(
      HomeWriterUnavailableError,
    );
  } finally {
    fault?.mockRestore();
    syncBuiltinESMExports();
  }
  const successor = await owner.acquire();
  expect(calls).toBe(1);
  await successor.release();
});

test('a queued request keeps its inactive holder exclusive until release completes', async () => {
  const owner = await HomeWriterOwner.forHome(home());
  const held = await owner.acquire();
  let enteredRelease!: () => void;
  let resumeRelease!: () => void;
  const releaseEntered = new Promise<void>((resolve) => {
    enteredRelease = resolve;
  });
  const releaseGate = new Promise<void>((resolve) => {
    resumeRelease = resolve;
  });
  const acquire = lifecycle.acquireFileMutationLeaseAsync;
  const spy = vi
    .spyOn(lifecycle, 'acquireFileMutationLeaseAsync')
    .mockImplementation(async (...args) => {
      const lease = await acquire(...args);
      return {
        ...lease,
        tryRelease: () => 'cleanup-required' as const,
        release: async () => {
          enteredRelease();
          await releaseGate;
          await lease.release();
        },
      };
    });
  const pending = owner.runRequest(
    new AbortController().signal,
    () => 'completed',
  );
  await held.release();
  try {
    await releaseEntered;
    expect(() => owner.runSynchronous(() => 'unowned')).toThrow(
      expect.objectContaining({ reason: 'busy', operationRan: false }),
    );
  } finally {
    resumeRelease();
    spy.mockRestore();
  }
  await expect(pending).resolves.toBe('completed');
  expect(owner.runSynchronous(() => 'after release')).toBe('after release');
});

test('pairing construction rejects a runtime constructor bypass and a foreign held lease', async () => {
  const options = {
    homeDir: home(),
    environmentId: '11111111-1111-4111-8111-111111111111',
  };
  const owner = await HomeWriterOwner.forHome(options.homeDir);
  owner.runSynchronous(() => {
    expect(() =>
      Reflect.construct(DevicePairingService, [
        options,
        Symbol('foreign construction key'),
        owner,
      ]),
    ).toThrow('prepared factory');
  });
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

for (const mode of ['direct', 'borrowed'] as const) {
  test.skipIf(process.platform === 'win32')(
    `a ${mode} span reports an unconfirmed outcome when its alias changes after the write`,
    async () => {
      const path = home();
      const replacement = home();
      const alias = join(temporary('station-home-writer-postcheck-'), 'home');
      symlinkSync(path, alias);
      const owner = await HomeWriterOwner.forHome(alias);
      const lease = mode === 'borrowed' ? await owner.acquire() : undefined;
      const marker = join(path, 'security', 'committed');
      let writes = 0;
      const operation = () => {
        writeFileSync(marker, 'committed');
        writes++;
        unlinkSync(alias);
        symlinkSync(replacement, alias);
      };
      try {
        const run = () =>
          lease
            ? owner.runWithLease(lease, operation)
            : owner.runSynchronous(operation);
        expect(run).toThrow(
          expect.objectContaining({
            reason: 'identity-unavailable',
            operationRan: true,
          }),
        );
        expect(writes).toBe(1);
        expect(readFileSync(marker, 'utf8')).toBe('committed');
      } finally {
        await lease?.release();
      }
    },
  );
}

test('async exclusive cleanup failure retains the completed callback outcome until settlement', async () => {
  const owner = await HomeWriterOwner.forHome(home());
  const remove = fs.rmSync;
  const fault = vi.spyOn(fs, 'rmSync').mockImplementation((path, options) => {
    if (String(path).includes('.home-writer.mutation.guard.stale-'))
      throw new Error('injected exclusive cleanup failure');
    return remove(path, options);
  });
  syncBuiltinESMExports();
  let calls = 0;
  try {
    await expect(owner.runExclusive(() => ++calls)).rejects.toMatchObject({
      reason: 'cleanup-required',
      operationRan: true,
    });
    expect(calls).toBe(1);
    expect(() => owner.runSynchronous(() => ++calls)).toThrow(
      HomeWriterUnavailableError,
    );
  } finally {
    fault.mockRestore();
    syncBuiltinESMExports();
  }
  const lease = await owner.acquire();
  expect(calls).toBe(1);
  await lease.release();
});

test('held writer notifications run after release and start async observers without a borrowed span', async () => {
  const owner = await HomeWriterOwner.forHome(home());
  const lease = await owner.acquire();
  let calls = 0;
  let observer: Promise<number> | undefined;
  owner.runWithLease(lease, () =>
    owner.afterRelease(() => {
      calls++;
      observer = Promise.resolve().then(() => owner.runSynchronous(() => 42));
    }),
  );
  expect(calls).toBe(0);
  await lease.release();
  expect(calls).toBe(1);
  await expect(observer).resolves.toBe(42);
});
