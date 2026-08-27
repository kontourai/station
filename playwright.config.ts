import { defineConfig, devices } from '@playwright/test';
import { buildE2EBrowserStorageState } from './tests/helpers/e2e-browser-storage-state';

const baseURL = process.env.PW_BASE_URL || 'http://localhost:3000';
const runnerOwned = process.env.STATION_E2E_RUNNER === '1';
const establishedUserStorage = buildE2EBrowserStorageState({
  baseURL,
  establishedUser: process.env.STATION_E2E_ESTABLISHED_USER === '1',
  browserSessionCredential: process.env.STATION_E2E_BROWSER_SESSION_CREDENTIAL,
  operatorCredential: process.env.STATION_E2E_HOST_CREDENTIAL,
  runnerOwned,
});

export default defineConfig({
  testDir: './tests',
  // Each run-e2e-suite invocation supplies an instance-scoped root. The
  // default root preserves direct local Playwright usage.
  outputDir: process.env.STATION_E2E_OUTPUT_DIR || 'test-results',
  timeout: 30_000,
  use: {
    baseURL,
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    ...(establishedUserStorage ? { storageState: establishedUserStorage } : {}),
  },
  projects: [
    {
      name: 'chromium',
      testIgnore: ['**/android/**', 'screenshots.spec.ts'],
      use: { browserName: 'chromium' },
    },
    {
      // station#4464: deterministic-rendering Chromium flags scoped to the
      // screenshot/visual-diff bucket ONLY (see tests/screenshots.spec.ts +
      // scripts/screenshot-diff.mjs) — other specs run under the plain
      // 'chromium' project above and must never inherit these launch args.
      // Headless Chromium on this host already renders through a software
      // SwiftShader/Vulkan ANGLE backend by default (measured: `--use-gl=`/
      // `--use-angle=` and `--disable-gpu` all reported the identical
      // `ANGLE (..., Vulkan ... SwiftShader Device ..., SwiftShader driver)`
      // WEBGL_debug_renderer_info string as a no-flag launch), so the GL
      // flags below are a defensive pin against a future Chromium/host
      // default change rather than an observed behavior change here.
      name: 'screenshot',
      testMatch: 'screenshots.spec.ts',
      use: {
        browserName: 'chromium',
        launchOptions: {
          args: [
            '--force-color-profile=srgb',
            '--force-device-scale-factor=1',
            '--disable-lcd-text',
            '--font-render-hinting=none',
            '--hide-scrollbars',
            '--disable-partial-raster',
            '--disable-skia-runtime-opts',
            '--use-gl=angle',
            '--use-angle=swiftshader',
          ],
        },
      },
    },
    {
      name: 'android',
      testDir: './tests/android',
      use: {
        ...devices['Pixel 7'],
        browserName: 'chromium',
      },
    },
  ],
});
