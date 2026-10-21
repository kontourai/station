import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  ACPConnectionConfig,
  ACPConnectionRegistryEntry,
} from '@kontourai/station-contracts/acp';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { AcpAdapter } from '../../../providers/adapters/acp-adapter.js';
import {
  clearAll,
  registerACPConnectionRegistryProvider,
} from '../../../providers/registries/registry.js';
import { ACPProbe } from '../acp-probe.js';

/**
 * A registry descriptor's `launchEnv` reaches the engine process through the
 * real spawn (ACPProcess -> spawnOwnedChild), from both places Station
 * launches an engine: the availability probe and a chat session. The stub
 * engine records the variables it was started with and exits, so each launch
 * fails its handshake after the record is written.
 */
const makeTempDir = trackTempDirs();
const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

// Engine-scoped names: launchEnv only admits the catalogue's vendor prefixes.
const DESCRIPTOR_ONLY = 'GOOSE_TEST_DESCRIPTOR_ONLY';
const USER_WINS = 'GOOSE_TEST_USER_WINS';

function stubEngine(dir: string, recordPath: string): string {
  const script = join(dir, 'record-env.mjs');
  writeFileSync(
    script,
    `import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(recordPath)}, JSON.stringify({
  descriptorOnly: process.env.${DESCRIPTOR_ONLY} ?? null,
  userWins: process.env.${USER_WINS} ?? null,
}) + '\\n');
`,
  );
  const launcher = join(dir, 'stub-engine');
  writeFileSync(
    launcher,
    `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`,
  );
  chmodSync(launcher, 0o755);
  return launcher;
}

function launches(recordPath: string) {
  return readFileSync(recordPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function registerEntry(entry: ACPConnectionRegistryEntry, builtin = true) {
  registerACPConnectionRegistryProvider(
    { listAvailable: () => [entry] },
    builtin ? 'test-registry' : 'plugin-presets',
    builtin,
  );
}

/** A built-in entry names the executable, as the catalogue does; the connection holds its full path. */
const STUB_NAME = 'stub-engine';

describe('engine descriptor launch environment', () => {
  let recordPath: string;
  let command: string;
  let connection: ACPConnectionConfig;
  const previousUserValue = process.env[USER_WINS];

  beforeEach(() => {
    const dir = makeTempDir('station-launch-env-');
    recordPath = join(dir, 'launches.jsonl');
    writeFileSync(recordPath, '');
    command = stubEngine(dir, recordPath);
    connection = {
      id: 'stub',
      name: 'Stub',
      command,
      args: [],
      enabled: true,
    };
    // The environment Station would launch with already has this one.
    process.env[USER_WINS] = 'user';
  });

  afterEach(() => {
    clearAll();
    if (previousUserValue === undefined) delete process.env[USER_WINS];
    else process.env[USER_WINS] = previousUserValue;
  });

  async function probeOnce(config: ACPConnectionConfig) {
    const probe = new ACPProbe(
      config,
      silentLogger,
      makeTempDir('station-launch-env-home-'),
      undefined,
      2_000,
    );
    await probe.probe('request');
    await probe.dispose();
  }

  test('the probe launch carries descriptor variables, and the existing environment wins a conflict', async () => {
    registerEntry({
      id: 'stub',
      name: 'Stub',
      command: STUB_NAME,
      launchEnv: { [DESCRIPTOR_ONLY]: 'descriptor', [USER_WINS]: 'descriptor' },
    });

    await probeOnce(connection);

    expect(launches(recordPath)).toEqual([
      { descriptorOnly: 'descriptor', userWins: 'user' },
    ]);
  });

  test('a chat session launch carries the same descriptor variables', async () => {
    registerEntry({
      id: 'stub',
      name: 'Stub',
      command: STUB_NAME,
      launchEnv: { [DESCRIPTOR_ONLY]: 'descriptor', [USER_WINS]: 'descriptor' },
    });
    const adapter = new AcpAdapter({
      getConnections: async () => [connection],
      logger: silentLogger,
    });

    await adapter
      .startSession({
        provider: 'acp',
        threadId: 'launch-env-thread',
        cwd: makeTempDir('station-launch-env-cwd-'),
        confinement: 'host',
        metadata: { connectionId: 'stub' },
      } as never)
      .catch(() => undefined);
    await adapter.stopAll();

    expect(launches(recordPath)[0]).toEqual({
      descriptorOnly: 'descriptor',
      userWins: 'user',
    });
  });

  test('a plugin entry for the same executable contributes nothing', async () => {
    registerEntry(
      {
        id: 'stub',
        name: 'Stub',
        command: STUB_NAME,
        launchEnv: { [DESCRIPTOR_ONLY]: 'descriptor' },
      },
      false,
    );

    await probeOnce(connection);

    expect(launches(recordPath)).toEqual([
      { descriptorOnly: null, userWins: 'user' },
    ]);
  });

  test('a descriptor for another command is not applied', async () => {
    registerEntry({
      id: 'stub',
      name: 'Stub',
      command: 'some-other-engine',
      launchEnv: { [DESCRIPTOR_ONLY]: 'descriptor' },
    });

    await probeOnce(connection);

    expect(launches(recordPath)).toEqual([
      { descriptorOnly: null, userWins: 'user' },
    ]);
  });

  test('a descriptor that fails validation contributes nothing', async () => {
    registerEntry({
      id: 'stub',
      name: 'Stub',
      command: STUB_NAME,
      launchEnv: {
        [DESCRIPTOR_ONLY]: 'descriptor',
        STUB_API_KEY: 'not-allowed-here',
      },
    });

    await probeOnce(connection);

    expect(launches(recordPath)).toEqual([
      { descriptorOnly: null, userWins: 'user' },
    ]);
  });
});
