import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  desktopDevEnvironment,
  desktopDevTauriConfig,
  desktopTauriIdentifier,
  resolveDesktopDevContract,
} from '../dev-desktop.mjs';

describe('desktop development contract', () => {
  test('derives a deterministic worktree home, ports, identifier, and Tauri environment', async () => {
    const dependencies = {
      cwd: '/workspace/station-worktrees/beta-ui',
      env: { STATION_DEV_INSTANCE: 'Beta_UI' },
      isPortFree: async () => true,
      resolveWorktree: () => '/workspace/station-worktrees/beta-ui',
    };
    const first = await resolveDesktopDevContract(dependencies);
    const second = await resolveDesktopDevContract(dependencies);
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      productName: 'Station Dev (dev-beta_ui)',
      home: join(process.env.STATION_ROOT!, 'instances', 'dev', 'dev-beta_ui'),
      identifier: 'io.kontourai.station.dev.dev-beta-ui',
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
    });
  });

  test('sanitizes underscores and unsafe identifier input into one bundle suffix', () => {
    expect(desktopTauriIdentifier('__My_Worktree__')).toBe(
      'io.kontourai.station.dev.my-worktree',
    );
  });
});
