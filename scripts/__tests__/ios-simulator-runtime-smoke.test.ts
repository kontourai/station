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
});
