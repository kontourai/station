import { describe, expect, test } from 'vitest';
import { TauriNativePlatformAdapter } from '../tauri';
import { completeNativeCapabilityReport } from './completeNativeCapabilityReportFixture';

const completeReportInventory = [
  ['browser-preview capability', 'macos', 'enabled'],
  ['browser-preview workspace pane', 'macos', 'enabled'],
  ['workspace pane platform matrix', 'linux', 'disabled'],
  ['workspace pane cross-host fixture', 'windows', 'enabled'],
] as const;

describe('complete synthetic Tauri capability reports', () => {
  test.each(completeReportInventory)(
    '%s parses as a complete host report',
    async (_consumer, platform, localBrowserPreview) => {
      const adapter = new TauriNativePlatformAdapter({
        invoke: async <T>() =>
          completeNativeCapabilityReport(platform, {
            'local-browser-preview': { state: localBrowserPreview },
          }) as T,
        listen: async () => () => {},
      });

      await expect(adapter.getCapabilityReport()).resolves.toMatchObject({
        status: 'ok',
      });
    },
  );
});
