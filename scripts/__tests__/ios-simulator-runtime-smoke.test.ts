import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  classifyXcuiTestFailure,
  findPreTestLaunchLine,
  parseIosSmokeOptions,
  runAttemptsWithLaunchRetry,
  selectIosSimulator,
} from '../ios-simulator-runtime-smoke.mjs';

const catalog = {
  devices: {
    'com.apple.CoreSimulator.SimRuntime.iOS-18-5': [
      {
        dataPath: '/sim/old',
        isAvailable: true,
        name: 'iPhone 16 Pro',
        state: 'Shutdown',
        udid: 'OLD-UDID',
      },
    ],
    'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [
      {
        dataPath: '/sim/other',
        isAvailable: true,
        name: 'iPhone 17',
        state: 'Shutdown',
        udid: 'OTHER-UDID',
      },
      {
        dataPath: '/sim/exact',
        isAvailable: true,
        name: 'iPhone 17 Pro',
        state: 'Booted',
        udid: 'EXACT-UDID',
      },
    ],
  },
};

const swiftSmoke = readFileSync(
  resolve(
    import.meta.dirname,
    '../../tests/ios-runtime-smoke/StationRuntimeSmokeTests.swift',
  ),
  'utf8',
);

describe('iOS simulator runtime smoke selection', () => {
  test('keeps evidence beneath the checkout and the target on Station stable', () => {
    expect(() =>
      parseIosSmokeOptions([
        '--app',
        '/tmp/Station.app',
        '--artifacts',
        '/tmp/elsewhere',
      ]),
    ).toThrow(/beneath.*\.kontourai/);
    expect(() =>
      parseIosSmokeOptions([
        '--app',
        '/tmp/Station.app',
        '--bundle-id',
        'com.example.other',
      ]),
    ).toThrow(/io\.kontourai\.station/);
  });

  test('selects the exact reviewed runtime and device', () => {
    expect(
      selectIosSimulator(catalog, {
        deviceName: 'iPhone 17 Pro',
        runtimeIdentifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
      }),
    ).toEqual({
      dataPath: '/sim/exact',
      isAvailable: true,
      name: 'iPhone 17 Pro',
      runtimeIdentifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
      state: 'Booted',
      udid: 'EXACT-UDID',
    });
  });

  test('fails closed instead of silently substituting another iOS image', () => {
    expect(() =>
      selectIosSimulator(catalog, {
        deviceName: 'iPhone 17 Pro',
        runtimeIdentifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-4',
      }),
    ).toThrow(/iOS-26-4.*iPhone 17 Pro/);
  });

  test('rejects unavailable exact devices', () => {
    const unavailable = structuredClone(catalog);
    unavailable.devices[
      'com.apple.CoreSimulator.SimRuntime.iOS-26-5'
    ][1].isAvailable = false;
    expect(() =>
      selectIosSimulator(unavailable, {
        deviceName: 'iPhone 17 Pro',
        runtimeIdentifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
      }),
    ).toThrow(/available iOS simulator/);
  });

  test('dismisses a late notification sheet before tapping through the WKWebView', () => {
    const calls = [...swiftSmoke.matchAll(/dismissSystemAlertIfPresent\(\)/g)];
    // Three invocations plus the helper declaration: launch-time best effort,
    // the required post-shell retry, then one bounded post-tap recovery for a
    // permission sheet that wins the final race with the first WebView tap.
    expect(calls).toHaveLength(4);

    const firstShellWait = swiftSmoke.indexOf(
      'waitForStartupShell(connect, budget: 90)',
    );
    const secondDismissal = calls[1].index;
    const reactivation = swiftSmoke.indexOf('app.activate()', secondDismissal);
    const reacquire = swiftSmoke.indexOf(
      'connect.waitForExistence(timeout: 5)',
      reactivation,
    );
    const hittable = swiftSmoke.indexOf(
      'XCTAssertTrue(connect.isHittable)',
      reacquire,
    );
    const tap = swiftSmoke.indexOf('connect.tap()', hittable);
    const managerAction = swiftSmoke.indexOf(
      'app.buttons["Add a Station address"]',
      tap,
    );
    const conditionalRecovery = swiftSmoke.indexOf(
      'if !addAddress.waitForExistence(timeout: 2)',
      managerAction,
    );
    const postTapDismissal = calls[2].index;
    const postTapReactivation = swiftSmoke.indexOf(
      'app.activate()',
      postTapDismissal,
    );
    const postTapReacquire = swiftSmoke.indexOf(
      'connect.waitForExistence(timeout: 5)',
      postTapReactivation,
    );
    const postTapHittable = swiftSmoke.indexOf(
      'XCTAssertTrue(connect.isHittable)',
      postTapReacquire,
    );
    const retryTap = swiftSmoke.indexOf('connect.tap()', postTapHittable);
    const finalManagerWait = swiftSmoke.indexOf(
      'addAddress.waitForExistence(timeout: 10)',
      retryTap,
    );

    const orderedContract = [
      firstShellWait,
      secondDismissal,
      reactivation,
      reacquire,
      hittable,
      tap,
      managerAction,
      conditionalRecovery,
      postTapDismissal,
      postTapReactivation,
      postTapReacquire,
      postTapHittable,
      retryTap,
      finalManagerWait,
    ];
    expect(orderedContract.every((position) => position >= 0)).toBe(true);
    expect(orderedContract).toEqual(
      [...orderedContract].sort((left, right) => left - right),
    );
    expect([...swiftSmoke.matchAll(/connect\.tap\(\)/g)]).toHaveLength(2);
    expect(swiftSmoke).not.toContain('while !addAddress.waitForExistence');
  });
});

// Recorded-failure lines exactly as xcodebuild prints them on the hosted
// macOS runner (path prefix shortened). The launch timeout is XCTest's own
// infrastructure failure at `app.launch()`; the other two are assertions
// inside the test body.
const swiftPath =
  '/w/station/tests/ios-runtime-smoke/StationRuntimeSmokeTests.swift';
const testCase =
  '-[StationRuntimeSmokeTests.StationRuntimeSmokeTests testCleanInstallLeavesStartupForActionableConnectionState]';
const launchTimeoutLine = `${swiftPath}:10: error: ${testCase} : Failed to launch io.kontourai.station: Timed out attempting to launch app.`;
const startupAssertionLine = `${swiftPath}:27: error: ${testCase} : XCTAssertTrue failed - Station never left its startup surface for an actionable no-connection shell. Accessibility hierarchy:`;
const managerAssertionLine = `${swiftPath}:71: error: ${testCase} : XCTAssertTrue failed - Add Station name input did not appear. Accessibility hierarchy:`;
const failedTail = [
  `Test Case '${testCase}' failed (50.383 seconds).`,
  '\t Executed 1 test, with 1 failure (0 unexpected) in 50.383 (50.392) seconds',
  '** TEST FAILED **',
].join('\n');

describe('iOS simulator runtime smoke retry policy', () => {
  // The real pre-test launch line, derived independently of the script so
  // the derivation test has something to disagree with.
  const realLaunchLine = swiftSmoke
    .slice(0, swiftSmoke.indexOf('        app.launch()'))
    .split('\n').length;
  const classify = (log: string, launchLine: number | null = 10) =>
    classifyXcuiTestFailure(log, { launchLine });

  test('binds the retryable signature to the one pre-test app.launch() line', () => {
    expect(findPreTestLaunchLine(swiftSmoke)).toBe(realLaunchLine);
    expect(realLaunchLine).toBe(10);
    // Fixtures below are recorded against line 10, the real launch line.
    expect(launchTimeoutLine).toContain(`${swiftPath}:10: error:`);

    // No launch line, or more than one, fails closed to "never retry".
    expect(findPreTestLaunchLine('final class T {}')).toBeNull();
    expect(
      findPreTestLaunchLine(`${swiftSmoke}\n        app.launch()\n`),
    ).toBeNull();
    expect(findPreTestLaunchLine('        app.launch() // later')).toBeNull();
    // A launch that follows an assertion is not the pre-test launch: a
    // timeout there could come after real test work, so it never retries.
    expect(
      findPreTestLaunchLine(
        ['        XCTAssertTrue(connect.exists)', '        app.launch()'].join(
          '\n',
        ),
      ),
    ).toBeNull();
    expect(
      findPreTestLaunchLine(
        ['        app.launch()', '        XCTAssertTrue(connect.exists)'].join(
          '\n',
        ),
      ),
    ).toBe(1);
  });

  test('retries only the exact pre-test launch timeout', () => {
    expect(classify(`${launchTimeoutLine}\n${failedTail}`)).toEqual({
      signature: 'app-launch-timeout',
      retryable: true,
    });
    // xcodebuild can print the same recorded failure more than once (stdout
    // and a trailing summary); repetition of the one signature is still it.
    expect(
      classify(`${launchTimeoutLine}\n${failedTail}\n${launchTimeoutLine}`),
    ).toEqual({ signature: 'app-launch-timeout', retryable: true });
  });

  test('does not retry the launch-timeout text recorded at any other line', () => {
    const laterLaunch = launchTimeoutLine.replace(
      `${swiftPath}:10:`,
      `${swiftPath}:38:`,
    );
    expect(laterLaunch).not.toBe(launchTimeoutLine);
    expect(classify(`${laterLaunch}\n${failedTail}`)).toEqual({
      signature: 'test-failure',
      retryable: false,
    });
    expect(classify(`${launchTimeoutLine}\n${failedTail}`, 11)).toEqual({
      signature: 'test-failure',
      retryable: false,
    });
    // Without a bound launch line nothing is retryable.
    expect(classify(`${launchTimeoutLine}\n${failedTail}`, null)).toEqual({
      signature: 'test-failure',
      retryable: false,
    });
    expect(
      classifyXcuiTestFailure(`${launchTimeoutLine}\n${failedTail}`),
    ).toEqual({ signature: 'test-failure', retryable: false });
  });

  test('keeps every recorded test-body failure terminal', () => {
    for (const line of [startupAssertionLine, managerAssertionLine]) {
      expect(
        classify(`${line}\n    Application, pid: 1\n${failedTail}`),
      ).toEqual({
        signature: 'test-failure',
        retryable: false,
      });
    }
    // A launch timeout alongside any other recorded failure is not the
    // pre-test signature: the body ran, so the run is a real failure.
    expect(
      classify(`${launchTimeoutLine}\n${startupAssertionLine}\n${failedTail}`),
    ).toEqual({ signature: 'test-failure', retryable: false });
  });

  test('does not retry a launch timeout recorded for a different bundle', () => {
    const otherBundle = launchTimeoutLine.replace(
      'io.kontourai.station',
      'com.example.other',
    );
    expect(classify(`${otherBundle}\n${failedTail}`)).toEqual({
      signature: 'test-failure',
      retryable: false,
    });
    // A bundle id is a literal, not a pattern.
    expect(
      classifyXcuiTestFailure(`${launchTimeoutLine}\n${failedTail}`, {
        bundleId: 'io.kontourai.stat.on',
        launchLine: 10,
      }),
    ).toEqual({ signature: 'test-failure', retryable: false });
  });

  test('does not retry an attempt that recorded no test failure', () => {
    expect(
      classify(
        'error: Unable to find a destination matching the provided destination specifier\n** TEST FAILED **',
      ),
    ).toEqual({ signature: 'no-recorded-test-failure', retryable: false });
    // The timeout text outside a recorded `.swift:N: error:` line (for
    // example quoted in a diagnostics dump) is not a recorded failure.
    expect(
      classify(
        'Failed to launch io.kontourai.station: Timed out attempting to launch app.',
      ),
    ).toEqual({ signature: 'no-recorded-test-failure', retryable: false });
  });

  test('runs a second attempt only after a retryable first attempt', async () => {
    const seen: number[] = [];
    const retried = await runAttemptsWithLaunchRetry({
      classify,
      attempt: async (index: number) => {
        seen.push(index);
        return index === 1
          ? {
              status: 65,
              log: `${launchTimeoutLine}\n${failedTail}`,
              artifacts: '/a/1',
            }
          : { status: 0, log: 'Test Suite passed', artifacts: '/a/2' };
      },
    });
    expect(seen).toEqual([1, 2]);
    expect(retried).toEqual({
      passed: true,
      attempts: [
        {
          index: 1,
          status: 65,
          artifacts: '/a/1',
          signature: 'app-launch-timeout',
          retryable: true,
        },
        {
          index: 2,
          status: 0,
          artifacts: '/a/2',
          signature: 'passed',
          retryable: false,
        },
      ],
    });

    seen.length = 0;
    const terminal = await runAttemptsWithLaunchRetry({
      classify,
      attempt: async (index: number) => {
        seen.push(index);
        return { status: 65, log: `${startupAssertionLine}\n${failedTail}` };
      },
    });
    expect(seen).toEqual([1]);
    expect(terminal.passed).toBe(false);
    expect(
      terminal.attempts.map((entry: { signature: string }) => entry.signature),
    ).toEqual(['test-failure']);
  });

  test('stops after the second attempt even when it times out again', async () => {
    const seen: number[] = [];
    const outcome = await runAttemptsWithLaunchRetry({
      classify,
      attempt: async (index: number) => {
        seen.push(index);
        return { status: 65, log: `${launchTimeoutLine}\n${failedTail}` };
      },
    });
    expect(seen).toEqual([1, 2]);
    expect(outcome.passed).toBe(false);
    expect(outcome.attempts).toHaveLength(2);
    expect(
      outcome.attempts.every(
        (entry: { retryable: boolean }) => entry.retryable,
      ),
    ).toBe(true);
  });

  test('maxAttempts 1 never retries even a retryable failure', async () => {
    const seen: number[] = [];
    const outcome = await runAttemptsWithLaunchRetry({
      classify,
      maxAttempts: 1,
      attempt: async (index: number) => {
        seen.push(index);
        return { status: 65, log: `${launchTimeoutLine}\n${failedTail}` };
      },
    });
    expect(seen).toEqual([1]);
    expect(outcome.passed).toBe(false);
    expect(outcome.attempts[0].retryable).toBe(true);
  });

  test('a passing first attempt never runs a second', async () => {
    const seen: number[] = [];
    const outcome = await runAttemptsWithLaunchRetry({
      classify,
      attempt: async (index: number) => {
        seen.push(index);
        return { status: 0, log: 'Test Suite passed' };
      },
    });
    expect(seen).toEqual([1]);
    expect(outcome).toEqual({
      passed: true,
      attempts: [
        { index: 1, status: 0, signature: 'passed', retryable: false },
      ],
    });
  });
});
