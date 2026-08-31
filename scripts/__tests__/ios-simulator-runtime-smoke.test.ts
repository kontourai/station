import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  parseIosSmokeOptions,
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
    // Two invocations plus the helper declaration: launch-time best effort,
    // then the required post-shell retry that covers a late permission sheet.
    expect(calls).toHaveLength(3);

    const firstShellWait = swiftSmoke.indexOf(
      'connect.waitForExistence(timeout: 30)',
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

    const orderedContract = [
      firstShellWait,
      secondDismissal,
      reactivation,
      reacquire,
      hittable,
      tap,
      managerAction,
    ];
    expect(orderedContract.every((position) => position >= 0)).toBe(true);
    expect(orderedContract).toEqual(
      [...orderedContract].sort((left, right) => left - right),
    );
  });
});
