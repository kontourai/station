import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..', '..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

/**
 * Keep the startup-routing checks scoped to the Rust function/event body they
 * describe. Source-width regexes made a harmless tray expansion and a reopen
 * recovery wrapper look like a lost readiness route.
 */
function rustBlock(source: string, anchor: string) {
  const start = source.indexOf(anchor);
  if (start < 0) throw new Error(`missing Rust block anchor: ${anchor}`);

  const openingBrace = source.indexOf('{', start + anchor.length);
  if (openingBrace < 0) throw new Error(`missing Rust block body: ${anchor}`);

  let depth = 0;
  for (let index = openingBrace; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unterminated Rust block: ${anchor}`);
}

function replaceInRustBlock(
  source: string,
  anchor: string,
  needle: string,
  replacement: string,
) {
  const start = source.indexOf(anchor);
  const block = rustBlock(source, anchor);
  const offset = block.indexOf(needle);
  if (offset < 0) throw new Error(`missing Rust route in ${anchor}: ${needle}`);
  return `${source.slice(0, start + offset)}${replacement}${source.slice(
    start + offset + needle.length,
  )}`;
}

/** Every direct main-window reveal site: the single-authority invariant. */
function mainWindowActions(lib: string) {
  return [
    ...lib.matchAll(
      /get_webview_window\("main"\)[\s\S]{0,320}?(?:\.show\(\)|\.unminimize\(\)|\.set_focus\(\))/g,
    ),
  ];
}

const DEEP_LINK_ACTIVATION = 'app.handle().deep_link().on_open_url';

const DEADLINE_ARM = '&& now_ms >= next.deadline_ms =>';

/** Source with all whitespace removed, for exact-shape pins. */
function shape(source: string) {
  return source.replace(/\s+/g, '');
}

/**
 * The two timer threads may only wait, build the production host and call
 * the tested decision function. An exact-shape pin (not a deny-list of names)
 * fails on any added statement: an unlisted helper that restarts the sidecar,
 * an automatic exit, or a direct resolve.
 */
const DEADLINE_THREAD_SHAPE =
  shape(`fn arm_startup_deadline(app: AppHandle, epoch: u64) {
    let _ = thread::Builder::new()
        .name(format!("station-startup-readiness-{epoch}"))
        .spawn(move || {
            thread::sleep(Duration::from_secs(30));
            let Some(state) = app.try_state::<DesktopServerState>() else {
                return;
            };
            startup_deadline_elapsed_with(
                &AppStartupRecoveryHost {
                    app: &app,
                    state: state.inner(),
                },
                epoch,
            );
        });
}`);
const REOFFER_THREAD_SHAPE =
  shape(`fn arm_slow_start_reoffer(&self, epoch: u64, attempt: u32) {
        let app = self.app.clone();
        let _ = thread::Builder::new()
            .name(format!("station-startup-recovery-reoffer-{epoch}"))
            .spawn(move || {
                let Some(state) = app.try_state::<DesktopServerState>() else {
                    return;
                };
                run_slow_start_reoffer(
                    &AppStartupRecoveryHost {
                        app: &app,
                        state: state.inner(),
                    },
                    epoch,
                    attempt,
                    thread::sleep,
                );
            });
    }`);

/** Calls that restart or signal the owned sidecar process. */
function processRestartPrimitives(body: string) {
  return [
    'SupervisorMessage',
    'supervisor.tx',
    'restart_bundled_server',
    'restart_owned_sidecar',
    'continue_startup_readiness_with',
  ].filter((primitive) => body.includes(primitive));
}

/** Each `fn name(` body inside an impl block, keyed by method name. */
function rustMethods(implBlock: string) {
  const methods: Record<string, string> = {};
  for (const match of implBlock.matchAll(/\bfn (\w+)\(/g)) {
    methods[match[1] ?? ''] = rustBlock(
      implBlock.slice(match.index),
      `fn ${match[1]}(`,
    );
  }
  return methods;
}

/**
 * Process or phase effects inside the readiness deadline arm. A deadline only
 * marks the epoch overdue; restarting there killed slow cold boots forever.
 */
function deadlineRestartRoutes(readiness: string) {
  const arm = rustBlock(readiness, DEADLINE_ARM);
  return [
    'restart_readiness(',
    'RestartOwnedSidecar',
    'ReprobeCurrentTicket',
    'next.phase =',
    'next.epoch +=',
  ].filter((route) => arm.includes(route));
}

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
    const main = read('src-ui/src/main.tsx');
    expect(mainWindowActions(lib)).toHaveLength(1);
    expect(lib).toContain('fn reveal_main_window');
    const nativeStart = lib.indexOf('fn with_native_startup_cover');
    const nativeEnd = lib.indexOf('fn reveal_main_window');
    const nativeCover = lib.slice(nativeStart, nativeEnd);
    expect(nativeStart).toBeGreaterThanOrEqual(0);
    expect(nativeEnd).toBeGreaterThan(nativeStart);
    expect(nativeCover).toMatch(/window\s*\.with_webview\(/);
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
    expect(lib).toMatch(
      /with_native_startup_cover\(\s*&window,\s*&main_app,\s*target\.cover,?\s*\)/,
    );
    expect(lib).toContain('request_native_cover(app, Some(content))');
    expect(lib).toContain('request_native_cover(app, None)');
    expect(lib).toContain('.on_page_load(|webview, payload|');
    expect(lib).toContain(
      'observe_native_startup_page(webview.app_handle(), webview.label(), payload.event())',
    );
    expect(lib).toContain('event == PageLoadEvent::Started');
    expect(lib).toContain('label == "main"');
    expect(lib).toContain('fn commit_renderer_mount');
    expect(lib).toContain('commit_renderer_mount,');
    expect(lib).toContain('renderer_mount_label_admitted(window.label())');
    // startup_readiness.rs's own Rust tests prove the reveal prerequisites,
    // but they run only on the paths-filtered, non-required Desktop Rust
    // lane. Keep a merge-blocking pin here that the readiness reveal waits
    // for both the native identity and the React mount. The renderer's single
    // layout-mount commit is owned by
    // src-ui/src/platform/native/__tests__/rendererLiveness.test.tsx.
    const reveal = rustBlock(
      read('src-desktop/src/startup_readiness.rs'),
      'fn maybe_reveal',
    );
    expect(reveal).toMatch(
      /if phase_admits && next\.identity_committed && next\.renderer_mounted \{\s+next\.phase = ReadinessPhase::Ready;\s+effects\.push\(ReadinessEffect::RevealMainWindow\);/,
    );
    const renderApp = main.slice(main.indexOf('function renderApp'));
    expect(renderApp.indexOf('<NativeRendererMountCommit />')).toBeLessThan(
      renderApp.indexOf('<PlatformBootstrap>'),
    );
    expect(lib).not.toContain('clear_all_browsing_data');
    const mountCommit = rustBlock(lib, 'fn commit_renderer_mount(');
    expect(mountCommit.indexOf('renderer_mounted.store(true')).toBeLessThan(
      mountCommit.indexOf('try_state::<DesktopServerState>()'),
    );
    expect(mountCommit).toContain(
      'retained the main React mount before desktop state',
    );
    const retainedReplay = lib.slice(
      lib.indexOf('fn replay_native_startup_renderer_observations'),
      lib.indexOf('fn native_startup_uses_sidecar_proof'),
    );
    expect(retainedReplay.indexOf('RendererPageStarted')).toBeLessThan(
      retainedReplay.indexOf('RendererMounted'),
    );
    const readinessManagement = lib.indexOf('app.manage(DesktopServerState {');
    const readinessSetup = lib.slice(
      readinessManagement,
      lib.indexOf('tray::init(app.handle())?;', readinessManagement),
    );
    expect(readinessSetup).toContain(
      'replay_native_startup_renderer_observations(app.handle());',
    );
    expect(lib).not.toContain('NATIVE_STARTUP_BOOTSTRAP_SCRIPT');
    expect(lib).not.toContain("invoke('renderer_startup_ready')");
    expect(platformBootstrap).not.toContain('startStartupReadinessProof');
    // Native owns the identity proof: a waiting-phase wake and a newly
    // published sidecar ticket each request the native commit.
    expect(
      rustBlock(lib, 'fn notify_startup_readiness_if_waiting('),
    ).toContain('request_native_startup_commit(app);');
    expect(rustBlock(lib, 'fn observe_startup_ticket(')).toContain(
      'request_native_startup_commit_for_ticket(app, published_ticket);',
    );
    expect([
      ...lib.matchAll(/\.name\("station-native-cover-dispatcher"\.into\(\)\)/g),
    ]).toHaveLength(1);
    const deepLinkActivation = rustBlock(lib, DEEP_LINK_ACTIVATION);
    expect(deepLinkActivation).not.toContain('with_native_startup_cover');
    const trayFocus = rustBlock(tray, 'fn focus_station_window');
    expect(trayFocus).toContain('crate::ensure_main_window(app)?');
    expect(trayFocus).toContain('crate::request_main_window_activation(app)');
    expect(lib).toMatch(
      /single_instance::init[\s\S]{0,1800}request_main_window_activation\(app\)/,
    );
    expect(deepLinkActivation).toContain(
      'request_or_defer_main_window_activation',
    );
    const reopen = rustBlock(
      lib,
      'if let tauri::RunEvent::Reopen { .. } = event',
    );
    expect(reopen).toContain('match ensure_main_window(app)');
    expect(reopen).toContain('request_main_window_activation(app);');
    expect(lib).not.toContain('tauri_plugin_window_state');
  });

  // The webview names native commands by string; a rename or a dropped
  // handler registration would make the readiness bridge fail at runtime
  // (for startup_window_admitted, a failed read releases the loader).
  it('registers every startup-readiness command the native adapter invokes', () => {
    const lib = read('src-desktop/src/lib.rs');
    const adapter = read('src-ui/src/platform/native/tauri.ts');
    const handlerStart = lib.indexOf(
      '#[cfg(not(mobile))]\n    let builder = builder.invoke_handler(tauri::generate_handler![',
    );
    expect(handlerStart).toBeGreaterThanOrEqual(0);
    const handler = lib.slice(handlerStart, lib.indexOf(']);', handlerStart));
    // Only a whole entry line counts: a commented-out entry does not, and an
    // entry gated by a `#[cfg(...)]` attribute line is not unconditionally
    // registered.
    const handlerLines = handler.split('\n');
    const registered = new Set(
      handlerLines.flatMap((line, index) => {
        const entry = /^\s*(?:[a-z_]+::)*([a-z_]+),?\s*$/.exec(line);
        if (!entry) return [];
        const previous = handlerLines[index - 1]?.trim() ?? '';
        return previous.startsWith('#[cfg(') ? [] : [entry[1] ?? ''];
      }),
    );
    const methods = {
      isStartupWindowAdmitted: 'startup_window_admitted',
      commitRendererMount: 'commit_renderer_mount',
      getBundledServerStatus: 'bundled_server_status',
    };
    for (const [method, command] of Object.entries(methods)) {
      const body = rustBlock(adapter, `async ${method}(`);
      const invoked = [
        ...body.matchAll(/\.invoke(?:<[^>]*>)?\(\s*['"`]([a-z_]+)['"`]/g),
      ].map((match) => match[1]);
      expect([method, invoked]).toEqual([method, [command]]);
      expect([command, registered.has(command)]).toEqual([command, true]);
      expect(lib).toMatch(
        new RegExp(`#\\[tauri::command\\]\\s*(?:async\\s+)?fn ${command}\\(`),
      );
    }
  });

  it('replays a cold pairing-link activation after native readiness management', () => {
    const lib = read('src-desktop/src/lib.rs');
    const handler = lib.indexOf('deep_link().on_open_url');
    const readinessManagement = lib.indexOf('app.manage(DesktopServerState {');
    const replay = lib.lastIndexOf('replay_pending_main_window_activation(');
    const nativeRendererReplay = lib.lastIndexOf(
      'replay_native_startup_renderer_observations(app.handle());',
    );

    expect(handler).toBeGreaterThanOrEqual(0);
    expect(readinessManagement).toBeGreaterThan(handler);
    expect(replay).toBeGreaterThan(readinessManagement);
    expect(nativeRendererReplay).toBeGreaterThan(readinessManagement);
    expect(lib).toContain('commit_native_startup_recovery_for_app(app)');
    expect(lib).toContain('request_or_defer_main_window_activation(');
    expect(lib).toContain('request_main_window_activation(app);');
  });

  // The Rust state tests in startup_readiness.rs run only on the
  // paths-filtered Desktop Rust lane. These merge-blocking pins keep the
  // slow-boot fix: an elapsed deadline never restarts a sidecar or leaves the
  // admitting Waiting phase, and only an explicit Restart/Quit acts.
  it('keeps slow sidecar boots alive and routes recovery only through explicit choices', () => {
    const lib = read('src-desktop/src/lib.rs');
    const readiness = read('src-desktop/src/startup_readiness.rs');
    expect(deadlineRestartRoutes(readiness)).toEqual([]);
    // An overdue epoch is still Waiting, so a late exact ticket and its
    // identity proof are admitted and reveal without user action.
    for (const arm of [
      'ReadinessInput::ServerTicket(ticket) =>',
      'ReadinessInput::NativeIdentityCommitted(ticket) =>',
    ]) {
      const body = rustBlock(readiness, arm);
      expect(body).toContain('matches!(next.phase, ReadinessPhase::Waiting)');
      expect(body).not.toContain('next.overdue');
    }

    const deadlineThread = rustBlock(lib, 'fn arm_startup_deadline(');
    expect(shape(deadlineThread)).toBe(DEADLINE_THREAD_SHAPE);
    const deadline = rustBlock(lib, 'fn startup_deadline_elapsed_with(');
    const offer = rustBlock(lib, 'fn offer_slow_start_dialog_with(');
    const reoffer = rustBlock(lib, 'fn run_slow_start_reoffer(');
    expect(reoffer).toContain(
      'offer_slow_start_dialog_with(host, epoch, attempt)',
    );
    for (const body of [deadlineThread, deadline, offer, reoffer]) {
      expect(processRestartPrimitives(body)).toEqual([]);
      for (const forbidden of [
        'continue_startup_readiness',
        'resolve_slow_startup',
        'ReadinessInput::Retry',
      ]) {
        expect(body).not.toContain(forbidden);
      }
    }
    // macOS shows recovery inside the native cover; the dialog is only the
    // fallback for hosts without one.
    const presented = deadline.indexOf(
      'Some(StartupRecoveryPresentation::Presented) => {}',
    );
    expect(presented).toBeGreaterThanOrEqual(0);
    expect(
      deadline.indexOf('offer_slow_start_dialog_with(host, epoch, 0)'),
    ).toBeGreaterThan(presented);

    const resolve = rustBlock(lib, 'fn resolve_slow_startup_with(');
    expect(resolve).toContain(
      'continue_startup_readiness_with(host, &effects);',
    );
    expect(resolve.indexOf('host.overdue_for_epoch(epoch)')).toBeLessThan(
      resolve.indexOf('host.exit()'),
    );
    // The routing tests drive a fake host; pin the production host's
    // owner-routed recovery commit and its single supervisor restart.
    const host = rustBlock(
      lib,
      'impl StartupRecoveryHost for AppStartupRecoveryHost',
    );
    expect(rustBlock(host, 'fn recommit_native_recovery')).toContain(
      'advance_native_startup_after_page(self.app)',
    );
    expect(rustBlock(host, 'fn restart_owned_sidecar')).toContain(
      'SupervisorMessage::Restart',
    );
    // Only restart_owned_sidecar may reach a process restart primitive; a
    // restart hidden in reprobe, recommit, the dialog or the re-offer timer
    // would bring back the slow-boot kill loop under another name.
    const hostMethods = rustMethods(host);
    expect(Object.keys(hostMethods)).toEqual(
      expect.arrayContaining([
        'reprobe_current_ticket',
        'recommit_native_recovery',
        'ask_slow_start_choice',
        'arm_slow_start_reoffer',
        'arm_deadline',
      ]),
    );
    for (const [name, body] of Object.entries(hostMethods)) {
      if (name === 'restart_owned_sidecar') continue;
      expect([name, processRestartPrimitives(body)]).toEqual([name, []]);
    }
    // The re-offer timer only schedules the tested decision; choosing for the
    // user there would turn Keep Waiting into a delayed Restart or Quit.
    expect(shape(hostMethods.arm_slow_start_reoffer ?? '')).toBe(
      REOFFER_THREAD_SHAPE,
    );
    expect(rustBlock(host, 'fn exit')).toContain('self.app.exit(1)');

    const activation = rustBlock(
      lib,
      'pub(crate) fn request_main_window_activation(',
    );
    expect(activation).toContain('transition_startup_readiness_presenting(');
    expect(activation).not.toContain('continue_startup_readiness');

    const coverActions = rustBlock(lib, 'mod startup_cover_actions');
    expect(coverActions).toMatch(
      /method\(restart:\)\)\]\s*fn restart[\s\S]*?SlowStartupChoice::Restart/,
    );
    expect(coverActions).toMatch(
      /method\(quit:\)\)\]\s*fn quit[\s\S]*?SlowStartupChoice::Quit/,
    );
    expect(coverActions).toContain(
      'resolve_slow_startup(&ivars.app, ivars.epoch, choice)',
    );
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
    const readiness = read('src-desktop/src/startup_readiness.rs');
    const killingDeadline = replaceInRustBlock(
      readiness,
      DEADLINE_ARM,
      'if !next.overdue {',
      'effects.push(restart_readiness(&mut next, 0, 0));\n            if !next.overdue {',
    );
    expect(deadlineRestartRoutes(killingDeadline)).toEqual([
      'restart_readiness(',
    ]);
    const failingDeadline = replaceInRustBlock(
      readiness,
      DEADLINE_ARM,
      'next.overdue = true;',
      'next.overdue = true; next.phase = ReadinessPhase::Ready;',
    );
    expect(deadlineRestartRoutes(failingDeadline)).toEqual(['next.phase =']);
    const lib2 = read('src-desktop/src/lib.rs');
    const threadRestart = replaceInRustBlock(
      lib2,
      'fn arm_startup_deadline(',
      'thread::sleep(Duration::from_secs(30));',
      'thread::sleep(Duration::from_secs(30)); let _ = restart_bundled_server(app.clone());',
    );
    expect(
      processRestartPrimitives(
        rustBlock(threadRestart, 'fn arm_startup_deadline('),
      ),
    ).toEqual(['restart_bundled_server']);
    const reprobeRestart = replaceInRustBlock(
      lib2,
      'impl StartupRecoveryHost for AppStartupRecoveryHost',
      'notify_startup_readiness_if_waiting(self.app);',
      'notify_startup_readiness_if_waiting(self.app); let _ = self.state.supervisor.tx.send(SupervisorMessage::Restart);',
    );
    const injectedHost = rustMethods(
      rustBlock(
        reprobeRestart,
        'impl StartupRecoveryHost for AppStartupRecoveryHost',
      ),
    );
    expect(
      processRestartPrimitives(injectedHost.reprobe_current_ticket ?? ''),
    ).toEqual(['SupervisorMessage', 'supervisor.tx']);
    for (const action of ['show', 'unminimize', 'set_focus']) {
      const injected = `${lib}\nfn injected() { app.get_webview_window("main").unwrap().${action}().unwrap(); }`;
      expect(mainWindowActions(injected)).toHaveLength(2);
    }
    const noAppleRoute = replaceInRustBlock(
      lib,
      DEEP_LINK_ACTIVATION,
      'request_or_defer_main_window_activation(',
      '/* route removed */(',
    );
    expect(rustBlock(noAppleRoute, DEEP_LINK_ACTIVATION)).not.toContain(
      'request_or_defer_main_window_activation',
    );
    const noReopenRoute = replaceInRustBlock(
      lib,
      'if let tauri::RunEvent::Reopen { .. } = event',
      'request_main_window_activation(app);',
      '/* route removed */',
    );
    expect(
      rustBlock(noReopenRoute, 'if let tauri::RunEvent::Reopen { .. } = event'),
    ).not.toContain('request_main_window_activation(app);');
  });
});
