import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test, vi } from 'vitest';
import { ACPProcess } from '../acp-process.js';

/**
 * station#3422: orphaned engine processes accumulated under a LIVE Station —
 * 21 of them on one host, 12 belonging to the probing instance — and nothing
 * anywhere said a reap had failed. `forceGroupKill` is the escalation of last
 * resort, and both of its exits were silent: a missing pid returned as though
 * there were nothing to kill, and every `kill` error was caught under a comment
 * asserting "the group already exited", which is a conclusion the catch cannot
 * derive. ESRCH derives it; EPERM and friends do not.
 *
 * Real processes, no mocks — matching the sibling spawn-failure suite, and for
 * the same reason: the defect is in what actually happens to a real child.
 */
describe('ACPProcess.forceGroupKill reports what it did (#3422)', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'station-acp-groupkill-'));
  afterAll(() => rmSync(cwd, { recursive: true, force: true }));

  function loggerSpy() {
    const warnings: Array<{ message: string; data?: unknown }> = [];
    return {
      warnings,
      logger: {
        warn: (message: string, data?: unknown) =>
          warnings.push({ message, data }),
        info: () => {},
        debug: () => {},
        error: () => {},
      },
    };
  }

  test('declining to act because no pid was recorded is reported, not silent', async () => {
    const { warnings, logger } = loggerSpy();
    // Never started: there is no child, so nothing can be killed. That is
    // exactly the case where an unreaped engine would go unnoticed.
    const acpProcess = new ACPProcess({
      command: 'node',
      args: ['-e', 'process.stdin.resume()'],
      cwd,
      createClient: () => ({}) as never,
      logger,
    });

    // station#3441 LOW-2: `forceGroupKill()` is async now -- unawaited, this
    // assertion would run before the method's own (synchronous-today, but
    // not guaranteed) body finishes, and any future `await` inserted before
    // this warning would make the assertion pass or fail by accident.
    await acpProcess.forceGroupKill();

    expect(
      warnings.some((entry) => /no pid recorded/i.test(entry.message)),
    ).toBe(true);
  });

  test('a kill failure the code cannot read as "already gone" is reported', async () => {
    const { warnings, logger } = loggerSpy();
    const acpProcess = new ACPProcess({
      command: 'node',
      args: ['-e', 'process.stdin.resume()'],
      cwd,
      createClient: () => ({}) as never,
      logger,
    });
    // Attach a pid directly rather than spawning: this asserts the CLASSIFYING
    // branch, and a real signal's outcome depends on the runner's own process
    // group. `spawnedPid` is what `start()` records and what the escalation
    // reads (station#3463); the sibling reaping suite sets it the same way.
    (acpProcess as unknown as { spawnedPid: number }).spawnedPid = 424242;
    // station#3441 MEDIUM-1: a registered release handle, so this test can
    // prove the EPERM branch never releases the registry record -- the exact
    // defect class HIGH-1 was raised for (a record released for a kill that
    // never happened).
    const releaseOwnedChild = vi.fn();
    (
      acpProcess as unknown as { releaseOwnedChild: (() => void) | null }
    ).releaseOwnedChild = releaseOwnedChild;
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((): never => {
      throw Object.assign(new Error('operation not permitted'), {
        code: 'EPERM',
      });
    });

    try {
      await acpProcess.forceGroupKill();
    } finally {
      killSpy.mockRestore();
    }

    const failure = warnings.find((entry) =>
      /group kill failed/i.test(entry.message),
    );
    expect(failure).toBeDefined();
    expect(failure?.data).toMatchObject({ code: 'EPERM', pid: 424242 });
    // station#3441 MEDIUM-1: the signal was never delivered -- nothing may
    // release the record on this path.
    expect(releaseOwnedChild).not.toHaveBeenCalled();
  });

  test('a group that is genuinely gone stays quiet', async () => {
    const { warnings, logger } = loggerSpy();
    const acpProcess = new ACPProcess({
      command: 'node',
      args: ['-e', 'process.stdin.resume()'],
      cwd,
      createClient: () => ({}) as never,
      logger,
    });
    (acpProcess as unknown as { spawnedPid: number }).spawnedPid = 424243;
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((): never => {
      throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
    });

    try {
      await acpProcess.forceGroupKill();
    } finally {
      killSpy.mockRestore();
    }

    // Every ordinary destroy reaches here after the child has exited; warning
    // on that would bury the real failures this change exists to surface.
    expect(
      warnings.some((entry) => /group kill failed/i.test(entry.message)),
    ).toBe(false);
  });

  // station#3441 MEDIUM-2: the confirm budget (`FORCE_GROUP_KILL_CONFIRM_MS`,
  // acp-process.ts, not exported) was bound by no test -- mutating it from
  // 1000 to 0 left the whole suite green. Pin the OBSERVABLE consequence: an
  // unconfirmable kill waits roughly the budget before giving up, and never
  // releases the registry record while unconfirmed.
  test('an unconfirmable kill waits about the confirm budget before giving up (station#3441 MEDIUM-2)', async () => {
    const { logger } = loggerSpy();
    const releaseOwnedChild = vi.fn();
    const acpProcess = new ACPProcess({
      command: 'node',
      args: ['-e', 'process.stdin.resume()'],
      cwd,
      createClient: () => ({}) as never,
      logger,
      // Never reports the pid dead -- the signal "succeeds" (no throw) but
      // confirmation never arrives, forcing the full poll window.
      probeIdentity: async () => ({
        state: 'exact',
        identity: { pid: 424244, start: 'never-matches-dead' },
      }),
    });
    (acpProcess as unknown as { spawnedPid: number }).spawnedPid = 424244;
    (
      acpProcess as unknown as { releaseOwnedChild: (() => void) | null }
    ).releaseOwnedChild = releaseOwnedChild;
    // Simulate a signal that is accepted without error (no ESRCH/EPERM), so
    // forceGroupKill falls through to the confirm-wait poll.
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((): true => {
      return true;
    });

    const start = Date.now();
    try {
      await acpProcess.forceGroupKill();
    } finally {
      killSpy.mockRestore();
    }
    const elapsed = Date.now() - start;

    // Bound BOTH directions: too fast means the budget was not honored
    // (station#3441 MEDIUM-2's injection D: 1000 -> 0), too slow means it grew
    // unbounded. Neither is hardcoded to the literal 1000ms constant so the
    // assertion survives a deliberate, disclosed change to the budget itself.
    expect(elapsed).toBeGreaterThanOrEqual(900);
    expect(elapsed).toBeLessThan(3000);
    expect(releaseOwnedChild).not.toHaveBeenCalled();
  });

  // station#3441 LOW-3: a REJECTING `probeIdentity` during the confirm-wait
  // poll must fail closed (never confirm, never release) and must not make
  // `forceGroupKill()` itself throw -- pre-fix, this rejection propagated
  // straight out of `waitUntilProcessGone()`.
  test('a rejecting identity probe during confirm-wait fails closed -- never confirms, never throws (station#3441 LOW-3)', async () => {
    const { logger } = loggerSpy();
    const releaseOwnedChild = vi.fn();
    const acpProcess = new ACPProcess({
      command: 'node',
      args: ['-e', 'process.stdin.resume()'],
      cwd,
      createClient: () => ({}) as never,
      logger,
      probeIdentity: async () => {
        throw new Error('probe transport down');
      },
    });
    (acpProcess as unknown as { spawnedPid: number }).spawnedPid = 424246;
    (
      acpProcess as unknown as { releaseOwnedChild: (() => void) | null }
    ).releaseOwnedChild = releaseOwnedChild;
    // Signal "delivered" without error, so forceGroupKill falls through to
    // the confirm-wait poll rather than the ESRCH/EPERM branches.
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((): true => {
      return true;
    });

    let result: unknown;
    try {
      result = await acpProcess.forceGroupKill();
    } finally {
      killSpy.mockRestore();
    }

    expect(result).toBeUndefined();
    expect(releaseOwnedChild).not.toHaveBeenCalled();
  });
});
