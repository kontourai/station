import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExactProcessIdentityProbe } from '@kontourai/station-shared/process-identity';
import { afterAll, describe, expect, test } from 'vitest';
import { ACPProcess } from '../acp-process.js';

/**
 * archive#1089, guard row 3 ("directory does not exist → throw", archive#791).
 *
 * Reproduced on origin/main (1e5b45d2) against a live instance: POSTing an
 * engine connection whose Working Directory was `~/` (a literal tilde — the
 * connection form is free text and does no expansion) killed the whole server:
 *
 *   Uncaught exception: Error: spawn /Users/brian/.local/bin/stub-acp ENOENT
 *   Shutting down gracefully (uncaughtException)...
 *
 * Two separate failures in one line. The `spawn()` `'error'` event had no
 * listener, so a bad working directory took the process down rather than
 * failing one connection; and Node's message names the COMMAND, which is
 * present and executable, instead of the directory, which is not.
 *
 * These tests drive the REAL `spawn` — mocking it would test the mock, and the
 * defect was precisely in how the real event was (not) handled.
 */
describe('ACPProcess spawn failure (#1089)', () => {
  const missingCwd = join(
    tmpdir(),
    `station-acp-missing-${process.pid}-${Date.now()}`,
  );
  const realCwd = mkdtempSync(join(tmpdir(), 'station-acp-real-'));

  afterAll(() => {
    rmSync(realCwd, { recursive: true, force: true });
  });

  test('rejects naming the missing working directory instead of crashing the process', async () => {
    const acpProcess = new ACPProcess({
      command: 'node',
      args: ['-e', 'process.stdin.resume()'],
      cwd: missingCwd,
      createClient: () => ({}) as any,
      logger: { warn: () => {}, debug: () => {} },
    });

    await expect(acpProcess.start()).rejects.toThrow(
      `its working directory does not exist: ${missingCwd}`,
    );
    // The command is named too — but as context, not as the culprit.
    await expect(
      acpProcess.destroy().then(() => 'settled'),
    ).resolves.toBeDefined();
  });

  test('an unresolvable command still fails on its own terms', async () => {
    const acpProcess = new ACPProcess({
      command: 'station-no-such-engine-cli',
      cwd: realCwd,
      createClient: () => ({}) as any,
      logger: { warn: () => {}, debug: () => {} },
    });

    await expect(acpProcess.start()).rejects.toThrow('not found on PATH');
    await acpProcess.destroy();
  });

  /**
   * The load-bearing half: an `'error'` from the child must never reach the
   * process-level `uncaughtException` handler. `start()` rejecting is not
   * proof of that on its own — the listener could have been added on the
   * losing side of a race. Assert directly that nothing escaped.
   */
  test('emits no uncaughtException and no unhandledRejection', async () => {
    const escaped: unknown[] = [];
    const onUncaught = (error: unknown) => escaped.push(error);
    const onUnhandled = (reason: unknown) => escaped.push(reason);
    process.on('uncaughtException', onUncaught);
    process.on('unhandledRejection', onUnhandled);

    try {
      const acpProcess = new ACPProcess({
        command: 'node',
        args: ['-e', 'process.stdin.resume()'],
        cwd: missingCwd,
        createClient: () => ({}) as any,
        logger: { warn: () => {}, debug: () => {} },
      });
      await expect(acpProcess.start()).rejects.toThrow();
      await acpProcess.destroy();
      // Let any deferred rejection land before asserting.
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      process.off('uncaughtException', onUncaught);
      process.off('unhandledRejection', onUnhandled);
    }

    expect(escaped).toEqual([]);
  });
});

// archive#3422: survivesCleanup() decides every retention in production, and
// both retention tests drive a fake. This drives the real one against a real
// child, because the defect it exists to avoid is precisely a check that
// reports without looking: destroy() nulls `this.proc`, so reading the pid
// from there answers "gone" for a child that is still running.
describe('ACPProcess.survivesCleanup asks the kernel (#3422)', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'station-acp-survives-'));
  afterAll(() => rmSync(cwd, { recursive: true, force: true }));

  test('reports a live child as surviving even after destroy() nulled its handle', async () => {
    const acpProcess = new ACPProcess({
      command: 'node',
      args: ['-e', 'process.stdin.resume()'],
      cwd,
      createClient: () => ({}) as never,
      logger: {
        warn: () => {},
        info: () => {},
        debug: () => {},
        error: () => {},
      },
      // A destroy that resolves WITHOUT reaping: exactly the shape that made
      // a survivor indistinguishable from a reaped child.
      terminateProcess: async () => {},
    });

    const started = acpProcess.start().catch(() => undefined);
    await Promise.race([started, new Promise((r) => setTimeout(r, 1_500))]);
    const pid = (acpProcess as unknown as { spawnedPid: number | null })
      .spawnedPid;
    expect(pid).toBeGreaterThan(0);

    await acpProcess.destroy();

    // The child was never actually killed, so the honest answer is "surviving".
    await expect(acpProcess.survivesCleanup()).resolves.toBe(true);

    process.kill(pid as number, 'SIGKILL');
    await new Promise((r) => setTimeout(r, 300));
    await expect(acpProcess.survivesCleanup()).resolves.toBe(false);
  });
});

// archive#3441 HIGH-2: `spawnedBirth` unread-or-null makes survivesCleanup()
// fall back to "surviving" (the pre-#3441 EPERM-forever shape) -- reachable
// not just via a deliberately deleted assignment but via ANY real `ps`
// failure/timeout, since `lookupProcessBirthFingerprintAsync` returns null on
// either. A real spawn must therefore record a real, non-null fingerprint;
// deleting that write (`this.spawnedBirth = null`) is caught by this test
// alone, and stayed green against all 39 pre-fix tests because none of them
// asserted on `spawnedBirth` itself -- only on the DECISION `survivesCleanup`
// derives from it, using injected fixtures that never exercised a real spawn.
describe('ACPProcess.start records a real spawnedBirth (station#3441 HIGH-2)', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'station-acp-birth-'));
  afterAll(() => rmSync(cwd, { recursive: true, force: true }));

  test('a real spawn records a non-null birth fingerprint', async () => {
    const acpProcess = new ACPProcess({
      command: 'node',
      args: ['-e', 'process.stdin.resume()'],
      cwd,
      createClient: () => ({}) as never,
      logger: { warn: () => {}, debug: () => {} },
      terminateProcess: async () => {},
    });

    const started = acpProcess.start().catch(() => undefined);
    await Promise.race([started, new Promise((r) => setTimeout(r, 1_500))]);
    const { spawnedPid, spawnedBirth } = acpProcess as unknown as {
      spawnedPid: number | null;
      spawnedBirth: string | null;
    };
    expect(spawnedPid).toBeGreaterThan(0);
    expect(
      spawnedBirth,
      'a real spawn must record a real birth fingerprint, not null',
    ).not.toBeNull();

    await acpProcess.destroy();
  });
});

// archive#3441: survivesCleanup() used to treat "some process answers signal
// 0 (or EPERM) at this pid" as "the process I spawned is surviving". A
// recycled pid is now decided by comparing the CURRENT birth fingerprint
// against the one recorded at spawn -- the same three-state probe
// `process-utils.ts`'s `ownerIsGone`/orphan sweep already use, injected here
// via `probeIdentity` so every branch is reachable WITHOUT signalling a real
// foreign pid (per the fault-injection constraint: signal-sending code is
// dangerous to test against a live foreign process).
describe('ACPProcess.survivesCleanup decides identity, not just liveness (#3441)', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'station-acp-identity-'));
  afterAll(() => rmSync(cwd, { recursive: true, force: true }));

  function makeProcessWithFakePid(
    pid: number,
    birth: string | null,
    probeIdentity: () => ExactProcessIdentityProbe,
  ): ACPProcess {
    // archive#3441 MEDIUM-2: `probeIdentity` is now async-shaped
    // (`AsyncProcessIdentityProbe`); wrapping the sync fixtures below in
    // `Promise.resolve` keeps every fixture's shape unchanged.
    const asyncProbeIdentity = async () => probeIdentity();
    const acpProcess = new ACPProcess({
      command: 'node',
      cwd,
      createClient: () => ({}) as never,
      logger: { warn: () => {}, debug: () => {} },
      probeIdentity: asyncProbeIdentity,
    });
    // These two fields are only ever written together, at spawn (see
    // start()). Poking them directly here is the same pattern the sibling
    // "asks the kernel" test above uses to read `spawnedPid` -- it lets this
    // suite drive every identity outcome without an actual spawn (and
    // without a real recycled/foreign pid, which cannot be manufactured on
    // demand).
    (
      acpProcess as unknown as {
        spawnedPid: number | null;
        spawnedBirth: string | null;
      }
    ).spawnedPid = pid;
    (
      acpProcess as unknown as {
        spawnedPid: number | null;
        spawnedBirth: string | null;
      }
    ).spawnedBirth = birth;
    return acpProcess;
  }

  test('a dead pid does not survive', async () => {
    const acpProcess = makeProcessWithFakePid(4242, 'darwin:lstart:1', () => ({
      state: 'dead',
    }));
    await expect(acpProcess.survivesCleanup()).resolves.toBe(false);
  });

  test('a matching birth fingerprint survives -- the genuine still-running child', async () => {
    const acpProcess = makeProcessWithFakePid(4242, 'darwin:lstart:1', () => ({
      state: 'exact',
      identity: { pid: 4242, start: 'darwin:lstart:1' },
    }));
    await expect(acpProcess.survivesCleanup()).resolves.toBe(true);
  });

  test('a recycled pid whose birth no longer matches does NOT survive -- the EPERM-forever case', async () => {
    // This is the shape a foreign, unsignalable process actually takes: it
    // answers a birth-time query (ps/procfs do not require signal
    // permission) with a DIFFERENT start time than the child this object
    // spawned. Pre-#3441, `kill(pid, 0)` throwing EPERM alone was enough to
    // retain this pid forever, re-destroying it every cycle.
    const acpProcess = makeProcessWithFakePid(4242, 'darwin:lstart:1', () => ({
      state: 'exact',
      identity: { pid: 4242, start: 'darwin:lstart:999' },
    }));
    await expect(acpProcess.survivesCleanup()).resolves.toBe(false);
  });

  test('an alive pid whose fingerprint cannot be read retains rather than guesses', async () => {
    const acpProcess = makeProcessWithFakePid(4242, 'darwin:lstart:1', () => ({
      state: 'unavailable',
    }));
    await expect(acpProcess.survivesCleanup()).resolves.toBe(true);
  });

  test('no birth recorded at spawn cannot rule out reuse, so it retains', async () => {
    const acpProcess = makeProcessWithFakePid(4242, null, () => ({
      state: 'exact',
      identity: { pid: 4242, start: 'darwin:lstart:1' },
    }));
    await expect(acpProcess.survivesCleanup()).resolves.toBe(true);
  });

  test('no pid recorded never survives', async () => {
    const acpProcess = new ACPProcess({
      command: 'node',
      cwd,
      createClient: () => ({}) as never,
      logger: { warn: () => {}, debug: () => {} },
      probeIdentity: async () => {
        throw new Error('must not probe identity with no pid to ask about');
      },
    });
    await expect(acpProcess.survivesCleanup()).resolves.toBe(false);
  });

  // archive#3441 LOW-3: `probeIdentity` is injectable and the default never
  // rejects, but nothing previously guarded a REJECTING one -- a rejection
  // propagated straight out of `survivesCleanup()`, through `attemptCleanup`
  // and `retryPendingCleanup` (acp-probe.ts), falsifying
  // `retryPendingCleanup`'s own docblock claim that cleanup "does not throw"
  // (its second call inside `dispose()` is unguarded). Fail closed: a probe
  // that cannot answer must be read the same as `'unavailable'` --
  // "surviving", never thrown.
  test('survivesCleanup() fails closed -- a rejecting identity probe is retained, not thrown (station#3441 LOW-3)', async () => {
    const acpProcess = makeProcessWithFakePid(4242, 'darwin:lstart:1', () => {
      throw new Error('probe transport down');
    });
    await expect(acpProcess.survivesCleanup()).resolves.toBe(true);
  });
});
