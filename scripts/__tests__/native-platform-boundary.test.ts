import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
  EXPECTED_APPIMAGE_REMOVED_RESOURCES,
  EXPECTED_APPIMAGE_RUNTIME_FILES,
  EXPECTED_TAURI_CSP,
  EXPECTED_TAURI_PERMISSIONS,
  findCapabilityManifestViolations,
  findNativeBoundaryViolations,
  findTauriCspViolations,
  findTauriNonceMarkerViolations,
  findTauriResourceBoundaryViolations,
  NATIVE_GLOBAL_PATTERN,
  TAURI_APPIMAGE_CONFIG,
  TAURI_BASE_CONFIG,
  TAURI_DESKTOP_CONFIGS,
  TAURI_IMPORT_PATTERN,
  TAURI_MOBILE_CONFIGS,
} from '../native-platform-boundary.mjs';

function readFileFromMap(files: Record<string, string>) {
  return (file: string) => files[file];
}

describe('native-platform-boundary', () => {
  test('recognizes the Tauri SDK and legacy native globals', () => {
    expect(
      "import { invoke } from '@tauri-apps/api/core';".match(
        TAURI_IMPORT_PATTERN,
      ),
    ).not.toBeNull();
    expect('window.__SHARE_TEXT__'.match(NATIVE_GLOBAL_PATTERN)).not.toBeNull();
  });

  test('allows platform adapter imports but rejects feature-level native access', () => {
    const files = {
      'src-ui/src/platform/native/tauri.ts':
        "import { invoke } from '@tauri-apps/api/core';",
      'src-ui/src/views/ChatView.tsx':
        "import { invoke } from '@tauri-apps/api/core';\nwindow.__TAURI__;",
    };

    expect(
      findNativeBoundaryViolations(Object.keys(files), readFileFromMap(files)),
    ).toEqual([
      expect.objectContaining({
        file: 'src-ui/src/views/ChatView.tsx',
        kind: 'tauri import',
      }),
      expect.objectContaining({
        file: 'src-ui/src/views/ChatView.tsx',
        kind: 'native global',
      }),
    ]);
  });

  test('names trayNavigation.ts when a direct Tauri import is fault-injected', () => {
    const files = {
      'src-ui/src/lib/trayNavigation.ts':
        "import { listen } from '@tauri-apps/api/event';",
    };
    expect(
      findNativeBoundaryViolations(Object.keys(files), readFileFromMap(files)),
    ).toEqual([
      expect.objectContaining({
        file: 'src-ui/src/lib/trayNavigation.ts',
        kind: 'tauri import',
      }),
    ]);
  });

  test('allows only the event and window-chrome permissions required by the webview', () => {
    expect(
      findCapabilityManifestViolations(
        JSON.stringify({ permissions: EXPECTED_TAURI_PERMISSIONS }),
      ),
    ).toEqual([]);
    expect(
      findCapabilityManifestViolations(
        JSON.stringify({ permissions: ['core:default'] }),
      ),
    ).toEqual([expect.stringContaining('core:event:allow-listen')]);
  });

  test('requires the exact least-privilege desktop CSP and Tauri CSP mutation', () => {
    const config = JSON.parse(
      readFileSync('src-desktop/tauri.conf.json', 'utf8'),
    );

    expect(findTauriCspViolations(JSON.stringify(config))).toEqual([]);
    expect(config.app.security.csp).toEqual(EXPECTED_TAURI_CSP);
  });

  test('keeps embedded server resources out of mobile packages', () => {
    expect(
      findTauriResourceBoundaryViolations(
        readFileSync(TAURI_BASE_CONFIG, 'utf8'),
        TAURI_DESKTOP_CONFIGS.map((file) => [file, readFileSync(file, 'utf8')]),
        TAURI_MOBILE_CONFIGS.map((file) => [file, readFileSync(file, 'utf8')]),
        [TAURI_APPIMAGE_CONFIG, readFileSync(TAURI_APPIMAGE_CONFIG, 'utf8')],
      ),
    ).toEqual([]);
  });

  test('initializes the Android application context before Tauri starts', () => {
    const activity = readFileSync(
      'src-desktop/gen/android/app/src/main/java/io/kontourai/station/MainActivity.kt',
      'utf8',
    );
    const keyring = readFileSync(
      'src-desktop/gen/android/app/src/main/java/io/crates/keyring/Keyring.kt',
      'utf8',
    );

    expect(keyring).toContain('package io.crates.keyring');
    expect(keyring).toContain('System.loadLibrary("station_ai_lib")');
    expect(keyring).toContain(
      'external fun initializeNdkContext(context: Context)',
    );

    const initializeIndex = activity.indexOf(
      'Keyring.initializeNdkContext(applicationContext)',
    );
    const tauriStartIndex = activity.indexOf(
      'super.onCreate(savedInstanceState)',
    );
    expect(initializeIndex).toBeGreaterThanOrEqual(0);
    expect(tauriStartIndex).toBeGreaterThan(initializeIndex);
  });

  test('permits only the AppImage relocation overlay to remove the raw runtime resource', () => {
    expect(EXPECTED_APPIMAGE_REMOVED_RESOURCES).toEqual({
      '../dist-server': null,
      '../dist-desktop-runtime/node_modules': null,
    });
    expect(EXPECTED_APPIMAGE_RUNTIME_FILES).toEqual({
      'usr/share/Station/dist-server': '../dist-server',
      'usr/share/Station/node_modules': '../dist-desktop-runtime/node_modules',
    });
    expect(
      findTauriResourceBoundaryViolations(
        readFileSync(TAURI_BASE_CONFIG, 'utf8'),
        [],
        [],
        [
          TAURI_APPIMAGE_CONFIG,
          JSON.stringify({
            bundle: {
              resources: EXPECTED_APPIMAGE_REMOVED_RESOURCES,
              linux: { appimage: { files: EXPECTED_APPIMAGE_RUNTIME_FILES } },
            },
          }),
        ],
      ),
    ).toEqual([]);
  });

  test('rejects server resources inherited by the base or mobile configs', () => {
    expect(
      findTauriResourceBoundaryViolations(
        JSON.stringify({
          build: { beforeBuildCommand: 'npm run build:desktop:resources' },
          bundle: { resources: { '../dist-server': 'dist-server' } },
        }),
        [],
        [
          [
            'src-desktop/tauri.ios.conf.json',
            JSON.stringify({
              bundle: { resources: { '../dist-server': 'dist-server' } },
            }),
          ],
        ],
        [
          TAURI_APPIMAGE_CONFIG,
          JSON.stringify({
            bundle: {
              resources: EXPECTED_APPIMAGE_REMOVED_RESOURCES,
              linux: { appimage: { files: EXPECTED_APPIMAGE_RUNTIME_FILES } },
            },
          }),
        ],
      ),
    ).toEqual([
      'base config must not bundle desktop server resources',
      'base config must build only the native client',
      'src-desktop/tauri.ios.conf.json must not bundle desktop server resources',
    ]);
  });

  test('rejects disabled, weakened, or development-only desktop CSP variants', () => {
    const configured = {
      app: { security: { csp: EXPECTED_TAURI_CSP } },
    };

    expect(
      findTauriCspViolations(
        JSON.stringify({ app: { security: { csp: null } } }),
      ),
    ).toContain('app.security.csp must be the exact Station desktop CSP');

    const remoteScripts = structuredClone(configured);
    remoteScripts.app.security.csp['script-src'] = "'self' https:";
    expect(findTauriCspViolations(JSON.stringify(remoteScripts))).toContain(
      'app.security.csp must be the exact Station desktop CSP',
    );

    const unsafeEvaluation = structuredClone(configured);
    unsafeEvaluation.app.security.csp['script-src'] = "'self' 'unsafe-eval'";
    expect(findTauriCspViolations(JSON.stringify(unsafeEvaluation))).toContain(
      'app.security.csp must be the exact Station desktop CSP',
    );

    const developmentOverride = structuredClone(configured);
    developmentOverride.app.security.devCsp = 'default-src *';
    expect(
      findTauriCspViolations(JSON.stringify(developmentOverride)),
    ).toContain(
      'app.security.devCsp must be absent so development inherits csp',
    );

    const disabledMutation = structuredClone(configured);
    disabledMutation.app.security.dangerousDisableAssetCspModification = true;
    expect(findTauriCspViolations(JSON.stringify(disabledMutation))).toContain(
      'app.security.dangerousDisableAssetCspModification must not disable Tauri CSP mutation',
    );
  });

  test('requires the Tauri build-time nonce token on Station-owned marker only', () => {
    const index = readFileSync('src-ui/index.html', 'utf8');
    expect(findTauriNonceMarkerViolations(index)).toEqual([]);
    expect(
      findTauriNonceMarkerViolations(
        index.replace('__TAURI_SCRIPT_NONCE__', 'hard-coded'),
      ),
    ).toEqual([expect.stringContaining('exact Station Tauri script nonce')]);
  });
});
