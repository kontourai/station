import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeExactProcessIdentity as realProbe } from '@kontourai/station-shared/process-identity';
import { describe, expect, test } from 'vitest';
import {
  destroyProcessWithEscalation,
  type EscalatableProcess,
} from '../../acp/acp-probe.js';
import { ACPProcess } from '../../acp/acp-process.js';
import {
  evaluateRegistryDirTrust,
  forgetOwnedProcess,
  type ProcessIdentityProbe,
  recordOwnedProcess,
  resolveOwnedProcessOwner,
  spawnOwnedChild,
  sweepOrphanedOwnedProcesses,
} from '../process-utils.js';

/**
 * station#1863 — the load-bearing tests.
 *
 * The founding finding of this repo is that a guardrail whose rejection path
 * has never executed is unproven. #1863 exists BECAUSE the cleanup path was
 * never exercised against a SIGKILLed parent. These tests do exactly that:
 * they spawn REAL detached processes, SIGKILL the owner, and assert the sweep
 * reaps the orphaned engine AND its grandchild. No mocks.
 *
 * Every process these tests spawn is tracked and cleaned up in `finally`, so
 * nothing leaks to the host even on failure.
 */

function isAlive(pid: number | undefined | null): boolean {
  if (pid == null) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Group-SIGKILL a whole process group, best-effort, for test cleanup. */
function reapGroup(pid: number): void {
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // Already gone.
  }
}

const fixtureScript = join(__dirname, 'helpers', 'orphan-engine-owner.mjs');

/**
 * Spawn the owner fixture and resolve once it reports its engine pid. The
 * grandchild pid is written to `gcFile` by the fixture.
 */
function spawnOwnerFixture(gcFile: string): {
  owner: ReturnType<typeof spawn>;
  enginePid: Promise<number>;
} {
  const owner = spawn(process.execPath, [fixtureScript, gcFile], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  let buffer = '';
  let resolved = false;
  const enginePid = new Promise<number>((resolve, reject) => {
    owner.stdout!.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const match = buffer.match(/ENGINE_PID=(\d+)/);
      if (match && !resolved) {
        resolved = true;
        resolve(Number(match[1]));
      }
    });
    owner.once('error', reject);
    owner.once('exit', (code) => {
      if (!resolved) reject(new Error(`owner exited early code=${code}`));
    });
  });
  return { owner, enginePid };
}

describe('owned-process reaping (#1863)', () => {
  test('a SIGKILLed owner leaves an orphan the startup sweep reaps — grandchild included', async () => {
    const registryDir = mkdtempSync(join(tmpdir(), 'station-sweep-kill-'));
    const gcFile = join(registryDir, 'grandchild.pid');
    const { owner, enginePid } = spawnOwnerFixture(gcFile);

    // Wait until the owner has spawned its detached engine + grandchild.
    const engine = await enginePid;
    // The fixture writes the grandchild pid to a file once the engine reports
    // it; poll briefly for it to appear.
    let grandchild: number | null = null;
    try {
      for (let i = 0; i < 200 && grandchild === null; i++) {
        try {
          grandchild = Number(readFileSync(gcFile, 'utf8').trim());
        } catch {
          await new Promise((r) => setTimeout(r, 10));
        }
      }
      expect(
        grandchild,
        'grandchild pid must be reported by the fixture',
      ).not.toBeNull();
      const gc = grandchild!;

      // Record the registry entry the way a real Station would: owner = the
      // owner fixture's pid, engine = the detached child. The owner is alive at
      // record time, so its birth fingerprint is captured.
      recordOwnedProcess(
        engine,
        resolveOwnedProcessOwner(
          {
            STATION_INSTANCE_ID: 'sweep-kill-test',
            STATION_BOOT_ID: 'boot-kill',
          },
          owner.pid!,
        ),
        'fake-engine',
        { registryDir },
      );

      // Precondition: both engine and grandchild are alive and detached.
      expect(isAlive(engine)).toBe(true);
      expect(isAlive(gc)).toBe(true);

      // THE PROPERTY: SIGKILL the owner so it runs NO cleanup.
      try {
        process.kill(owner.pid!, 'SIGKILL');
      } catch {
        // Owner may have already exited.
      }
      // Reap the owner zombie.
      await new Promise<void>((resolve) => owner.once('exit', () => resolve()));

      // The engine + grandchild survived their owner being SIGKILLed — that is
      // the defect. Nothing in the dead owner would ever reclaim them.
      expect(isAlive(engine)).toBe(true);
      expect(isAlive(gc)).toBe(true);
      expect(isAlive(owner.pid)).toBe(false);

      // The startup sweep is what reclaims them.
      const result = await sweepOrphanedOwnedProcesses({ registryDir });

      expect(result.reaped).toContain(engine);
      expect(result.retained).toBe(0);

      // Give the group a moment to die after SIGKILL.
      for (let i = 0; i < 100 && (isAlive(engine) || isAlive(gc)); i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(isAlive(engine)).toBe(false);
      // Grandchild covered: the group kill reaped it too.
      expect(isAlive(gc)).toBe(false);
    } finally {
      // station#1863 fix round 3: this test previously had NO finally, so a
      // failure before the sweep (e.g. the grandchild-pid poll, or any
      // precondition assertion) left the detached engine + grandchild
      // reparented to init — the exact orphan this suite exists to prevent.
      // Reap every fixture unconditionally, and never trust the sweep to have
      // run.
      try {
        process.kill(owner.pid!, 'SIGKILL');
      } catch {
        // already gone
      }
      // Only await exit if it has not already been reaped in the body —
      // registering `once('exit')` after the process has already emitted it
      // would hang forever.
      if (owner.exitCode === null && owner.signalCode === null) {
        await new Promise<void>((resolve) =>
          owner.once('exit', () => resolve()),
        );
      }
      reapGroup(engine);
      if (grandchild !== null) reapGroup(grandchild);
      rmSync(registryDir, { recursive: true, force: true });
    }
  });

  test('the sweep never touches a live owner’s engine (sibling-safety)', async () => {
    const registryDir = mkdtempSync(join(tmpdir(), 'station-sweep-live-'));
    const gcFile = join(registryDir, 'grandchild.pid');
    const { owner, enginePid } = spawnOwnerFixture(gcFile);
    const engine = await enginePid;
    let grandchild: number | null = null;
    for (let i = 0; i < 200 && grandchild === null; i++) {
      try {
        grandchild = Number(readFileSync(gcFile, 'utf8').trim());
      } catch {
        await new Promise((r) => setTimeout(r, 10));
      }
    }
    const gc = grandchild!;
    recordOwnedProcess(
      engine,
      resolveOwnedProcessOwner(
        {
          STATION_INSTANCE_ID: 'sweep-live-test',
          STATION_BOOT_ID: 'boot-live',
        },
        owner.pid!,
      ),
      'fake-engine',
      { registryDir },
    );

    try {
      // The owner is still alive, so a sweep must RETAIN its engine.
      const result = await sweepOrphanedOwnedProcesses({ registryDir });
      expect(result.reaped).toEqual([]);
      expect(result.retained).toBe(1);
      expect(isAlive(engine)).toBe(true);
      expect(isAlive(gc)).toBe(true);
    } finally {
      // Clean up the live owner + its engine group.
      try {
        process.kill(owner.pid!, 'SIGKILL');
      } catch {
        // already gone
      }
      await new Promise<void>((resolve) => owner.once('exit', () => resolve()));
      reapGroup(engine);
      for (let i = 0; i < 100 && (isAlive(engine) || isAlive(gc)); i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      rmSync(registryDir, { recursive: true, force: true });
    }
  });

  test('a recycled engine pid is not harmed: stale record removed, live pid left alone', async () => {
    const registryDir = mkdtempSync(join(tmpdir(), 'station-sweep-recycle-'));
    // A genuinely-dead owner pid: spawn a throwaway, kill it, wait for exit.
    const dead = spawn(process.execPath, ['-e', 'process.exit(0)']);
    await new Promise<void>((resolve) => dead.once('exit', () => resolve()));
    // A "live engine" that should NOT be killed (its pid was reused after the
    // real orphan died). Spawn a plain child and keep it alive.
    const survivor = spawn(
      process.execPath,
      ['-e', 'setInterval(()=>{},86400000)'],
      {
        stdio: 'ignore',
      },
    );
    try {
      expect(isAlive(dead.pid)).toBe(false);
      expect(isAlive(survivor.pid)).toBe(true);
      // Write a record whose owner is demonstrably dead and whose engine birth
      // does NOT match the survivor — simulating a pid recycled after the real
      // orphan exited.
      const record = {
        schemaVersion: 1,
        enginePid: survivor.pid,
        engineBirth: 'definitely-not-the-current-birth',
        owner: {
          pid: dead.pid,
          instanceId: 'recycle-test',
          bootId: 'boot-recycle',
          birth: null,
        },
        command: 'fake-engine',
        spawnedAt: new Date().toISOString(),
      };
      writeFileSync(
        join(registryDir, `engine-${survivor.pid}.json`),
        `${JSON.stringify(record)}\n`,
        { mode: 0o600 },
      );

      const result = await sweepOrphanedOwnedProcesses({ registryDir });

      expect(result.reaped).toEqual([]);
      expect(result.recycled).toBe(1);
      // The survivor is untouched.
      expect(isAlive(survivor.pid)).toBe(true);
      expect(result.retained).toBe(0);
    } finally {
      // survivor is non-detached, so kill it by pid (not group) for cleanup.
      try {
        process.kill(survivor.pid!, 'SIGKILL');
      } catch {
        // already gone
      }
      await new Promise<void>((resolve) =>
        survivor.once('exit', () => resolve()),
      );
      rmSync(registryDir, { recursive: true, force: true });
    }
  });

  test('a recycled owner pid is treated as gone: its orphaned engine is reaped', async () => {
    const registryDir = mkdtempSync(
      join(tmpdir(), 'station-sweep-owner-recycle-'),
    );
    // A live process standing in for a "recycled" owner pid: the original
    // owner died and an UNRELATED process now holds the pid. We cannot force a
    // genuine pid recycle, so we fabricate the condition it produces — a live
    // owner.pid whose recorded birth fingerprint no longer matches the process
    // currently holding that pid. That is the exact signal `ownerIsGone` must
    // read as "demonstrably gone" on a long-running host (#1863's scenario:
    // orphans accumulate over hours, owner pids recycle over hours).
    const bystander = spawn(
      process.execPath,
      ['-e', 'setInterval(()=>{},86400000)'],
      { stdio: 'ignore' },
    );
    // A real detached engine child — the orphan left behind by the dead owner.
    const engine = spawn(
      process.execPath,
      ['-e', 'setInterval(()=>{},86400000)'],
      { stdio: 'ignore', detached: true },
    );
    try {
      expect(isAlive(bystander.pid)).toBe(true);
      expect(isAlive(engine.pid)).toBe(true);
      // Record via the real writer so engineBirth matches the live engine (the
      // sweep must get PAST the engine-recycle guard and reach the group kill).
      // The owner is the fabricated mismatch: live pid, wrong birth.
      recordOwnedProcess(
        engine.pid!,
        {
          pid: bystander.pid!,
          instanceId: 'owner-recycle-test',
          bootId: 'boot-owner-recycle',
          birth: 'definitely-not-the-current-owner-birth',
        },
        'fake-engine',
        { registryDir },
      );

      const result = await sweepOrphanedOwnedProcesses({ registryDir });

      // Owner demonstrably gone via birth mismatch -> engine IS reaped.
      expect(result.reaped).toContain(engine.pid);
      expect(result.retained).toBe(0);
      // The bystander (unrelated process holding the recycled pid) is untouched.
      expect(isAlive(bystander.pid)).toBe(true);

      for (let i = 0; i < 100 && isAlive(engine.pid); i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(isAlive(engine.pid)).toBe(false);
    } finally {
      try {
        process.kill(bystander.pid!, 'SIGKILL');
      } catch {
        // already gone
      }
      await new Promise<void>((resolve) =>
        bystander.once('exit', () => resolve()),
      );
      reapGroup(engine.pid!);
      rmSync(registryDir, { recursive: true, force: true });
    }
  });

  test('forgetOwnedProcess removes a record so a graceful destroy needs no sweep', async () => {
    const registryDir = mkdtempSync(join(tmpdir(), 'station-sweep-forget-'));
    const child = spawn(
      process.execPath,
      ['-e', 'setInterval(()=>{},86400000)'],
      {
        stdio: 'ignore',
        detached: true,
      },
    );
    try {
      recordOwnedProcess(
        child.pid!,
        resolveOwnedProcessOwner({
          STATION_INSTANCE_ID: 'forget-test',
          STATION_BOOT_ID: 'boot-forget',
        }),
        'fake-engine',
        { registryDir },
      );
      forgetOwnedProcess(child.pid!, { registryDir });
      const result = await sweepOrphanedOwnedProcesses({ registryDir });
      expect(result.reaped).toEqual([]);
      expect(result.retained).toBe(0);
    } finally {
      reapGroup(child.pid!);
      await new Promise<void>((resolve) => child.once('exit', () => resolve()));
      rmSync(registryDir, { recursive: true, force: true });
    }
  });
});

describe('ACPProcess escalation (#1863)', () => {
  test('ACPProcess.forceGroupKill reaps a registered signal-resistant child and releases the registry', async () => {
    const registryDir = mkdtempSync(join(tmpdir(), 'station-acp-fgk-'));
    // Spawn a real detached, signal-resistant child through the owned-process
    // primitive (so it is registered), then attach it to an ACPProcess the way
    // `start()` would. We bypass `start()` because it requires a real ACP
    // handshake peer, which is irrelevant to the group-kill property under test.
    const { proc, release } = spawnOwnedChild(
      process.execPath,
      ['-e', "process.on('SIGTERM',()=>{}); setInterval(()=>{}, 86400000)"],
      { stdio: 'ignore', registryDir },
    );
    const acp = new ACPProcess({
      command: process.execPath,
      cwd: registryDir,
      createClient: () => ({}) as any,
      logger: { warn: () => {}, debug: () => {} },
    });
    // Attach the spawned child the way start() does (proc + spawnedPid +
    // release handle). `spawnedPid` is what the escalation reads (#3463).
    (acp as any).proc = proc;
    (acp as any).spawnedPid = proc.pid ?? null;
    (acp as any).releaseOwnedChild = release;

    try {
      expect(proc.pid).toBeTypeOf('number');
      expect(isAlive(proc.pid)).toBe(true);

      // station#3441 HIGH-1: forceGroupKill() now waits to CONFIRM the group
      // is gone before releasing the registry record, so its own resolution
      // (not a separately-polled `isAlive`) is the proof.
      await acp.forceGroupKill();

      expect(isAlive(proc.pid)).toBe(false);
      // forceGroupKill confirmed the exit before releasing the record.
      const result = await sweepOrphanedOwnedProcesses({ registryDir });
      expect(result.retained).toBe(0);
      expect(result.reaped).toEqual([]);
    } finally {
      if (proc.pid) reapGroup(proc.pid);
      await acp.destroy().catch(() => undefined);
      rmSync(registryDir, { recursive: true, force: true });
    }
  });

  // station#3441 HIGH-1: the pre-fix `forceGroupKill()` released the registry
  // record unconditionally, on signal delivery alone -- never on confirmed
  // death. Reproduced live against this exact scenario (real spawn, real
  // registry dir, real `destroy()` rejection via `destroyProcessWithEscalation`):
  // the record was gone after attempt 1 of 5 while the child was still alive.
  // This drives the SAME real path -- `destroyProcessWithEscalation` against a
  // real `ACPProcess` with a real registry -- but feeds `probeIdentity` a
  // fixture that never reports `dead`, so the confirm-before-release logic is
  // proven to CONSULT the probe rather than trust the SIGKILL's own success.
  // The real SIGKILL forceGroupKill sends still genuinely kills this
  // (ordinary, real, owned) child -- only the bookkeeping decision is under
  // test, and it is deliberately fed a false answer to see whether it
  // believes the kill or the probe.
  test('a survivor whose group-kill cannot be confirmed keeps its registry record (station#3441 HIGH-1)', async () => {
    const registryDir = mkdtempSync(join(tmpdir(), 'station-acp-unconfirmed-'));
    const { proc, release } = spawnOwnedChild(
      process.execPath,
      ['-e', "process.on('SIGTERM',()=>{}); setInterval(()=>{}, 86400000)"],
      { stdio: 'ignore', registryDir },
    );
    const acp = new ACPProcess({
      command: process.execPath,
      cwd: registryDir,
      createClient: () => ({}) as any,
      logger: { warn: () => {}, debug: () => {} },
      // destroy() must reject so destroyProcessWithEscalation's catch branch
      // (forceGroupKill) fires -- the exact shape the live reproduction used.
      terminateProcess: async () => {
        throw new Error('cannot terminate');
      },
      // Never reports the pid dead, regardless of the real OS state.
      probeIdentity: async () => ({
        state: 'exact',
        identity: { pid: proc.pid as number, start: 'never-matches-dead' },
      }),
    });
    (acp as any).proc = proc;
    // `spawnedPid` is what forceGroupKill() reads (station#3463) -- without
    // it the escalation declines before ever consulting probeIdentity, and
    // the record surviving would prove nothing about confirm-before-release.
    (acp as any).spawnedPid = proc.pid ?? null;
    (acp as any).releaseOwnedChild = release;
    const recordFile = join(registryDir, `engine-${proc.pid}.json`);

    try {
      expect(proc.pid).toBeTypeOf('number');
      expect(existsSync(recordFile)).toBe(true);

      let missed: unknown;
      await destroyProcessWithEscalation(acp, 500, (error) => {
        missed = error;
      });
      expect(
        missed,
        'destroy() rejected and the escalation fired',
      ).toBeDefined();

      // The child is actually dead (a real SIGKILL was sent to a real,
      // ordinary, killable process) -- only the registry record's survival is
      // under test.
      for (let i = 0; i < 100 && isAlive(proc.pid); i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(isAlive(proc.pid)).toBe(false);

      expect(
        existsSync(recordFile),
        'forceGroupKill released the registry record without confirming the kill -- the sweep backstop the docblock claims no longer has a record to act on',
      ).toBe(true);
    } finally {
      if (proc.pid) reapGroup(proc.pid);
      rmSync(registryDir, { recursive: true, force: true });
    }
  });

  // station#3441 MEDIUM-4: the `MAX_CLEANUP_RETRY_ATTEMPTS` docblock
  // (acp-probe.ts) claimed "≈25s per reconnect when every survivor's destroy
  // rejects (never confirms)" -- a figure never re-derived after the R4 fix
  // round. This drives the IDENTICAL real scenario the sibling HIGH-1 test
  // above does (same fixture shape, same rigged never-dead probeIdentity, same
  // instant-rejecting terminateProcess) and measures wall time, so the
  // docblock's corrected text is backed by a receipt, not a copied number.
  test('MEDIUM-4: measures the code-attributable cost of one unconfirmable escalation attempt', async () => {
    const registryDir = mkdtempSync(join(tmpdir(), 'station-acp-timing-'));
    const { proc, release } = spawnOwnedChild(
      process.execPath,
      ['-e', "process.on('SIGTERM',()=>{}); setInterval(()=>{}, 86400000)"],
      { stdio: 'ignore', registryDir },
    );
    const acp = new ACPProcess({
      command: process.execPath,
      cwd: registryDir,
      createClient: () => ({}) as any,
      logger: { warn: () => {}, debug: () => {} },
      // Rejects immediately -- models "destroy() REJECTS QUICKLY", the mode
      // the corrected docblock text distinguishes from the #3422-shaped hang
      // (destroy never settling at all, ~13s/attempt, already validated).
      terminateProcess: async () => {
        throw new Error('cannot terminate');
      },
      // Never reports the pid dead, regardless of the real OS state -- so the
      // confirm-wait poll always runs its full window.
      probeIdentity: async () => ({
        state: 'exact',
        identity: { pid: proc.pid as number, start: 'never-matches-dead' },
      }),
    });
    (acp as any).proc = proc;
    // `spawnedPid` is what forceGroupKill() reads (station#3463) -- without
    // it the escalation declines instantly and the measured "elapsed" would
    // be near-zero, not the confirm-wait cost under test.
    (acp as any).spawnedPid = proc.pid ?? null;
    (acp as any).releaseOwnedChild = release;
    const recordFile = join(registryDir, `engine-${proc.pid}.json`);

    try {
      const start = Date.now();
      await destroyProcessWithEscalation(acp, 500, () => {});
      const elapsed = Date.now() - start;

      // Same property the HIGH-1 test proves, re-checked against the exact
      // run this timing measurement comes from.
      expect(existsSync(recordFile)).toBe(true);

      // The measured, code-attributable single-attempt cost: bounded near
      // FORCE_GROUP_KILL_CONFIRM_MS (1000ms) plus the destroy race's own
      // near-instant reject and the near-instant second-destroy race -- NOT
      // the docblock's old ~13s/attempt figure, which models destroy()
      // hanging for the full operationTimeoutMs (a different, validated
      // mode).
      expect(elapsed).toBeGreaterThanOrEqual(900);
      expect(elapsed).toBeLessThan(3000);
    } finally {
      if (proc.pid) reapGroup(proc.pid);
      rmSync(registryDir, { recursive: true, force: true });
    }
  });

  // station#3441 LOW-1: every existing assertion on releaseIfConfirmedGone()
  // was a vi.fn() spy on a mock cast `as unknown as ACPProcess` in
  // acp-probe.test.ts -- that proves attemptCleanup() CALLS something named
  // that, never that a registry record actually disappears. Same
  // real-registryDir, real-spawn, existsSync(recordFile) pattern the HIGH-1
  // and MEDIUM-4 tests above use, so this exercises the method's real body
  // rather than a spy on it.
  test('releaseIfConfirmedGone() actually releases the registry record (station#3441 LOW-1)', () => {
    const registryDir = mkdtempSync(join(tmpdir(), 'station-acp-release-'));
    const { proc, release } = spawnOwnedChild(
      process.execPath,
      ['-e', "process.on('SIGTERM',()=>{}); setInterval(()=>{}, 86400000)"],
      { stdio: 'ignore', registryDir },
    );
    const acp = new ACPProcess({
      command: process.execPath,
      cwd: registryDir,
      createClient: () => ({}) as any,
      logger: { warn: () => {}, debug: () => {} },
    });
    (acp as any).releaseOwnedChild = release;
    const recordFile = join(registryDir, `engine-${proc.pid}.json`);

    try {
      expect(existsSync(recordFile)).toBe(true);

      // The caller (attemptCleanup) has already independently confirmed the
      // process is gone -- this method does not itself check anything, it
      // just performs the release. No signal is sent here; the real child
      // stays alive and is reaped in `finally` like any other fixture.
      acp.releaseIfConfirmedGone();

      expect(existsSync(recordFile)).toBe(false);
    } finally {
      if (proc.pid) reapGroup(proc.pid);
      rmSync(registryDir, { recursive: true, force: true });
    }
  });

  test('destroyProcessWithEscalation reaps the process when destroy misses its deadline', async () => {
    const registryDir = mkdtempSync(join(tmpdir(), 'station-acp-deadline-'));
    // A real detached, signal-resistant child: the escalation's group SIGKILL
    // must reap it after the deadline fires, even though destroy() never
    // settles on its own.
    const { proc, release } = spawnOwnedChild(
      process.execPath,
      ['-e', "process.on('SIGTERM',()=>{}); setInterval(()=>{}, 86400000)"],
      { stdio: 'ignore', registryDir },
    );
    // EscalatableProcess double: destroy() does not settle until the group
    // kill flips `killed` (mimicking a real destroy that converges once the
    // process is dead); forceGroupKill() does the real group kill.
    let killed = false;
    const target: EscalatableProcess = {
      destroy: () =>
        new Promise<void>((resolve) => {
          const poll = () => (killed ? resolve() : setTimeout(poll, 5));
          poll();
        }),
      forceGroupKill: async () => {
        killed = true;
        try {
          process.kill(-proc.pid!, 'SIGKILL');
        } catch {
          // already gone
        }
      },
    };
    let missed: unknown;
    try {
      expect(isAlive(proc.pid)).toBe(true);
      // 20ms deadline — the hanging destroy always misses it, forcing the
      // escalation path under test.
      await destroyProcessWithEscalation(target, 20, (error) => {
        missed = error;
      });
      expect(missed, 'the deadline fired and reported the miss').toBeDefined();
      for (let i = 0; i < 100 && isAlive(proc.pid); i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(isAlive(proc.pid)).toBe(false);
    } finally {
      if (proc.pid) reapGroup(proc.pid);
      release();
      rmSync(registryDir, { recursive: true, force: true });
    }
  });

  test('forceGroupKill still reaps the group AFTER destroy() has returned (#3463)', async () => {
    const registryDir = mkdtempSync(join(tmpdir(), 'station-acp-fgk-post-'));
    // The population this escalation exists for: a child that OUTLIVED its
    // own destroy. `terminateProcess` is a no-op, so destroy() completes
    // "successfully" — setting `destroyed` and NULLING `this.proc` — while the
    // real child is still running. Reading the pid from `this.proc` here
    // declined to act and the engine survived unreaped (station#3463); the
    // escalation must read `spawnedPid`, exactly as survivesCleanup() does.
    const { proc, release } = spawnOwnedChild(
      process.execPath,
      ['-e', "process.on('SIGTERM',()=>{}); setInterval(()=>{}, 86400000)"],
      { stdio: 'ignore', registryDir },
    );
    const warnings: string[] = [];
    const acp = new ACPProcess({
      command: process.execPath,
      cwd: registryDir,
      createClient: () => ({}) as any,
      logger: {
        warn: (message: string) => warnings.push(message),
        debug: () => {},
      },
      terminateProcess: async () => undefined,
    });
    (acp as any).proc = proc;
    (acp as any).spawnedPid = proc.pid ?? null;
    (acp as any).releaseOwnedChild = release;

    try {
      await acp.destroy();
      // destroy() has forgotten the handle, and the child is still there.
      expect((acp as any).proc).toBeNull();
      // station#3441: survivesCleanup() is async on this branch too -- an
      // unawaited call returns a Promise, which is always truthy and would
      // make this assertion vacuous rather than checking the pre-kill state.
      expect(await acp.survivesCleanup()).toBe(true);
      expect(isAlive(proc.pid)).toBe(true);

      // station#3441: forceGroupKill() is async now and its own resolution
      // is what confirms the release -- unawaited, this call races the
      // isAlive poll below against forceGroupKill's internal confirm-wait,
      // and survivesCleanup() could read the pre-release state by accident.
      await acp.forceGroupKill();

      for (let i = 0; i < 100 && isAlive(proc.pid); i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(
        isAlive(proc.pid),
        'the group signal reached the surviving child',
      ).toBe(false);
      expect(await acp.survivesCleanup()).toBe(false);
      // Declining to act is the failure mode under test; it must not happen
      // for a child this object really spawned.
      expect(
        warnings.filter((message) => /no pid recorded/i.test(message)),
      ).toEqual([]);
    } finally {
      if (proc.pid) reapGroup(proc.pid);
      release();
      rmSync(registryDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// station#1863 BLOCKING 1 — refusal tests.
//
// An unvalidated enginePid negated into `process.kill(-pid, 'SIGKILL')` turns
// the sweep into a self-kill (0), a session-kill (1), or an arbitrary kill
// (negative). These tests prove the sweep REFUSES each value and that the
// process that would have been killed is still alive afterwards — not merely
// that a counter incremented.
// ---------------------------------------------------------------------------

describe('sweep refuses invalid engine pids (#1863 BLOCKING 1)', () => {
  // A genuinely-dead owner pid: the enginePid guard fires BEFORE the owner
  // check, so a dead owner is needed to prove the guard (not the owner check)
  // is what stopped the kill.
  async function deadOwnerPid(): Promise<number> {
    const dead = spawn(process.execPath, ['-e', 'process.exit(0)']);
    await new Promise<void>((resolve) => dead.once('exit', () => resolve()));
    return dead.pid!;
  }

  test.each([
    ['zero (self-group kill)', 0],
    ['one (session kill)', 1],
    ['negative (arbitrary pid)', -5],
    ['non-integer', 1.5],
  ])(
    'enginePid %s is corrupt and never reaches a kill',
    async (_label, badPid) => {
      const registryDir = mkdtempSync(join(tmpdir(), 'station-sweep-badpid-'));
      const ownerPid = await deadOwnerPid();
      const record = {
        schemaVersion: 1,
        enginePid: badPid,
        engineBirth: 'irrelevant',
        owner: {
          pid: ownerPid,
          instanceId: 'badpid-test',
          bootId: 'boot-badpid',
          birth: null,
        },
        command: 'fake-engine',
        spawnedAt: new Date().toISOString(),
      };
      writeFileSync(
        join(registryDir, `engine-${badPid}.json`),
        `${JSON.stringify(record)}\n`,
        { mode: 0o600 },
      );

      const result = await sweepOrphanedOwnedProcesses({ registryDir });

      expect(result.corrupt, `enginePid ${badPid} must be corrupt`).toBe(1);
      expect(result.reaped, `enginePid ${badPid} must never be reaped`).toEqual(
        [],
      );
      expect(result.retained).toBe(0);

      rmSync(registryDir, { recursive: true, force: true });
    },
  );

  test('enginePid === process.pid is corrupt and the test process survives', async () => {
    const registryDir = mkdtempSync(join(tmpdir(), 'station-sweep-selfpid-'));
    const ownerPid = await deadOwnerPid();
    // A real child sharing OUR process group. If the guard were absent, the
    // sweep would `process.kill(-process.pid, 'SIGKILL')` and this child would
    // die alongside us.
    const companion = spawn(
      process.execPath,
      ['-e', 'setInterval(()=>{},86400000)'],
      { stdio: 'ignore' },
    );
    try {
      const record = {
        schemaVersion: 1,
        enginePid: process.pid,
        engineBirth: 'irrelevant',
        owner: {
          pid: ownerPid,
          instanceId: 'selfpid-test',
          bootId: 'boot-selfpid',
          birth: null,
        },
        command: 'fake-engine',
        spawnedAt: new Date().toISOString(),
      };
      writeFileSync(
        join(registryDir, `engine-${process.pid}.json`),
        `${JSON.stringify(record)}\n`,
        { mode: 0o600 },
      );

      expect(isAlive(companion.pid)).toBe(true);
      const result = await sweepOrphanedOwnedProcesses({ registryDir });

      expect(result.corrupt).toBe(1);
      expect(result.reaped).toEqual([]);
      // THE PROPERTY: the companion child — in our process group — survived.
      expect(isAlive(companion.pid)).toBe(true);
      // And so did we.
      expect(isAlive(process.pid)).toBe(true);
    } finally {
      try {
        process.kill(companion.pid!, 'SIGKILL');
      } catch {
        // already gone
      }
      await new Promise<void>((resolve) =>
        companion.once('exit', () => resolve()),
      );
      rmSync(registryDir, { recursive: true, force: true });
    }
  });

  test('a group-kill attempt against 0, 1, or process.pid leaves companion children alive', async () => {
    // Put all three self/session-kill pids in one registry at once. If the
    // guard were absent, the FIRST one (0) would SIGKILL our whole group
    // before the sweep even reached the others.
    const registryDir = mkdtempSync(join(tmpdir(), 'station-sweep-groupkill-'));
    const ownerPid = await deadOwnerPid();
    const companion = spawn(
      process.execPath,
      ['-e', 'setInterval(()=>{},86400000)'],
      { stdio: 'ignore' },
    );
    try {
      for (const badPid of [0, 1, process.pid]) {
        const record = {
          schemaVersion: 1,
          enginePid: badPid,
          engineBirth: 'irrelevant',
          owner: {
            pid: ownerPid,
            instanceId: 'groupkill-test',
            bootId: 'boot-groupkill',
            birth: null,
          },
          command: 'fake-engine',
          spawnedAt: new Date().toISOString(),
        };
        writeFileSync(
          join(registryDir, `engine-${badPid}.json`),
          `${JSON.stringify(record)}\n`,
          { mode: 0o600 },
        );
      }

      expect(isAlive(companion.pid)).toBe(true);
      const result = await sweepOrphanedOwnedProcesses({ registryDir });

      expect(result.corrupt).toBe(3);
      expect(result.reaped).toEqual([]);
      // All three would have been catastrophic; the companion proves none fired.
      expect(isAlive(companion.pid)).toBe(true);
      expect(isAlive(process.pid)).toBe(true);
    } finally {
      try {
        process.kill(companion.pid!, 'SIGKILL');
      } catch {
        // already gone
      }
      await new Promise<void>((resolve) =>
        companion.once('exit', () => resolve()),
      );
      rmSync(registryDir, { recursive: true, force: true });
    }
  });

  test('engineBirth: null against a live pid is retained, not killed', async () => {
    // The fail-open defect: a null engineBirth used to skip the identity check
    // and fall through to the kill. Now: cannot confirm identity ⇒ retain.
    const registryDir = mkdtempSync(join(tmpdir(), 'station-sweep-nullbirth-'));
    const dead = spawn(process.execPath, ['-e', 'process.exit(0)']);
    await new Promise<void>((resolve) => dead.once('exit', () => resolve()));
    const survivor = spawn(
      process.execPath,
      ['-e', 'setInterval(()=>{},86400000)'],
      { stdio: 'ignore' },
    );
    try {
      const record = {
        schemaVersion: 1,
        enginePid: survivor.pid,
        engineBirth: null,
        owner: {
          pid: dead.pid!,
          instanceId: 'nullbirth-test',
          bootId: 'boot-nullbirth',
          birth: null,
        },
        command: 'fake-engine',
        spawnedAt: new Date().toISOString(),
      };
      writeFileSync(
        join(registryDir, `engine-${survivor.pid}.json`),
        `${JSON.stringify(record)}\n`,
        { mode: 0o600 },
      );

      const result = await sweepOrphanedOwnedProcesses({ registryDir });

      expect(result.reaped).toEqual([]);
      expect(result.retained).toBe(1);
      // THE PROPERTY: the survivor is still alive.
      expect(isAlive(survivor.pid)).toBe(true);
    } finally {
      try {
        process.kill(survivor.pid!, 'SIGKILL');
      } catch {
        // already gone
      }
      await new Promise<void>((resolve) =>
        survivor.once('exit', () => resolve()),
      );
      rmSync(registryDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// station#1863 BLOCKING 2 — registry trust tests.
//
// A predictable registry directory with default mode lets a co-resident
// process (or a different user on a shared /tmp) plant a record that
// weaponizes the kill. The sweep and the writer must both refuse an
// untrusted directory.
// ---------------------------------------------------------------------------

describe('registry directory trust (#1863 BLOCKING 2)', () => {
  test('a too-permissive directory is refused by the sweep', async () => {
    const registryDir = mkdtempSync(join(tmpdir(), 'station-sweep-perms-'));
    const dead = spawn(process.execPath, ['-e', 'process.exit(0)']);
    await new Promise<void>((resolve) => dead.once('exit', () => resolve()));
    const survivor = spawn(
      process.execPath,
      ['-e', 'setInterval(()=>{},86400000)'],
      { stdio: 'ignore' },
    );
    try {
      // Make the directory world-readable (group/other bits set).
      chmodSync(registryDir, 0o755);
      const record = {
        schemaVersion: 1,
        enginePid: survivor.pid,
        engineBirth: 'irrelevant',
        owner: {
          pid: dead.pid!,
          instanceId: 'perms-test',
          bootId: 'boot-perms',
          birth: null,
        },
        command: 'fake-engine',
        spawnedAt: new Date().toISOString(),
      };
      writeFileSync(
        join(registryDir, `engine-${survivor.pid}.json`),
        `${JSON.stringify(record)}\n`,
        { mode: 0o600 },
      );

      const result = await sweepOrphanedOwnedProcesses({ registryDir });

      // Refused: the sweep did not read or act on the planted record. Fix
      // round 3: asserting the FULL zero result (not just reaped/retained) is
      // what gives this test power — without the mode refusal the sweep reads
      // the record and classifies it (recycled, since 'irrelevant' != the
      // survivor's real birth), leaving every other assertion coincidentally
      // green while the directory was in fact read.
      expect(result.reaped).toEqual([]);
      expect(result.corrupt).toBe(0);
      expect(result.retained).toBe(0);
      expect(result.recycled, 'a refused sweep reads no records').toBe(0);
      expect(result.alreadyDead, 'a refused sweep reads no records').toBe(0);
      // THE PROPERTY: the survivor is still alive — the planted record had no
      // effect.
      expect(isAlive(survivor.pid)).toBe(true);
    } finally {
      try {
        process.kill(survivor.pid!, 'SIGKILL');
      } catch {
        // already gone
      }
      await new Promise<void>((resolve) =>
        survivor.once('exit', () => resolve()),
      );
      rmSync(registryDir, { recursive: true, force: true });
    }
  });

  test('recordOwnedProcess refuses to write into a too-permissive directory', () => {
    const registryDir = mkdtempSync(join(tmpdir(), 'station-sweep-write-'));
    try {
      chmodSync(registryDir, 0o755);
      const owner = resolveOwnedProcessOwner({
        STATION_INSTANCE_ID: 'write-test',
        STATION_BOOT_ID: 'boot-write',
      });
      // Should not throw, but also should NOT write a file.
      recordOwnedProcess(99999, owner, 'fake-engine', { registryDir });
      expect(
        existsSync(join(registryDir, 'engine-99999.json')),
        'no file must be written into an untrusted directory',
      ).toBe(false);
    } finally {
      rmSync(registryDir, { recursive: true, force: true });
    }
  });

  test('a fresh directory is created with mode 0700 and trusted', async () => {
    // When we create the directory ourselves, it must be 0700 and usable.
    const registryDir = join(
      mkdtempSync(join(tmpdir(), 'station-sweep-fresh-')),
      'owned',
    );
    try {
      const owner = resolveOwnedProcessOwner({
        STATION_INSTANCE_ID: 'fresh-test',
        STATION_BOOT_ID: 'boot-fresh',
      });
      recordOwnedProcess(99998, owner, 'fake-engine', { registryDir });
      expect(existsSync(join(registryDir, 'engine-99998.json'))).toBe(true);
      // The sweep trusts it (no records to reap, but it runs without refusal).
      const result = await sweepOrphanedOwnedProcesses({ registryDir });
      expect(result.corrupt).toBe(0);
    } finally {
      rmSync(join(registryDir, '..'), { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// station#1863 fix round 3 — fail-closed identity proof.
//
// The 'unavailable' branch (alive pid, fingerprint unreadable) is the branch
// that matters most under the ENOSPC/high-load conditions #1863 targets, and
// the one NO existing test could reach: every process this host spawns has a
// readable birth fingerprint, so the real probe always returns 'exact'. The
// sweep accepts a test-only `probeIdentity` seam so the branch can now be
// exercised BEHAVIOURALLY — the assertion that matters is that a live engine
// is still alive after a sweep, not merely that a counter incremented.
//
// These tests spawn and kill only what they create, and every test passes an
// explicit `registryDir` under tmpdir — never the host-wide production path.
// ---------------------------------------------------------------------------

describe('fail-closed identity: unavailable retains, never reclaims (#1863 fix round 3)', () => {
  test('a live owner whose fingerprint is UNAVAILABLE is retained — its engine is NOT killed', async () => {
    const registryDir = mkdtempSync(
      join(tmpdir(), 'station-sweep-owner-unavail-'),
    );
    // A live owner. Its real birth fingerprint IS readable here (the test host
    // is healthy), so the only way to reach the 'unavailable' branch is the
    // injected probe — which models the transient ps/proc failure that ENOSPC
    // or high load produces.
    const owner = spawn(
      process.execPath,
      ['-e', 'setInterval(()=>{},86400000)'],
      { stdio: 'ignore' },
    );
    // A real detached engine child — the orphan the sweep would kill if the
    // guard were absent.
    const engine = spawn(
      process.execPath,
      ['-e', 'setInterval(()=>{},86400000)'],
      { stdio: 'ignore', detached: true },
    );
    try {
      expect(isAlive(owner.pid)).toBe(true);
      expect(isAlive(engine.pid)).toBe(true);
      // owner.birth is NON-null on purpose: this isolates the
      // `probe.state === 'unavailable'` retain from the `!owner.birth` retain
      // tested below. Were the unavailable guard removed, the code would fall
      // through to `probe.identity.start` on a probe that has no identity and
      // throw — never silently kill.
      recordOwnedProcess(
        engine.pid!,
        {
          pid: owner.pid!,
          instanceId: 'owner-unavail-test',
          bootId: 'boot-owner-unavail',
          birth: 'recorded-owner-birth',
        },
        'fake-engine',
        { registryDir },
      );

      // The owner is alive but its fingerprint cannot be read.
      const probeIdentity: ProcessIdentityProbe = (pid) =>
        pid === owner.pid ? { state: 'unavailable' } : realProbe(pid);

      const result = await sweepOrphanedOwnedProcesses({
        registryDir,
        probeIdentity,
      });

      expect(
        result.retained,
        'an unavailable owner must retain, never reclaim',
      ).toBe(1);
      expect(result.reaped).toEqual([]);
      // THE PROPERTY: the engine is still alive — unavailable retained the fence.
      expect(isAlive(engine.pid)).toBe(true);
      expect(isAlive(owner.pid)).toBe(true);
      // Retain keeps the record in place for a later sweep.
      expect(existsSync(join(registryDir, `engine-${engine.pid}.json`))).toBe(
        true,
      );
    } finally {
      try {
        process.kill(owner.pid!, 'SIGKILL');
      } catch {
        // already gone
      }
      await new Promise<void>((resolve) =>
        owner.once('exit', () => resolve()),
      ).catch(() => undefined);
      reapGroup(engine.pid!);
      rmSync(registryDir, { recursive: true, force: true });
    }
  });

  test('a live owner with NO recorded birth is retained — its engine is NOT killed', async () => {
    const registryDir = mkdtempSync(
      join(tmpdir(), 'station-sweep-owner-nobirth-'),
    );
    const owner = spawn(
      process.execPath,
      ['-e', 'setInterval(()=>{},86400000)'],
      { stdio: 'ignore' },
    );
    const engine = spawn(
      process.execPath,
      ['-e', 'setInterval(()=>{},86400000)'],
      { stdio: 'ignore', detached: true },
    );
    try {
      expect(isAlive(owner.pid)).toBe(true);
      expect(isAlive(engine.pid)).toBe(true);
      // owner.birth is null. The owner pid is alive with a READABLE real birth
      // (the real probe returns 'exact'), so WITHOUT the guard the comparison
      // `realBirth !== null` would be true -> ownerIsGone -> engine killed. The
      // `!owner.birth` retain is the only thing standing between the sweep and
      // that kill. recordOwnedProcess captures the engine's REAL birth, so a
      // guard removal would proceed all the way to the group SIGKILL (not stop
      // at the recycle branch) — the assertion below is a true wrong-kill catch.
      recordOwnedProcess(
        engine.pid!,
        {
          pid: owner.pid!,
          instanceId: 'owner-nobirth-test',
          bootId: 'boot-owner-nobirth',
          birth: null,
        },
        'fake-engine',
        { registryDir },
      );

      const result = await sweepOrphanedOwnedProcesses({ registryDir });

      expect(result.retained, 'a null owner.birth must retain').toBe(1);
      expect(result.reaped).toEqual([]);
      expect(result.recycled, 'must not be misclassified as a recycle').toBe(0);
      // THE PROPERTY: the engine is still alive.
      expect(isAlive(engine.pid)).toBe(true);
      expect(isAlive(owner.pid)).toBe(true);
    } finally {
      try {
        process.kill(owner.pid!, 'SIGKILL');
      } catch {
        // already gone
      }
      await new Promise<void>((resolve) =>
        owner.once('exit', () => resolve()),
      ).catch(() => undefined);
      reapGroup(engine.pid!);
      rmSync(registryDir, { recursive: true, force: true });
    }
  });

  test('a live engine whose fingerprint is UNAVAILABLE is retained, not killed', async () => {
    const registryDir = mkdtempSync(
      join(tmpdir(), 'station-sweep-engine-unavail-'),
    );
    // A genuinely-dead owner: ownerIsGone must return true so the sweep reaches
    // the engine identity check — that is where the unavailable retain under
    // test lives.
    const dead = spawn(process.execPath, ['-e', 'process.exit(0)']);
    await new Promise<void>((resolve) => dead.once('exit', () => resolve()));
    const engine = spawn(
      process.execPath,
      ['-e', 'setInterval(()=>{},86400000)'],
      { stdio: 'ignore', detached: true },
    );
    const recordFile = join(registryDir, `engine-${engine.pid}.json`);
    try {
      expect(isAlive(dead.pid)).toBe(false);
      expect(isAlive(engine.pid)).toBe(true);
      // recordOwnedProcess captures the engine's real (non-null) birth, so the
      // `!record.engineBirth` guard does NOT mask the branch under test.
      recordOwnedProcess(
        engine.pid!,
        {
          pid: dead.pid!,
          instanceId: 'engine-unavail-test',
          bootId: 'boot-engine-unavail',
          birth: null,
        },
        'fake-engine',
        { registryDir },
      );

      // The dead owner passes through the real probe -> 'dead' -> gone. The
      // live engine is alive but its fingerprint cannot be read -> UNAVAILABLE.
      const probeIdentity: ProcessIdentityProbe = (pid) =>
        pid === engine.pid ? { state: 'unavailable' } : realProbe(pid);

      const result = await sweepOrphanedOwnedProcesses({
        registryDir,
        probeIdentity,
      });

      expect(
        result.retained,
        'an unavailable engine must be retained, never killed',
      ).toBe(1);
      expect(result.reaped).toEqual([]);
      expect(
        result.alreadyDead,
        'must not be misclassified as already dead',
      ).toBe(0);
      // THE PROPERTY: the engine is still alive.
      expect(isAlive(engine.pid)).toBe(true);
      // Retain (not alreadyDead) keeps the record on disk for a later sweep.
      expect(existsSync(recordFile)).toBe(true);
    } finally {
      reapGroup(engine.pid!);
      rmSync(registryDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// station#1863 fix round 3 — registry trust predicate (BLOCKING 2, uid axis).
//
// The foreign-OWNER (uid) refusal gates an arbitrary group-SIGKILL, but it
// cannot be exercised against a real foreign-owned directory without root (a
// test cannot create a directory owned by another uid). The integrated
// `registryDirIsTrustworthy` now delegates its decision to the pure
// `evaluateRegistryDirTrust` predicate, so the uid branch is unit-testable
// without root. The existing mode-refusal integration test (above) proves the
// delegation wiring is live; these tests prove each decision branch.
// ---------------------------------------------------------------------------

describe('registry trust predicate (#1863 BLOCKING 2 uid refusal)', () => {
  test('a directory owned by another uid is untrusted (foreign-owner)', () => {
    const reason = evaluateRegistryDirTrust(
      { isDirectory: () => true, uid: 502, mode: 0o700 },
      501,
    );
    expect(reason?.kind).toBe('foreign-owner');
  });

  test('a directory owned by us passes the uid axis', () => {
    expect(
      evaluateRegistryDirTrust(
        { isDirectory: () => true, uid: 501, mode: 0o700 },
        501,
      ),
    ).toBeNull();
  });

  test('on a platform without uids (ourUid undefined), uid is not checked', () => {
    // Windows has no getuid(); the uid axis is skipped so the check degrades to
    // directory + mode only, never a false foreign-owner refusal.
    expect(
      evaluateRegistryDirTrust(
        { isDirectory: () => true, uid: 0, mode: 0o700 },
        undefined,
      ),
    ).toBeNull();
  });

  test('a too-permissive mode is untrusted (too-permissive)', () => {
    const reason = evaluateRegistryDirTrust(
      { isDirectory: () => true, uid: 501, mode: 0o755 },
      501,
    );
    expect(reason?.kind).toBe('too-permissive');
  });

  test('a non-directory path is untrusted (not-directory)', () => {
    const reason = evaluateRegistryDirTrust(
      { isDirectory: () => false, uid: 501, mode: 0o700 },
      501,
    );
    expect(reason?.kind).toBe('not-directory');
  });
});
