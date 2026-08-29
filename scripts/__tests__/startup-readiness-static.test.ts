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

  it('uses one native reveal authority and a macOS-owned bootstrap cover', () => {
    const lib = read('src-desktop/src/lib.rs');
    const tray = read('src-desktop/src/tray.rs');
    const platformBootstrap = read(
      'src-ui/src/platform/PlatformProfileContext.tsx',
    );
    const mainWindowActions = [
      ...lib.matchAll(
        /get_webview_window\("main"\)[\s\S]{0,320}?(?:\.show\(\)|\.unminimize\(\)|\.set_focus\(\))/g,
      ),
    ];
    expect(mainWindowActions).toHaveLength(1);
    expect(lib).toContain('fn reveal_main_window');
    const nativeStart = lib.indexOf('fn with_native_startup_cover');
    const nativeEnd = lib.indexOf('fn reveal_main_window');
    const nativeCover = lib.slice(nativeStart, nativeEnd);
    expect(nativeStart).toBeGreaterThanOrEqual(0);
    expect(nativeEnd).toBeGreaterThan(nativeStart);
    expect(nativeCover).toContain('window.with_webview');
    expect(nativeCover).toContain('content.addSubview(&cover)');
    expect(nativeCover).toContain('setAlphaValue: 0.0f64');
    expect(nativeCover).toContain('setAlphaValue: 1.0f64');
    expect(nativeCover).toContain('setAccessibilityHidden: true');
    expect(nativeCover).toContain('setAccessibilityHidden: false');
    expect(nativeCover).toContain('ns_window.makeFirstResponder(None)');
    expect(nativeCover).toContain(
      'ns_window.makeFirstResponder(Some(webview_view))',
    );
    expect(nativeCover).toContain('ViewWidthSizable');
    expect(nativeCover).toContain('ViewHeightSizable');
    expect(nativeCover).toContain('isKindOfClass(NSBox::class())');
    expect(nativeCover).toContain('NSUserInterfaceItemIdentification');
    expect(nativeCover).toContain(
      'cover.setIdentifier(Some(cover_identifier))',
    );
    expect(nativeCover).toContain(
      'identifier.isEqualToString(cover_identifier)',
    );
    expect(nativeCover).not.toContain('viewWithTag');
    expect(nativeCover).not.toContain('setTag:');
    expect(nativeCover).toContain('ns_window.deminiaturize(None)');
    expect(nativeCover).toContain('ns_window.makeKeyAndOrderFront(None)');
    expect(nativeCover).not.toContain('.eval(');
    expect(lib).toContain('fn native_cover_dispatcher');
    expect(lib).toContain('sync_channel(1)');
    expect(lib).toContain('apply_native_cover_until_current');
    expect(lib).toContain('ack_rx.recv()');
    expect(lib).toContain('with_native_startup_cover(&window, target.covered)');
    expect(lib).toContain('request_native_cover(app, true)');
    expect(lib).toContain('request_native_cover(app, false)');
    expect(lib).toContain('.on_page_load(|webview, payload|');
    expect(lib).toContain(
      'observe_native_startup_page(webview.app_handle(), webview.label(), payload.event())',
    );
    expect(lib).toContain('event == PageLoadEvent::Started');
    expect(lib).toContain('label == "main"');
    expect(lib).not.toContain('NATIVE_STARTUP_BOOTSTRAP_SCRIPT');
    expect(lib).not.toContain("invoke('renderer_startup_ready')");
    expect(platformBootstrap).not.toContain('startStartupReadinessProof');
    const nativeWake = lib.slice(
      lib.indexOf('fn notify_startup_readiness_if_waiting'),
      lib.indexOf('struct PendingMainWindowActivation'),
    );
    expect(
      nativeWake.indexOf('request_native_startup_commit(app);'),
    ).toBeLessThan(
      nativeWake.indexOf('app.emit("station://startup-readiness-retry"'),
    );
    expect([
      ...lib.matchAll(/\.name\("station-native-cover-dispatcher"\.into\(\)\)/g),
    ]).toHaveLength(1);
    expect(lib).not.toMatch(
      /deep_link\(\)\.on_open_url[\s\S]{0,900}with_native_startup_cover/,
    );
    expect(tray).toMatch(
      /fn focus_station_window[\s\S]{0,260}crate::request_main_window_activation\(app\)/,
    );
    expect(lib).toMatch(
      /single_instance::init[\s\S]{0,1800}request_main_window_activation\(app\)/,
    );
    expect(lib).toMatch(
      /deep_link\(\)\.on_open_url[\s\S]{0,700}request_or_defer_main_window_activation/,
    );
    expect(lib).toMatch(
      /RunEvent::Reopen[\s\S]{0,180}request_main_window_activation/,
    );
    expect(lib).not.toContain('tauri_plugin_window_state');
  });

  it('replays a cold pairing-link activation after native readiness management', () => {
    const lib = read('src-desktop/src/lib.rs');
    const handler = lib.indexOf('deep_link().on_open_url');
    const readinessManagement = lib.indexOf('app.manage(DesktopServerState {');
    const replay = lib.lastIndexOf('replay_pending_main_window_activation(');
    const nativePageReplay = lib.lastIndexOf(
      'advance_native_startup_after_page(app.handle());',
    );

    expect(handler).toBeGreaterThanOrEqual(0);
    expect(readinessManagement).toBeGreaterThan(handler);
    expect(replay).toBeGreaterThan(readinessManagement);
    expect(nativePageReplay).toBeGreaterThan(readinessManagement);
    expect(lib).toContain('commit_startup_recovery_ui_for_app(app)');
    expect(lib).toContain('request_or_defer_main_window_activation(');
    expect(lib).toContain('request_main_window_activation(app);');
  });

  it('routes timeout recovery through the existing readiness authority', () => {
    const lib = read('src-desktop/src/lib.rs');
    const activation = lib.indexOf(
      'pub(crate) fn request_main_window_activation',
    );
    const deadline = lib.indexOf('fn arm_startup_deadline');

    expect(activation).toBeGreaterThanOrEqual(0);
    expect(deadline).toBeGreaterThan(activation);
    expect(lib.slice(activation, deadline)).toContain(
      'continue_startup_readiness(app, state.inner(), &effects);',
    );
    expect(lib.slice(deadline)).toContain(
      'continue_startup_readiness(&app, state.inner(), &effects);',
    );
    expect(lib.slice(deadline)).toContain('readiness.epoch == epoch');
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
      'request_or_defer_main_window_activation(\n                        &activation_app,',
      '/* route removed */',
    );
    expect(noAppleRoute).not.toMatch(
      /deep_link\(\)\.on_open_url[\s\S]{0,700}request_or_defer_main_window_activation/,
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
