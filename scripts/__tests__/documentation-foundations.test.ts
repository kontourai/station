import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (file: string) => readFileSync(file, 'utf8');

describe('documentation foundations', () => {
  it('binds getting-started channel facts, Starters, and review route to their current source owners', () => {
    const guide = read('docs/user/getting-started.md');
    const installer = read('install.sh');
    const channels = JSON.parse(read('config/channel-ports.json')) as {
      channels: Record<
        string,
        { instanceDirectory: string; uiPort: number; serverPort: number }
      >;
    };
    const starterRegistry = read(
      'src-server/services/starter-work/starter-registry.ts',
    );
    const surfaces = read('src-ui/src/app-shell/surface-registry.ts');

    expect(channels.channels.stable).toMatchObject({
      instanceDirectory: 'stable',
      uiPort: 18000,
      serverPort: 18141,
    });
    expect(channels.channels.beta).toMatchObject({
      instanceDirectory: 'beta',
      uiPort: 28000,
      serverPort: 28141,
    });
    for (const fact of [
      '~/.station/installs/stable',
      '~/.station/instances/stable',
      'http://localhost:18000',
      'station-beta',
      '~/.station/instances/beta',
      'http://localhost:28000',
      'STATION_CHANNEL=beta',
    ])
      expect(guide).toContain(fact);
    expect(guide).not.toContain('~/.local/share/station/current');
    expect(guide).not.toContain('http://localhost:3000');
    expect(installer).toContain('runtime_launcher_name=station-beta');
    expect(installer).toContain(
      `station_home="\${STATION_HOME:-$station_root/instances/$runtime_channel}"`,
    );
    for (const sourceFact of [
      "id: 'start-task'",
      "id: 'continue-session'",
      "id: 'inspect-approval'",
      "id: 'inspect-receipt'",
      "id: 'run-scheduled-check'",
    ])
      expect(starterRegistry).toContain(sourceFact);
    expect(surfaces).toContain("route: '/review-queue'");
    expect(guide).toContain('`/review-queue`');
    expect(guide).toContain(
      `STATION_CHANNEL=stable "\${STATION_ROOT:-$HOME/.station}/installs/stable/current/install.sh" uninstall`,
    );
    expect(guide).toContain(
      `STATION_CHANNEL=beta "\${STATION_ROOT:-$HOME/.station}/installs/beta/current/install.sh" uninstall`,
    );
  });

  it('keeps product-law authoring explanatory while linking its generated reference', () => {
    const guide = read('docs/guides/product-law-authoring.md');
    const reference = read('docs/reference/product-laws.md');
    expect(guide).toContain('../reference/product-laws.md');
    expect(guide).toContain('Affected-path disposition');
    expect(guide).toContain('PASS');
    expect(guide).toContain('FAIL');
    expect(guide).toContain('NOT_VERIFIED');
    expect(guide).not.toContain('| ID | Observable invariant |');
    expect(reference).toContain('<!-- station:product-laws:start -->');
    expect(reference).not.toContain('scripts/');
  });

  it('defers shared UI explorer, manifest, tokens, themes, and accessibility to Kontour UI', () => {
    for (const file of [
      'docs/guides/theming.md',
      'docs/guides/responsive-ui.md',
    ]) {
      const guide = read(file);
      expect(guide).toContain(
        'https://github.com/kontourai/ui/blob/main/docs/consumer-guide.md',
      );
      expect(guide).toContain(
        'https://github.com/kontourai/ui/blob/main/docs/explorer-manifest.json',
      );
      expect(guide).toContain('`--k-*`');
      expect(guide).toContain('accessibility');
      expect(guide).toContain('Station owns only adopter behavior');
    }
  });

  it('derives both uninstall commands from the one-root installer layout', () => {
    const installer = read('install.sh');
    const guide = read('docs/user/getting-started.md');
    expect(installer).toContain('normalized_station_root()');
    expect(installer).toContain('station_root="$(normalized_station_root)"');
    expect(installer).toContain(
      'install_root="$' +
        '{STATION_INSTALL_ROOT:-$station_root/installs/$runtime_channel}"',
    );
    expect(guide).toContain(
      `STATION_CHANNEL=stable "\${STATION_ROOT:-$HOME/.station}/installs/stable/current/install.sh" uninstall`,
    );
  });

  it('keeps uninstall channel-explicit, custom-root-safe, and runtime-scoped', () => {
    const guide = read('docs/user/getting-started.md');
    const cli = read('docs/reference/cli.md');
    for (const source of [guide, cli]) {
      expect(source).toContain(
        `STATION_CHANNEL=stable "\${STATION_ROOT:-$HOME/.station}/installs/stable/current/install.sh" uninstall`,
      );
    }
    expect(guide).toContain(
      `STATION_CHANNEL=beta "\${STATION_ROOT:-$HOME/.station}/installs/beta/current/install.sh" uninstall`,
    );
    expect(cli).not.toContain('STATION_CHANNEL=preview');
    expect(cli).toContain('selected runtime instance data');
  });

  it('keeps current guidance on the shared-root versus runtime-home contract', () => {
    const currentSurfaces = [
      'docs/glossary.md',
      'docs/guides/development.md',
      'docs/guides/desktop-tray.md',
      'docs/guides/monitoring.md',
      'docs/guides/plugins.md',
      'docs/guides/knowledge.md',
      'docs/guides/web-push-notifications.md',
      'docs/reference/api.md',
      'docs/reference/cli.md',
      'docs/reference/config.md',
      'packages/cli/README.md',
      'packages/sdk/README.md',
    ].map((file) => [file, read(file)] as const);
    const forbiddenRuntimePaths = [
      '~/.station/config/app.json',
      '~/.station/monitoring',
      '~/.station/plugins',
      '~/.station/agents',
      '~/.station/integrations',
      '~/.station/plugin-grants.json',
      '~/.station/service',
      '~/.station/logs',
    ];
    for (const [file, source] of currentSurfaces) {
      for (const stale of forbiddenRuntimePaths) {
        expect(
          source,
          `${file} contains stale runtime path ${stale}`,
        ).not.toContain(stale);
      }
    }

    const development = read('docs/guides/development.md');
    expect(development).toContain('$STATION_ROOT/config/profiles.json');
    expect(development).toContain('dev/<worktree-id>/');
    expect(development).toContain(
      'shared root is not a runtime cleanup target',
    );

    const cli = read('docs/reference/cli.md');
    expect(cli).toContain('| `STATION_ROOT` | shared app data |');
    expect(cli).toContain(
      '`STATION_HOME` → `<STATION_ROOT>/instances/<channel>`',
    );
    expect(cli).toContain('<STATION_HOME>/config/app.json');
    expect(cli).toContain('it never authorizes deleting `STATION_ROOT`');

    const tray = read('docs/guides/desktop-tray.md');
    expect(tray).toContain('$STATION_ROOT/config/profiles.json');
    expect(tray).toContain('localService.baseDir');
    expect(tray).toContain('never guesses from `service/default.json`');
  });

  it('documents the published client package with channel-tagged npx and a local fallback', () => {
    const packageDocument = JSON.parse(read('packages/cli/package.json')) as {
      name: string;
      private?: boolean;
      publishConfig?: { access?: string };
    };
    const packageReadme = read('packages/cli/README.md');
    expect(packageDocument.name).toBe('@kontourai/station-cli');
    // publishable, not private: the package this documents is meant to
    // reach npm. Whether it is LIVE on the registry yet is a registry-side
    // fact this static check cannot see (see the fail-closed trusted
    // publisher preflight in publish-packages.yml / nightly.yml instead) —
    // this only guards against the package regressing back to `private`
    // while the docs still claim otherwise.
    expect(packageDocument.private).not.toBe(true);
    expect(packageDocument.publishConfig?.access).toBe('public');
    expect(packageReadme).toContain('npx @kontourai/station-cli@latest');
    expect(packageReadme).toContain('npx @kontourai/station-cli@nightly');
    expect(packageReadme).toContain('./station <command> [args]');
    expect(packageReadme).toContain(
      "selected channel's runtime-resolver loopback origin",
    );
    expect(packageReadme).not.toContain('127.0.0.1:3141');
  });

  it('derives CLI target fallback copy from the shared channel runtime authority', () => {
    const help = read('packages/cli/src/help.ts');
    const runtime = read('packages/shared/src/runtime-path-resolver.ts');
    const reference = read('docs/reference/cli.md');
    expect(help).toContain('resolveStationRuntimeContext');
    expect(help).toContain('loopbackApiBase');
    expect(help).not.toContain('then http://127.0.0.1:3141');
    expect(runtime).toContain('serverPort');
    expect(reference).toContain('runtime-resolver server port');
    expect(reference).not.toContain(
      'Loopback default target | `http://127.0.0.1:$' + '{STATION_PORT:-3141}`',
    );
  });
});
