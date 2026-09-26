import { spawnSync } from 'node:child_process';
import { describe, expect, test } from 'vitest';
import { parseLifecycleArgs } from '../cli.js';
import {
  renderServiceInstallRemedy,
  renderServiceStatusCommand,
  resolveServiceInstallRemedy,
} from '../commands/service-remedy.js';

const completeConfiguration = {
  allowedOrigins: ['https://station.example.test'],
  features: 'agent-mode,voice',
  host: '127.0.0.1',
  instanceId: 'service-test',
  serverPort: 4242,
  uiPort: 5275,
};

function parseRenderedInstallArguments(command: string): string[] {
  const prefix = 'station service install ';
  expect(command.startsWith(prefix)).toBe(true);
  const result = spawnSync(
    'sh',
    ['-c', `set -- ${command.slice(prefix.length)}; printf '%s\\0' "$@"`],
    { encoding: 'buffer' },
  );
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  return result.stdout
    .toString('utf8')
    .split('\0')
    .filter((argument) => argument.length > 0);
}

/**
 * Runs the rendered command in a real shell against a `station` function that
 * reports the STATION_ROOT it was given and its arguments, from a shell that
 * has no STATION_ROOT of its own.
 */
function runRenderedCommand(command: string): {
  stationRoot: string;
  args: string[];
} {
  const result = spawnSync(
    'sh',
    [
      '-c',
      `unset STATION_ROOT; station() { printf '%s\\0' "\${STATION_ROOT-<unset>}" "$@"; }; ${command}`,
    ],
    { encoding: 'buffer' },
  );
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  const [stationRoot, ...args] = result.stdout.toString('utf8').split('\0');
  return { stationRoot, args: args.filter((argument) => argument.length > 0) };
}

describe('service reinstall STATION_ROOT (#2663 review M1)', () => {
  test('prefixes a recorded root that a shell without STATION_ROOT would not derive', () => {
    const stationRoot = "/srv/Station team's root";
    const remedy = resolveServiceInstallRemedy({
      ...completeConfiguration,
      baseDir: '/srv/station-home',
      stationRoot,
    });
    expect(remedy.command).toBe(
      "STATION_ROOT='/srv/Station team'\"'\"'s root' station service install --instance=service-test --base=/srv/station-home --port=4242 --ui-port=5275 --host=127.0.0.1 --features=agent-mode,voice --allowed-origin=https://station.example.test",
    );
    const executed = runRenderedCommand(remedy.command!);
    expect(executed.stationRoot).toBe(stationRoot);
    expect(executed.args.slice(0, 2)).toEqual(['service', 'install']);
    expect(parseLifecycleArgs(executed.args.slice(2))).toMatchObject({
      baseDir: '/srv/station-home',
    });
  });

  test('adds no prefix when the recorded root is the one a bare reinstall derives', () => {
    const remedy = resolveServiceInstallRemedy({
      ...completeConfiguration,
      baseDir: '/srv/root/instances/blue',
      stationRoot: '/srv/root',
    });
    expect(remedy.command?.startsWith('station service install ')).toBe(true);
    expect(runRenderedCommand(remedy.command!).stationRoot).toBe('<unset>');
    expect(
      resolveServiceInstallRemedy({
        ...completeConfiguration,
        baseDir: '/srv/self-rooted',
      }).command?.startsWith('station service install '),
    ).toBe(true);
  });

  test('gives no command when a recorded absence would be filled in by a reinstall', () => {
    expect(
      resolveServiceInstallRemedy({
        ...completeConfiguration,
        baseDir: '/srv/root/instances/blue',
      }),
    ).toEqual({
      command: null,
      reason:
        'this registration carries no STATION_ROOT, but a reinstall of this home would set STATION_ROOT=/srv/root. Inspect its manifest before reinstalling.',
    });
    expect(
      renderServiceInstallRemedy({
        ...completeConfiguration,
        baseDir: '/srv/station-home',
        stationRoot: 42,
      }),
    ).toBeNull();
  });
});

describe('service remedy rendering', () => {
  test('refuses incomplete recorded service configuration', () => {
    expect(renderServiceInstallRemedy({ ...completeConfiguration })).toBeNull();
    expect(
      renderServiceInstallRemedy({
        ...completeConfiguration,
        baseDir: '/srv/station',
        allowedOrigins: ['https://station.example.test', 42],
      }),
    ).toBeNull();
  });

  test('uses the known home fallback when a legacy registration omitted it', () => {
    expect(
      renderServiceInstallRemedy(completeConfiguration, '/srv/station=blue'),
    ).toBe(
      'station service install --instance=service-test --base=/srv/station=blue --port=4242 --ui-port=5275 --host=127.0.0.1 --features=agent-mode,voice --allowed-origin=https://station.example.test',
    );
  });

  test('shell-escapes a hostile recorded home and round-trips it through the CLI parser', () => {
    const baseDir = "/srv/Station team's=blue";
    const command = renderServiceInstallRemedy({
      ...completeConfiguration,
      baseDir,
    });

    expect(command).toBe(
      "station service install --instance=service-test --base='/srv/Station team'\"'\"'s=blue' --port=4242 --ui-port=5275 --host=127.0.0.1 --features=agent-mode,voice --allowed-origin=https://station.example.test",
    );
    expect(
      parseLifecycleArgs(parseRenderedInstallArguments(command!)),
    ).toMatchObject({ baseDir });
  });

  test('renders a read-only status command only for a known instance and home', () => {
    expect(
      renderServiceStatusCommand({
        instanceId: "service team's",
        baseDir: '/srv/Station team=blue',
      }),
    ).toBe(
      "station service status --instance='service team'\"'\"'s' --base='/srv/Station team=blue'",
    );
    expect(
      renderServiceStatusCommand({ instanceId: 'service-test' }),
    ).toBeNull();
  });
});
