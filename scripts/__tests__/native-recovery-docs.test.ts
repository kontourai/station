import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TEST_IMPACT_MANIFEST } from '../test-impact-manifest.mjs';

const read = (path: string) => readFileSync(path, 'utf8');

const CHANNELS = [
  {
    config: 'src-desktop/tauri.conf.json',
    identifier: 'io.kontourai.station',
  },
  {
    config: 'src-desktop/tauri.beta.conf.json',
    identifier: 'io.kontourai.station.beta',
  },
  {
    config: 'src-desktop/tauri.nightly.conf.json',
    identifier: 'io.kontourai.station.nightly',
  },
] as const;

function desktopPaths(identifier: string) {
  return {
    linuxData: `$XDG_DATA_HOME/${identifier}/logs/station.log`,
    linuxDefault: `~/.local/share/${identifier}/logs/station.log`,
    macos: `~/Library/Logs/${identifier}/station.log`,
    windows: `%LOCALAPPDATA%\\${identifier}\\logs\\station.log`,
  };
}

describe('native recovery documentation', () => {
  it('derives supervisor facts from its transition guard and matches the docs', () => {
    const source = read('src-desktop/src/bundled_server_state.rs');
    const userGuide = read('docs/user/native-recovery.md');
    const operatorGuide = read('docs/guides/native-shell-verification.md');

    expect(source).toContain('pub const MAX_ATTEMPTS: u32 = 5;');
    expect(source).toContain('const BACKOFF_BASE_MS: u64 = 500;');
    expect(source).toContain(
      'let attempt = current.attempt.saturating_add(1);',
    );
    expect(source).toContain('if attempt >= current.max_attempts');
    expect(source).toContain('let delay = backoff_delay_ms(attempt);');

    const automaticRespawns = 5 - 1;
    const delays = Array.from(
      { length: automaticRespawns },
      (_, index) => 500 * 2 ** (index + 1),
    );
    expect(delays).toEqual([1000, 2000, 4000, 8000]);

    expect(userGuide).toContain('respawn the sidecar four times');
    expect(userGuide).toContain('after 1, 2, 4, and 8 seconds');
    expect(userGuide).toContain('fifth counted exit is terminal');
    expect(operatorGuide).toContain(
      'uses 1 s, 2 s, 4 s, and 8 s crash backoff for its four automatic respawns',
    );
    expect(operatorGuide).toContain(
      'fifth counted exit is terminal; it does not schedule a fifth respawn.',
    );
    expect(operatorGuide).not.toContain('500 ms');
  });

  it('derives channel-specific shell and service log paths from their producers', () => {
    const operatorGuide = read('docs/guides/native-shell-verification.md');
    const userGuide = read('docs/user/native-recovery.md');
    const desktop = read('src-desktop/src/lib.rs');
    const launchd = read('packages/cli/src/commands/service-launchd.ts');
    const windows = read('packages/cli/src/commands/service-windows.ts');
    const systemd = read('packages/cli/src/commands/service-systemd.ts');

    for (const { config, identifier } of CHANNELS) {
      const parsed = JSON.parse(read(config)) as {
        app: { windows: Array<{ visible?: boolean }> };
        identifier: string;
      };
      expect(parsed.identifier).toBe(identifier);
      expect(parsed.app.windows[0]?.visible).toBe(false);

      const paths = desktopPaths(identifier);
      for (const path of Object.values(paths))
        expect(operatorGuide).toContain(path);
    }

    expect(desktop).toContain('fn app_log_dir_for(identifier: &str)');
    expect(desktop).toContain('join("Library/Logs").join(identifier)');
    expect(desktop).toContain('dirs::data_local_dir()');
    expect(launchd).toContain(
      '`' + '$' + '{input.instanceId}-service.out.log`',
    );
    expect(launchd).toContain(
      '`' + '$' + '{input.instanceId}-service.err.log`',
    );
    expect(windows).toContain('`' + '$' + '{instanceId}-service.log`');
    expect(systemd).not.toContain('StandardOutput=');
    expect(systemd).not.toContain('StandardError=');

    expect(userGuide).toContain('<instance>-service.out.log');
    expect(userGuide).toContain('<instance>-service.err.log');
    expect(userGuide).toContain('<instance>-service.log');
    expect(userGuide).toContain('(no service log file)');
  });

  it('keeps the browser procedure collision-safe and targets only its own instance', () => {
    const guide = read('docs/guides/native-shell-verification.md');
    const cli = read('packages/cli/src/cli.ts');
    const help = read('packages/cli/src/help.ts');
    const lifecycle = read('packages/cli/src/commands/lifecycle.ts');
    const allocator = read('scripts/lib/free-ports.mjs');
    const proofBlock = guide
      .split('```sh\n')
      .find(
        (block) =>
          block.includes('proof_instance=') &&
          block.includes('tests/plugin-host-security.spec.ts'),
      );

    expect(proofBlock).toBeDefined();
    const proofScript = proofBlock!.split('\n```')[0];
    const startAt = proofScript.indexOf('./station start');
    const playwrightAt = proofScript.indexOf(
      'npx playwright test tests/plugin-host-security.spec.ts',
    );
    const stopAt = proofScript.indexOf('./station stop');
    expect(startAt).toBeGreaterThan(0);
    expect(playwrightAt).toBeGreaterThan(startAt);
    expect(stopAt).toBeGreaterThan(0);
    expect(proofScript).toContain('cleanup() {');
    expect(proofScript).toContain('trap cleanup EXIT HUP INT TERM');
    expect(proofScript).toContain('if ! ./station start');

    expect(guide).toContain('findFreePortBlock(4)');
    expect(guide).toContain('findFreePortOutside(serverPort, 4)');
    expect(guide).toContain('native-shell-proof-$(date +%s)-$$');
    expect(guide).toContain('--temp-home');
    expect(guide).toContain('--instance="$proof_instance"');
    expect(guide).toContain('--port="$proof_server_port"');
    expect(guide).toContain('--ui-port="$proof_ui_port"');
    expect(guide).toContain('trap cleanup EXIT HUP INT TERM');
    expect(guide).toContain('Playwright runs only after that command returns');
    expect(guide).not.toContain('second terminal');
    expect(guide).not.toContain('--force');
    expect(guide).not.toMatch(/--(?:port|ui-port)=\d+/);

    expect(cli).toContain("args.includes('--temp-home')");
    expect(cli).toContain("arg.startsWith('--instance=')");
    expect(cli).toContain("arg.startsWith('--port=')");
    expect(cli).toContain("arg.startsWith('--ui-port=')");
    expect(help).toContain('station stop [options]');
    expect(help).toContain('Stop a named instance');
    expect(allocator).toContain(
      'export async function findFreePortBlock(size)',
    );
    expect(allocator).toContain('export async function findFreePortOutside(');
    expect(lifecycle).toContain('function matchesSelector(');
    expect(lifecycle).toContain('record.instanceId !== selector.instanceId');
    expect(lifecycle).toContain('record.serverPort !== selector.serverPort');
    expect(lifecycle).toContain('record.uiPort !== selector.uiPort');
    expect(lifecycle).toContain(
      "const match = ensureSingleMatch(matches, 'stop');",
    );
  });

  it('keeps evidence boundaries bound to the tray, hostile plugin, and browser harness sources', () => {
    const guide = read('docs/guides/native-shell-verification.md');
    const tray = read('src-desktop/src/tray.rs');
    const hostilePlugin = read('tests/plugin-host-security.spec.ts');
    const playwright = read('playwright.config.ts');

    expect(tray).toContain('crate::request_main_window_activation(app)');
    expect(tray).toContain('queue_tray_navigation(app, destination_kind);');
    expect(hostilePlugin).toContain('window.parent.__TAURI__');
    expect(hostilePlugin).toContain('__TAURI_INTERNALS__.invoke');
    expect(hostilePlugin).toContain(
      'requires running this suite INSIDE the real WebView',
    );
    expect(playwright).toContain("browserName: 'chromium'");
    expect(guide).toContain('It is a browser test');
    expect(guide).toContain('cannot prove native IPC denial');
    expect(guide).toContain('Do not invent a `tauri-driver` command');
  });

  it('selects this contract test when any named native or browser seam changes', () => {
    const testFor = (pattern: string) =>
      TEST_IMPACT_MANIFEST.find((edge) => edge.pattern === pattern)?.tests;
    for (const pattern of [
      'src-desktop/src/bundled_server_state.rs',
      'src-desktop/src/lib.rs',
      'src-desktop/src/tray.rs',
      'src-desktop/tauri.conf.json',
      'src-desktop/tauri.beta.conf.json',
      'src-desktop/tauri.nightly.conf.json',
      'src-ui/src/platform/native/startupReadiness.ts',
      'src-ui/src/platform/native/__tests__/startupReadiness.test.ts',
      'scripts/__tests__/startup-readiness-static.test.ts',
      'packages/cli/src/cli.ts',
      'packages/cli/src/help.ts',
      'packages/cli/src/commands/service-launchd.ts',
      'packages/cli/src/commands/service-systemd.ts',
      'packages/cli/src/commands/service-windows.ts',
      'packages/cli/src/commands/lifecycle.ts',
      'scripts/lib/free-ports.mjs',
      'tests/plugin-host-security.spec.ts',
      'playwright.config.ts',
    ])
      expect(testFor(pattern), pattern).toContain(
        'scripts/__tests__/native-recovery-docs.test.ts',
      );
  });

  it('keeps desktop build, tray, and logging references routed to the recovery guide', () => {
    for (const path of [
      'docs/guides/desktop-build.md',
      'docs/guides/desktop-tray.md',
      'docs/reference/config.md',
    ])
      expect(read(path), path).toContain('native-recovery.md');
  });
});
