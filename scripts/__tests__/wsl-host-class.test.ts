/**
 * Guard tests for the station#4177 WSL2 quarantine machinery
 * (`scripts/lib/wsl-host-class.mjs`).
 *
 * The quarantine skips proven never-green test families on the WSL2 fleet
 * runner's host class, so the skip machinery itself must be pinned: a
 * predicate that silently inverted, a helper that silently ran (or silently
 * skipped everywhere), or a quarantine list that silently grew would each be
 * invisible exactly where it matters. Three layers here:
 *
 * 1. predicate unit tests — detection from injected platform/release,
 *    strict `'1'`/`'0'` override in both directions, garbage ignored;
 * 2. helper behavior — a fake registrar/context proves the exact
 *    `skip(condition, reason)` wiring, and two REAL vitest registrations
 *    driven through the injected-env override prove the helper skips under
 *    forced-WSL and runs otherwise through vitest's own context (chosen over
 *    a child `vitest run` invocation: the env override is injected at
 *    factory creation, so no child process is needed, and
 *    `scripts/vitest-resource-manifest.mjs` warns against adding more
 *    vitest-spawning files to the process-heavy group);
 * 3. an exact-list pin — the coordinator file's quarantine array and its
 *    helper call sites are EXACTLY the eleven station#4177 baseline
 *    failures, so growing the quarantine is a visible two-file diff and a
 *    red, never a drive-by.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  createWslQuarantinedTest,
  detectWslHostClass,
  isWslHost,
  WSL_HOST_CLASS_OVERRIDE_ENV,
  WSL_QUARANTINE_REASON,
} from '../lib/wsl-host-class.mjs';

/** The runner host's verbatim kernel release (station#4177 baseline run). */
const RUNNER_KERNEL_RELEASE = '6.6.87.2-microsoft-standard-WSL2';

/**
 * The eleven names station#4177's pristine-main baseline run proved
 * never-green on the runner host — an INDEPENDENT copy, deliberately
 * duplicated from `verification-coordinator.test.ts`, so an edit to either
 * side alone reds. The #4173 counting case is the baseline's twelfth failure,
 * fixed by merged #4176, and must never appear here.
 */
const EXPECTED_QUARANTINE = [
  'does not extend a phase execution deadline on fresh heartbeats',
  'waits for an early-return orphan process group before releasing capacity',
  'reports a bounded healthy-idle queue diagnostic with exact blockers',
  'request cleanup residue is undiscovered and releases capacity to its successor',
  'bounds a held foreign mutation claim without touching the canonical directory',
  'reclaims a stale owner by terminating its exact detached child group',
  'a held output lock fences canceled pressure publication until release',
  'stale fairness for another blocker does not let a later lane jump FIFO',
  'a healthy FIFO waiter reports its request deadline as timed out',
  'FIFO blocks a later healthy heavy lane while an earlier queued heavy lane waits',
  'status usedWeight counts every capacity-consuming admission state and projects hostPressure',
];

const COUNTING_TEST_NAME =
  'counts a classified ci-fast infrastructure outcome separately from a failed check';

const COORDINATOR_TEST_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  'verification-coordinator.test.ts',
);

describe('detectWslHostClass', () => {
  // station#4177 review LOW: a leaked ambient override would silently skip
  // eleven coordinator tests + the touch-target suite on a NON-WSL host with
  // a green exit. Guard tests inject env explicitly, so the ambient variable
  // must never be set where this suite runs — any environment-wide leak
  // becomes a red here instead of an invisible skip count.
  test('the WSL host-class override is not set in this environment', () => {
    expect(process.env.STATION_FORCE_WSL_HOST_CLASS).toBeUndefined();
  });

  test('true for the runner host class, false elsewhere', () => {
    expect(
      detectWslHostClass({
        platform: 'linux',
        osRelease: RUNNER_KERNEL_RELEASE,
      }),
    ).toBe(true);
    // Platform gates: the same release string on a non-linux platform is not
    // the host class (nothing else reports it, but the predicate should not
    // rest on that).
    expect(
      detectWslHostClass({
        platform: 'darwin',
        osRelease: RUNNER_KERNEL_RELEASE,
      }),
    ).toBe(false);
    // Ordinary hosts on both sides of the gate.
    expect(
      detectWslHostClass({ platform: 'linux', osRelease: '6.8.0-45-generic' }),
    ).toBe(false);
    expect(
      detectWslHostClass({ platform: 'darwin', osRelease: '25.6.0' }),
    ).toBe(false);
  });
});

describe('isWslHost override', () => {
  const wslProbe = { platform: 'linux', osRelease: RUNNER_KERNEL_RELEASE };
  const macProbe = { platform: 'darwin', osRelease: '25.6.0' };

  test('strict "1"/"0" wins over detection in both directions', () => {
    expect(
      isWslHost({ env: { [WSL_HOST_CLASS_OVERRIDE_ENV]: '1' }, ...macProbe }),
    ).toBe(true);
    expect(
      isWslHost({ env: { [WSL_HOST_CLASS_OVERRIDE_ENV]: '0' }, ...wslProbe }),
    ).toBe(false);
  });

  test('anything except exactly "1"/"0" is not an override', () => {
    for (const garbage of ['', 'true', 'yes', '01', ' 1', '2', 'WSL']) {
      expect(
        isWslHost({
          env: { [WSL_HOST_CLASS_OVERRIDE_ENV]: garbage },
          ...wslProbe,
        }),
        `override ${JSON.stringify(garbage)} on a WSL probe`,
      ).toBe(true);
      expect(
        isWslHost({
          env: { [WSL_HOST_CLASS_OVERRIDE_ENV]: garbage },
          ...macProbe,
        }),
        `override ${JSON.stringify(garbage)} on a macOS probe`,
      ).toBe(false);
    }
    expect(isWslHost({ env: {}, ...wslProbe })).toBe(true);
    expect(isWslHost({ env: {}, ...macProbe })).toBe(false);
  });
});

/**
 * Fake registrar/context pair: records what the helper registers and what it
 * passes to `ctx.skip`, and mimics vitest's contract that a skip with a true
 * condition THROWS so nothing after it runs.
 */
class SkipSignal extends Error {}

function fakeHarness() {
  const registered: Array<{
    name: string;
    fn: (ctx: { skip: (condition: boolean, note?: string) => void }) => unknown;
  }> = [];
  const skips: Array<{ condition: boolean; note?: string }> = [];
  const registrar = (
    name: string,
    fn: (ctx: { skip: (condition: boolean, note?: string) => void }) => unknown,
  ) => {
    registered.push({ name, fn });
  };
  const ctx = {
    skip: (condition: boolean, note?: string) => {
      skips.push({ condition, note });
      if (condition) {
        throw new SkipSignal();
      }
    },
  };
  return { registered, skips, registrar, ctx };
}

describe('createWslQuarantinedTest', () => {
  const forcedWslEnv = { [WSL_HOST_CLASS_OVERRIDE_ENV]: '1' };
  const forcedNonWslEnv = { [WSL_HOST_CLASS_OVERRIDE_ENV]: '0' };

  test('refuses a name outside the quarantine list at collection time', () => {
    const { registrar } = fakeHarness();
    const quarantined = createWslQuarantinedTest({
      test: registrar,
      quarantinedNames: ['listed case'],
      reason: WSL_QUARANTINE_REASON,
      env: forcedNonWslEnv,
    });
    expect(() => quarantined('unlisted case', () => {})).toThrow(
      /not in the WSL quarantine list/,
    );
  });

  test('refuses a quarantine list with duplicate names', () => {
    const { registrar } = fakeHarness();
    expect(() =>
      createWslQuarantinedTest({
        test: registrar,
        quarantinedNames: ['same case', 'same case'],
        reason: WSL_QUARANTINE_REASON,
        env: forcedNonWslEnv,
      }),
    ).toThrow(/duplicate/);
  });

  test('under forced WSL, skips with the #4177 reason before any body runs', () => {
    const { registered, skips, registrar, ctx } = fakeHarness();
    const quarantined = createWslQuarantinedTest({
      test: registrar,
      quarantinedNames: ['listed case'],
      reason: WSL_QUARANTINE_REASON,
      env: forcedWslEnv,
    });
    let bodyRan = false;
    quarantined('listed case', () => {
      bodyRan = true;
    });
    expect(registered.map((entry) => entry.name)).toEqual(['listed case']);
    expect(() => registered[0].fn(ctx)).toThrow(SkipSignal);
    expect(skips).toEqual([{ condition: true, note: WSL_QUARANTINE_REASON }]);
    expect(bodyRan).toBe(false);
  });

  test('under forced non-WSL, runs the body through a non-skipping context', () => {
    const { registered, skips, registrar, ctx } = fakeHarness();
    const quarantined = createWslQuarantinedTest({
      test: registrar,
      quarantinedNames: ['listed case'],
      reason: WSL_QUARANTINE_REASON,
      env: forcedNonWslEnv,
    });
    let bodyRan = false;
    quarantined('listed case', () => {
      bodyRan = true;
    });
    registered[0].fn(ctx);
    expect(bodyRan).toBe(true);
    expect(skips).toEqual([{ condition: false, note: WSL_QUARANTINE_REASON }]);
  });
});

// ---------------------------------------------------------------------------
// REAL-vitest probes: the same factory, driven through the injected env
// override, registered with vitest's own `test` — proving the helper's
// `ctx.skip(condition, note)` wiring against the real runner, not just the
// fake above. Vitest executes a file's tests in declaration order, so the
// assertion test below observes both probe outcomes.
// ---------------------------------------------------------------------------

const FORCED_WSL_PROBE_NAME =
  'station#4177 probe: a quarantined case under forced WSL host class';
const FORCED_NON_WSL_PROBE_NAME =
  'station#4177 probe: a quarantined case under forced non-WSL host class';

let forcedWslProbeBodyRan = false;
let forcedNonWslProbeBodyRan = false;

createWslQuarantinedTest({
  test,
  quarantinedNames: [FORCED_WSL_PROBE_NAME],
  reason: WSL_QUARANTINE_REASON,
  env: { [WSL_HOST_CLASS_OVERRIDE_ENV]: '1' },
})(FORCED_WSL_PROBE_NAME, () => {
  forcedWslProbeBodyRan = true;
});

createWslQuarantinedTest({
  test,
  quarantinedNames: [FORCED_NON_WSL_PROBE_NAME],
  reason: WSL_QUARANTINE_REASON,
  env: { [WSL_HOST_CLASS_OVERRIDE_ENV]: '0' },
})(FORCED_NON_WSL_PROBE_NAME, () => {
  forcedNonWslProbeBodyRan = true;
});

test('the quarantine helper skips under forced WSL and runs otherwise (real vitest)', () => {
  expect(
    forcedWslProbeBodyRan,
    'the forced-WSL probe body ran — the quarantine would NOT skip on the runner host',
  ).toBe(false);
  expect(
    forcedNonWslProbeBodyRan,
    'the forced-non-WSL probe body was skipped — the quarantine would skip everywhere, not just WSL',
  ).toBe(true);
});

describe('the coordinator quarantine list pin (station#4177)', () => {
  const source = readFileSync(COORDINATOR_TEST_PATH, 'utf8');

  test('the visible quarantine array is exactly the eleven baseline failures, in file order', () => {
    const arrayMatch = source.match(
      /WSL_QUARANTINED_TEST_NAMES = Object\.freeze\(\[([\s\S]*?)\]\)/,
    );
    expect(
      arrayMatch,
      'WSL_QUARANTINED_TEST_NAMES array not found in verification-coordinator.test.ts',
    ).not.toBeNull();
    const names = [
      ...(arrayMatch as RegExpMatchArray)[1].matchAll(/'([^']*)'/g),
    ].map((match) => match[1]);
    expect(names).toEqual(EXPECTED_QUARANTINE);
  });

  test('every wslQuarantinedTest call site is one of the eleven, each exactly once', () => {
    const callSites = [
      ...source.matchAll(/wslQuarantinedTest\(\s*'([^']*)'/g),
    ].map((match) => match[1]);
    expect([...callSites].sort()).toEqual([...EXPECTED_QUARANTINE].sort());
  });

  test('the #4176-fixed counting case stays live as a plain test()', () => {
    expect(EXPECTED_QUARANTINE).not.toContain(COUNTING_TEST_NAME);
    expect(source).toContain(`test('${COUNTING_TEST_NAME}'`);
    expect(source).not.toContain(`wslQuarantinedTest('${COUNTING_TEST_NAME}'`);
  });
});
