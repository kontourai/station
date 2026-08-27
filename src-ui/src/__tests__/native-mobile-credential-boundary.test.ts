import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const root = resolve(import.meta.dirname, '../../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

describe('native mobile credential authority ratchet', () => {
  test('registers the same host-owned pairing and request commands on mobile', () => {
    const rust = read('src-desktop/src/lib.rs');
    const mobileHandler = rust.match(
      /#\[cfg\(mobile\)\]\s+let builder = builder\.invoke_handler\(tauri::generate_handler!\[(.*?)\]\);/s,
    )?.[1];

    expect(mobileHandler).toBeDefined();
    for (const command of [
      'credential_vault_commit_pairing',
      'station_profile_authorize_active',
      'station_native_http_request',
      'station_native_pairing_exchange',
      'station_profile_store_read',
      'station_profile_store_write',
    ]) {
      expect(mobileHandler).toContain(command);
    }
  });

  test('keeps the WebView secret-free and configures device-only iOS writes', () => {
    const rust = read('src-desktop/src/lib.rs');
    const apiBase = read('src-ui/src/contexts/ApiBaseContext.tsx');
    const cargo = read('src-desktop/Cargo.toml');

    expect(rust).toContain('AfterFirstUnlockThisDeviceOnly');
    expect(cargo).toContain('tauri-plugin-keyring-store');
    expect(apiBase).toContain(
      'profile.isTauri ? rejectingDesktopCredentialStorage',
    );
    expect(apiBase).toMatch(
      /profile\.isTauri\s+\? \{ transport: lazyNativeAuthenticatedTransport \}/,
    );
    expect(apiBase).toContain(
      'profile.isTauri ? lazyNativePairingExchangeTransport : undefined',
    );
    expect(apiBase).not.toMatch(
      /profile\.isMobile[\s\S]{0,120}credentialProvider\.getCredential/,
    );
  });

  test('excludes Android app data from cloud backup and device transfer', () => {
    const manifest = read(
      'src-desktop/gen/android/app/src/main/AndroidManifest.xml',
    );
    const extraction = read(
      'src-desktop/gen/android/app/src/main/res/xml/data_extraction_rules.xml',
    );

    expect(manifest).toContain('android:allowBackup="false"');
    expect(manifest).toContain(
      'android:dataExtractionRules="@xml/data_extraction_rules"',
    );
    expect(extraction).toContain('<cloud-backup');
    expect(extraction).toContain('<device-transfer>');
    expect(extraction).toContain('<exclude domain="sharedpref" path="." />');
  });

  test('stores mobile saved Station metadata in the app-private config sandbox', () => {
    const rust = read('src-desktop/src/lib.rs');
    const mobilePath = rust.match(
      /#\[cfg\(mobile\)\]\s+fn station_profiles_path\(.*?\n\}/s,
    )?.[0];
    const desktopPath = rust.match(
      /#\[cfg\(not\(mobile\)\)\]\s+fn station_profiles_path\(.*?\n\}/s,
    )?.[0];

    expect(mobilePath).toContain('.app_config_dir()');
    expect(mobilePath).not.toContain('.home_dir()');
    expect(mobilePath).not.toContain('var_os("STATION_HOME")');
    expect(desktopPath).toMatch(
      /home_dir|STATION_HOME|resolve_station_home_for_channel/,
    );
  });

  test('refuses to acknowledge an Android credential write when durable commit returns false', () => {
    const cargo = read('src-desktop/Cargo.toml');
    const preferences = read(
      'patches/android-native-keyring-store/src/shared_preferences.rs',
    );
    const errors = read('patches/android-native-keyring-store/src/error.rs');

    expect(cargo).toContain(
      'android-native-keyring-store = { path = "../patches/android-native-keyring-store" }',
    );
    expect(preferences).toMatch(
      /if ThisMethod::call\(&self\.self_, env, NoParam\)\? \{[\s\S]*Ok\(\(\)\)[\s\S]*\} else \{[\s\S]*SharedPreferencesCommitRejected/,
    );
    expect(errors).toContain('SharedPreferencesCommitRejected');
  });

  test('prevents hostile scripted MCP subframes from reaching native host IPC', () => {
    const frame = read('src-ui/src/components/mcp-ui/MCPToolUIFrame.tsx');

    expect(frame).toContain('const nativeIframeBlocked = platform.isTauri');
    expect(frame).toContain('enabled: !!refParts && !nativeIframeBlocked');
    expect(frame).toMatch(
      /if \(nativeIframeBlocked\)[\s\S]*status="unsupported"[\s\S]*host IPC to subframes/,
    );
  });
});
