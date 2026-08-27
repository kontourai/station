/**
 * Host-class predicate + named quarantine helper for the WSL2 fleet runner
 * (station#4177).
 *
 * Two test families are proven never-green on the fleet runner's host class
 * (`desktop-win` WSL2, kernel `Linux 6.6.87.2-microsoft-standard-WSL2`) while
 * green on macOS — a pristine-main baseline run on the host itself is the
 * evidence, recorded on station#4177:
 *
 * - eleven lease/deadline/process-group cases in
 *   `scripts/__tests__/verification-coordinator.test.ts` (WSL2 timing /
 *   process-group / fs semantics), and
 * - the real-Chromium touch-target assertions in
 *   `NotificationContainer.touch-target.test.tsx` (WSL2 Chromium rendering
 *   metrics).
 *
 * This module exists so those families can be skipped ON THAT HOST CLASS
 * ONLY, each skip named and carrying the station#4177 reason — an INTERIM
 * quarantine. The real fix (WSL compatibility for the tests themselves)
 * remains station#4177's open scope; nothing here closes it.
 *
 * ## The override env var
 *
 * `STATION_FORCE_WSL_HOST_CLASS` exists ONLY so the guard machinery itself is
 * testable off-host (`scripts/__tests__/wsl-host-class.test.ts`). Strictly
 * `'1'` (force WSL host class) or `'0'` (force non-WSL) act as overrides; any
 * other value — including empty — is NOT an override and kernel detection is
 * used. CI and developers must never set it: `'1'` silently widens the
 * quarantine to every host, `'0'` un-skips the never-green families on the
 * runner and reds every scripts-touching fast-checks run again.
 */
import { release } from 'node:os';

export const WSL_HOST_CLASS_OVERRIDE_ENV = 'STATION_FORCE_WSL_HOST_CLASS';

/**
 * The one reason string every station#4177 quarantine skip carries, so the
 * debt is greppable as a single token in reporter output and in source.
 */
export const WSL_QUARANTINE_REASON =
  'station#4177: never-green on WSL2 host — interim skip, WSL compatibility is the open fix';

/**
 * Kernel-release detection, injectable for tests. The runner host reports
 * `os.release() === '6.6.87.2-microsoft-standard-WSL2'`; the stable token
 * across WSL2 kernels is `microsoft-standard` (WSL1 reports `Microsoft`
 * capitalized and is not a host class this repo runs on, so it is
 * deliberately NOT matched — a skip should never be broader than its
 * evidence).
 *
 * @param {{ platform?: string, osRelease?: string }} [probe]
 * @returns {boolean}
 */
export function detectWslHostClass({
  platform = process.platform,
  osRelease = release(),
} = {}) {
  return platform === 'linux' && osRelease.includes('microsoft-standard');
}

/**
 * The predicate the quarantines gate on: override (strict `'1'`/`'0'`) wins
 * over detection; anything else falls through to `detectWslHostClass`.
 *
 * @param {{
 *   env?: Record<string, string | undefined>,
 *   platform?: string,
 *   osRelease?: string,
 * }} [probe]
 * @returns {boolean}
 */
export function isWslHost({
  env = process.env,
  platform = process.platform,
  osRelease = release(),
} = {}) {
  const override = env[WSL_HOST_CLASS_OVERRIDE_ENV];
  if (override === '1') {
    return true;
  }
  if (override === '0') {
    return false;
  }
  return detectWslHostClass({ platform, osRelease });
}

/**
 * Builds a `test`-shaped registrar that only accepts names from an explicit
 * quarantine list and, on a WSL host, skips each one with `reason` via the
 * test context's `skip(condition, note)` — so the skip is NAMED in reporter
 * output rather than silent, and so the full quarantine is one visible array
 * at the consuming file's top rather than N hand-edited `skipIf`s.
 *
 * A name not in the list throws at collection time: quarantining a new test
 * requires editing the visible list (and the exact-list pin in
 * `scripts/__tests__/wsl-host-class.test.ts` reds until the growth is
 * deliberate on both sides).
 *
 * @param {{
 *   test: (
 *     name: string,
 *     fn: (ctx: {
 *       skip: (condition: boolean, note?: string) => void,
 *     }) => unknown,
 *   ) => unknown,
 *   quarantinedNames: readonly string[],
 *   reason: string,
 *   env?: Record<string, string | undefined>,
 * }} options
 * @returns {(name: string, fn: (ctx: object) => unknown) => void}
 */
export function createWslQuarantinedTest({
  test,
  quarantinedNames,
  reason,
  env = process.env,
}) {
  const names = new Set(quarantinedNames);
  if (names.size !== quarantinedNames.length) {
    throw new Error('WSL quarantine list contains duplicate test names');
  }
  const skipOnThisHost = isWslHost({ env });
  return function wslQuarantinedTest(name, fn) {
    if (!names.has(name)) {
      throw new Error(
        `"${name}" is not in the WSL quarantine list — either register it ` +
          'with plain test(), or grow the quarantine deliberately: add the ' +
          'name to the visible quarantine array AND to the exact-list pin ' +
          'in scripts/__tests__/wsl-host-class.test.ts (station#4177)',
      );
    }
    test(name, (ctx) => {
      ctx.skip(skipOnThisHost, reason);
      return fn(ctx);
    });
  };
}
