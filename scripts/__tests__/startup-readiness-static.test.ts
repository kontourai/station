import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..', '..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

describe('desktop startup readiness static boundary', () => {
  it('keeps release main windows hidden in every desktop channel config', () => {
    for (const path of [
      'src-desktop/tauri.conf.json',
      'src-desktop/tauri.beta.conf.json',
      'src-desktop/tauri.nightly.conf.json',
    ]) {
      const config = JSON.parse(read(path)) as {
        app: { windows: Array<{ visible?: boolean }> };
      };
      expect(config.app.windows[0]?.visible).toBe(false);
    }
  });

  it('uses one native reveal authority and does not add window-state plugins', () => {
    const lib = read('src-desktop/src/lib.rs');
    const tray = read('src-desktop/src/tray.rs');
    const mainWindowActions = [
      ...lib.matchAll(
        /get_webview_window\("main"\)[\s\S]{0,320}?(?:\.show\(\)|\.unminimize\(\)|\.set_focus\(\))/g,
      ),
    ];
    expect(mainWindowActions).toHaveLength(1);
    expect(
      lib.slice(
        Math.max(0, (mainWindowActions[0]?.index ?? 0) - 120),
        mainWindowActions[0]!.index,
      ),
    ).toContain('fn reveal_main_window');
    expect(tray).toMatch(
      /fn focus_station_window[\s\S]{0,260}crate::request_main_window_activation\(app\)/,
    );
    expect(lib).toMatch(
      /single_instance::init[\s\S]{0,1800}request_main_window_activation\(app\)/,
    );
    expect(lib).toMatch(
      /deep_link\(\)\.on_open_url[\s\S]{0,500}request_main_window_activation/,
    );
    expect(lib).toMatch(
      /RunEvent::Reopen[\s\S]{0,180}request_main_window_activation/,
    );
    expect(lib).not.toContain('tauri_plugin_window_state');
  });

  it('registers the updater exactly once only for usable release configuration', () => {
    const lib = read('src-desktop/src/lib.rs');
    const configurationStart = lib.indexOf(
      'fn desktop_updater_plugin_configured',
    );
    const updaterRegistration = 'tauri_plugin_updater::Builder::new().build()';
    const updaterRegistrationIndex = lib.indexOf(updaterRegistration);
    const configuredDerivation =
      'let updater_configured = desktop_updater_plugin_configured';
    const configuredDerivationIndex = lib.indexOf(configuredDerivation);
    const configuration = lib.slice(
      configurationStart,
      updaterRegistrationIndex,
    );

    expect(configurationStart).toBeGreaterThanOrEqual(0);
    expect(configuredDerivationIndex).toBeGreaterThan(configurationStart);
    expect(updaterRegistrationIndex).toBeGreaterThan(configurationStart);
    expect(updaterRegistrationIndex).toBeGreaterThan(configuredDerivationIndex);
    expect(configuration).toMatch(
      /plugins\s*\.get\("updater"\)[\s\S]*\.get\("pubkey"\)[\s\S]*!value\.trim\(\)\.is_empty\(\)[\s\S]*\.get\("endpoints"\)[\s\S]*!endpoints\.is_empty\(\)[\s\S]*endpoints\.iter\(\)\.all\(/,
    );
    expect([
      ...lib.matchAll(/tauri_plugin_updater::Builder::new\(\)\.build\(\)/g),
    ]).toHaveLength(1);
    const updaterGuard = lib.match(
      /if updater_configured \{\s*builder = builder\.plugin\(tauri_plugin_updater::Builder::new\(\)\.build\(\)\);\s*\}/,
    );
    expect(updaterGuard?.index).toBeGreaterThan(configuredDerivationIndex);
    const processPlugin =
      'builder = builder.plugin(tauri_plugin_process::init());';
    const processPluginIndex = lib.indexOf(processPlugin);
    expect([...lib.matchAll(/tauri_plugin_process::init\(\)/g)]).toHaveLength(
      1,
    );
    expect(processPluginIndex).toBeGreaterThan(
      (updaterGuard?.index ?? -1) + (updaterGuard?.[0].length ?? 0),
    );
  });

  it('fails its structural probes when a direct reveal or Apple-event route is removed', () => {
    const lib = read('src-desktop/src/lib.rs');
    const injected = `${lib}\nfn injected() { app.get_webview_window("main").unwrap().show().unwrap(); }`;
    expect([
      ...injected.matchAll(
        /get_webview_window\("main"\)[\s\S]{0,320}?\.show\(\)/g,
      ),
    ]).toHaveLength(2);
    const noAppleRoute = lib.replace(
      'request_main_window_activation(&activation_app);',
      '/* route removed */',
    );
    expect(noAppleRoute).not.toMatch(
      /deep_link\(\)\.on_open_url[\s\S]{0,500}request_main_window_activation/,
    );
    const noReopenRoute = lib.replace(
      'request_main_window_activation(app);\n            }\n            #[cfg(not(mobile))]\n            if let tauri::RunEvent::Exit',
      '/* route removed */\n            }\n            #[cfg(not(mobile))]\n            if let tauri::RunEvent::Exit',
    );
    expect(noReopenRoute).not.toMatch(
      /RunEvent::Reopen[\s\S]{0,180}request_main_window_activation/,
    );
  });
});
