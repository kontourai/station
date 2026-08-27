import { spawnSync } from 'node:child_process';
import { describe, expect, test } from 'vitest';
import { parseLifecycleArgs } from '../cli.js';
import {
  renderServiceInstallRemedy,
  renderServiceStatusCommand,
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
