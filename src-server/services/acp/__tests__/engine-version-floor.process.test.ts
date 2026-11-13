import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ACPConnectionConfig } from '@kontourai/station-contracts/acp';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { BUILTIN_ACP_ENGINES } from '../../../providers/llm/builtin-acp-engines.js';
import {
  clearAll,
  registerACPConnectionRegistryProvider,
} from '../../../providers/registries/registry.js';
import { ACPProbe } from '../acp-probe.js';
import {
  resetEngineAuthStatus,
  setEngineStatusTestHooks,
} from '../engine-auth-status.js';

/**
 * Antigravity CLI 1.4.4 has no `acp` command: run as `agy acp
 * --process-per-session` it answers nothing and exits 0, and `agy --version`
 * prints the bare version (both recorded 2026-11-13). Through the real probe
 * and spawn, a stand-in that does the same is named as an install below the
 * built-in entry's floor, with the entry's own update hint, instead of a
 * startup that closed for no reason.
 */
const makeTempDir = trackTempDirs();
const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** An `agy` that prints `version` for `--version` and otherwise exits 0 silently. */
function stubAgy(version: string, versionExit = 0): string {
  const dir = makeTempDir('station-version-floor-');
  const launcher = join(dir, 'agy');
  writeFileSync(
    launcher,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${version}"; exit ${versionExit}; fi\nexit 0\n`,
  );
  chmodSync(launcher, 0o755);
  return launcher;
}

function connectionFor(command: string): ACPConnectionConfig {
  return {
    id: 'antigravity',
    name: 'Google Antigravity',
    command,
    args: ['acp', '--process-per-session'],
    enabled: true,
  };
}

async function probeOnce(config: ACPConnectionConfig) {
  const probe = new ACPProbe(
    config,
    silentLogger,
    makeTempDir('station-version-floor-home-'),
    undefined,
    5_000,
  );
  try {
    await expect(probe.probe('request')).resolves.toBe(false);
    return probe.lastError;
  } finally {
    await probe.dispose();
  }
}

beforeEach(() => {
  registerACPConnectionRegistryProvider(
    { listAvailable: () => BUILTIN_ACP_ENGINES.map((entry) => ({ ...entry })) },
    'builtin-acp-connections',
    true,
  );
  // The sign-in status command must not answer for the engine here.
  setEngineStatusTestHooks({ runner: async () => null });
});
afterEach(() => {
  clearAll();
  resetEngineAuthStatus();
  setEngineStatusTestHooks({});
});

describe('an engine install below its built-in floor', () => {
  test('the probe names the old version and the entry’s update hint', async () => {
    expect(await probeOnce(connectionFor(stubAgy('1.4.4')))).toEqual({
      message:
        'Google Antigravity 1.4.4 is installed, and Station needs 1.5.0 or later. Run agy update on the computer Station runs on, then check again.',
      phase: 'initialize',
      code: 'engine-update-required',
    });
  });

  test('a version at the floor is not called too old', async () => {
    const lastError = await probeOnce(connectionFor(stubAgy('1.5.0')));
    expect(lastError?.code).toBeUndefined();
    expect(lastError?.message).toBe(
      'Google Antigravity closed the connection before it finished starting.',
    );
  });

  test('a version command that fails or prints no version leaves it unnamed', async () => {
    for (const command of [stubAgy('1.4.4', 1), stubAgy('unknown')]) {
      expect((await probeOnce(connectionFor(command)))?.code).toBeUndefined();
    }
  });

  test('a program with no built-in floor is never version-checked', async () => {
    // Same behaviour under another name: no entry, so no reading.
    const dir = makeTempDir('station-version-floor-other-');
    const other = join(dir, 'other-engine');
    writeFileSync(
      other,
      '#!/bin/sh\nif [ "$1" = "--version" ]; then echo 0.0.1; fi\nexit 0\n',
    );
    chmodSync(other, 0o755);
    expect(
      (await probeOnce({ ...connectionFor(other), name: 'Other' }))?.code,
    ).toBeUndefined();
  });
});
