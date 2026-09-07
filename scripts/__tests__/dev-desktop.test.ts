import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  desktopDevEnvironment,
  desktopDevPairingDeepLinkScheme,
  desktopDevTauriConfig,
  desktopTauriIdentifier,
  resolveDesktopDevContract,
} from '../dev-desktop.mjs';

describe('desktop development contract', () => {
  test('derives a deterministic worktree home, ports, identifier, and Tauri environment', async () => {
    // The root is stated, not inherited. This env used to carry only
    // STATION_DEV_INSTANCE and the expectation below read the AMBIENT
    // `process.env.STATION_ROOT`, which arrived through a fallback that
    // ignored the env actually passed. That coupling is what let a partial env
    // silently resolve against a global; naming the root keeps the assertion
    // about derivation rather than about what the suite happens to inject.
    const stationRoot = process.env.STATION_ROOT!;
    const dependencies = {
      cwd: '/workspace/station-worktrees/beta-ui',
      env: { STATION_DEV_INSTANCE: 'Beta_UI', STATION_ROOT: stationRoot },
      isPortFree: async () => true,
      resolveWorktree: () => '/workspace/station-worktrees/beta-ui',
    };
    const first = await resolveDesktopDevContract(dependencies);
    const second = await resolveDesktopDevContract(dependencies);
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      productName: 'Station Dev (dev-beta_ui)',
      home: join(stationRoot, 'instances', 'dev', 'dev-beta_ui'),
      identifier: 'io.kontourai.station.dev.dev-beta-ui',
      pairingDeepLinkScheme: 'station-dev-dev-beta-ui',
      devUrl: `http://127.0.0.1:${first.uiPort}`,
    });
    expect(first.serverPort).toBeGreaterThan(39140);
    expect(first.uiPort).toBeGreaterThan(40140);
    expect(desktopDevEnvironment(first, {})).toMatchObject({
      STATION_HOME: first.home,
      STATION_DESKTOP_PORT: String(first.serverPort),
      STATION_SERVER_PORT: String(first.serverPort),
      STATION_UI_PORT: String(first.uiPort),
    });
    expect(desktopDevTauriConfig(first)).toMatchObject({
      productName: 'Station Dev (dev-beta_ui)',
      identifier: 'io.kontourai.station.dev.dev-beta-ui',
      bundle: {
        icon: expect.arrayContaining([
          'icons/dev/icon.icns',
          'icons/dev/icon.ico',
        ]),
      },
      plugins: {
        'deep-link': {
          desktop: { schemes: ['station-dev-dev-beta-ui'] },
        },
      },
    });
  });

  test('sanitizes underscores and unsafe identifier input into one bundle suffix', () => {
    expect(desktopTauriIdentifier('__My_Worktree__')).toBe(
      'io.kontourai.station.dev.my-worktree',
    );
  });

  test('normalizes a legal dotted dev bundle suffix into the registered pairing scheme', () => {
    const contract = desktopDevTauriConfig({
      productName: 'Station Dev',
      identifier: desktopTauriIdentifier('Dev.Release.7'),
      instance: 'Dev.Release.7',
      home: '/tmp/home',
      serverPort: 39141,
      uiPort: 40141,
      devUrl: 'http://127.0.0.1:40141',
      pairingDeepLinkScheme: desktopDevPairingDeepLinkScheme('Dev.Release.7'),
    });
    expect(contract.plugins['deep-link'].desktop.schemes).toEqual([
      'station-dev-dev-release-7',
    ]);
  });
});
