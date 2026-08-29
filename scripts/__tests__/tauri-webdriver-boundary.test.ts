import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { tauriShellBinaryCandidates } from '../run-tauri-shell-e2e.mjs';

const root = new URL('../../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), 'utf8');

describe('Tauri embedded WebDriver boundary', () => {
  test('keeps the automation server optional, explicit, and out of releases', () => {
    const cargo = read('src-desktop/Cargo.toml');
    const rust = read('src-desktop/src/lib.rs');
    const webdriverConfig = JSON.parse(
      read('src-desktop/tauri.webdriver.conf.json'),
    );
    const webdriverRunner = read('tests/tauri-shell/direct-webdriver.ts');
    const release = read('.github/workflows/release.yml');

    expect(cargo).toContain('webdriver = ["dep:tauri-plugin-wdio-webdriver"]');
    expect(cargo).toContain(
      'tauri-plugin-wdio-webdriver = { version = "=1.3.0", optional = true }',
    );
    expect(rust).toContain('#[cfg(all(not(mobile), feature = "webdriver"))]');
    expect(rust).toContain(
      'builder.plugin(tauri_plugin_wdio_webdriver::init())',
    );
    expect(webdriverConfig.identifier).toBe('io.kontourai.station.webdriver');
    expect(rust).toContain(
      'if !cfg!(debug_assertions) || app_identifier != "io.kontourai.station.webdriver"',
    );
    expect(rust).toContain('keyring_core::mock::Store::new()');
    expect(webdriverRunner).toContain("STATION_TAURI_E2E_MOCK_CREDENTIAL: '1'");
    expect(webdriverRunner).toContain('TAURI_WEBDRIVER_PORT');
    expect(webdriverRunner).not.toContain('@wdio/');
    expect(release).not.toContain('tauri.webdriver.conf.json');
    expect(release).not.toMatch(/--features[= ]+webdriver/);
    expect(release).not.toContain('STATION_TAURI_E2E_MOCK_CREDENTIAL');
  });

  test('resolves only bounded platform-specific binary locations', () => {
    expect(tauriShellBinaryCandidates('/repo', 'win32')).toEqual([
      join('/repo', 'src-desktop', 'target', 'debug', 'station.exe'),
    ]);
    expect(tauriShellBinaryCandidates('/repo', 'linux')).toEqual([
      join('/repo', 'src-desktop', 'target', 'debug', 'station'),
    ]);
    expect(tauriShellBinaryCandidates('/repo', 'darwin')).toContain(
      join(
        '/repo',
        'src-desktop',
        'target',
        'debug',
        'bundle',
        'macos',
        'Station Tauri Shell E2E.app',
        'Contents',
        'MacOS',
        'station',
      ),
    );
  });

  test('denies unrelated browser-driver lifecycle downloads', () => {
    const allowlist = JSON.parse(
      read('config/dependency-lifecycle-allowlist.json'),
    );
    const decisions = Object.fromEntries(
      allowlist.entries
        .filter((entry: { name: string }) =>
          ['edgedriver', 'geckodriver'].includes(entry.name),
        )
        .map((entry: { name: string; decision: string }) => [
          entry.name,
          entry.decision,
        ]),
    );
    expect(decisions).toEqual({ edgedriver: 'deny', geckodriver: 'deny' });
  });
});
