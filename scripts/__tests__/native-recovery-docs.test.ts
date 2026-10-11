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

    const constant = (name: string) => {
      const match = new RegExp(`const ${name}: u(?:32|64) = ([\\d_]+);`).exec(
        source,
      );
      expect(match, name).not.toBeNull();
      return Number(match![1].replaceAll('_', ''));
    };
    const maxAttempts = constant('MAX_ATTEMPTS');
    const backoffBaseMs = constant('BACKOFF_BASE_MS');
    const backoffCapMs = constant('BACKOFF_CAP_MS');
    // The transition guard the derivation below relies on: each counted exit
    // increments the attempt, the max_attempts-th is terminal, and every
    // earlier one waits backoff_delay_ms(attempt).
    expect(source).toContain(
      'let attempt = current.attempt.saturating_add(1);',
    );
    expect(source).toContain('if attempt >= current.max_attempts');
    expect(source).toContain('let delay = backoff_delay_ms(attempt);');
    expect(source).toContain(
      'BACKOFF_BASE_MS.saturating_mul(factor).min(BACKOFF_CAP_MS)',
    );

    const respawns = maxAttempts - 1;
    const seconds = Array.from(
      { length: respawns },
      (_, index) =>
        Math.min(backoffBaseMs * 2 ** (index + 1), backoffCapMs) / 1000,
    );
    const cardinal = ['zero', 'one', 'two', 'three', 'four', 'five', 'six'];
    const ordinal = [
      '',
      'first',
      'second',
      'third',
      'fourth',
      'fifth',
      'sixth',
    ];
    const series = (items: string[]) =>
      `${items.slice(0, -1).join(', ')}, and ${items.at(-1)}`;
    const terminal = ordinal[maxAttempts];

    expect(userGuide).toContain(
      `respawn the sidecar ${cardinal[respawns]} times`,
    );
    expect(userGuide).toContain(`after ${series(seconds.map(String))} seconds`);
    expect(userGuide).toContain(`${terminal} counted exit is terminal`);
    expect(operatorGuide).toContain(
      `uses ${series(seconds.map((value) => `${value} s`))} crash backoff for its ${cardinal[respawns]} automatic respawns`,
    );
    expect(operatorGuide).toContain(
      `${terminal} counted exit is terminal; it does not schedule a ${terminal} respawn.`,
    );
    const startupHeading = '## Startup and sidecar interpretation';
    expect(operatorGuide).toContain(startupHeading);
    const startupSection = operatorGuide
      .split(startupHeading)[1]
      .split('\n## ')[0];
    expect(startupSection).not.toContain(`${backoffBaseMs} ms`);
  });

  it('derives channel-specific shell and service log paths from their producers', () => {
    const operatorGuide = read('docs/guides/native-shell-verification.md');
    const userGuide = read('docs/user/native-recovery.md');
    const desktop = read('src-desktop/src/lib.rs');
    const launchd = read('packages/cli/src/commands/service-launchd.ts');
    const windows = read('packages/cli/src/commands/service-windows.ts');
    const systemd = read('packages/cli/src/commands/service-systemd.ts');

    for (const { config, identifier } of CHANNELS) {
      const parsed = JSON.parse(read(config)) as { identifier: string };
      expect(parsed.identifier).toBe(identifier);

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
  });

  it('states that the hostile-plugin proof is browser evidence, not native IPC evidence', () => {
    const guide = read('docs/guides/native-shell-verification.md');

    expect(guide).toContain('It is a browser test');
    expect(guide).toContain('cannot prove native IPC denial');
    expect(guide).toContain('Do not invent a `tauri-driver` command');
  });

  it('selects this contract test when any source it reads changes', () => {
    const testFor = (pattern: string) => {
      const edge = TEST_IMPACT_MANIFEST.find(
        (candidate) => candidate.pattern === pattern,
      );
      return edge && 'tests' in edge ? edge.tests : undefined;
    };
    for (const pattern of [
      'src-desktop/src/bundled_server_state.rs',
      'src-desktop/src/lib.rs',
      'src-desktop/tauri.conf.json',
      'src-desktop/tauri.beta.conf.json',
      'src-desktop/tauri.nightly.conf.json',
      'scripts/__tests__/startup-readiness-static.test.ts',
      'packages/cli/src/cli.ts',
      'packages/cli/src/help.ts',
      'packages/cli/src/commands/service-launchd.ts',
      'packages/cli/src/commands/service-systemd.ts',
      'packages/cli/src/commands/service-windows.ts',
      'scripts/lib/free-ports.mjs',
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
