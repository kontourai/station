import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
  createStationTempDirSync,
  removeStationTempDirSync,
} from '@kontourai/station-shared/temp-dir';
import { afterEach, beforeEach, test, vi } from 'vitest';
import { createMemoizedTauriShellFixtureStop } from '../../tests/tauri-shell/direct-webdriver.js';

const roots: string[] = [];
let previousStationTempRoot: string | undefined;

beforeEach(() => {
  previousStationTempRoot = process.env.STATION_TEMP_ROOT;
  process.env.STATION_TEMP_ROOT = tmpdir();
});

afterEach(() => {
  for (const root of roots.splice(0)) removeStationTempDirSync(root);
  if (previousStationTempRoot === undefined)
    delete process.env.STATION_TEMP_ROOT;
  else process.env.STATION_TEMP_ROOT = previousStationTempRoot;
});

test('driver close failure still terminates the shell and removes its exact fixture root', async () => {
  const stationRoot = createStationTempDirSync('station-tauri-shell-e2e');
  roots.push(stationRoot);
  const instance = basename(stationRoot);
  const configDirectory = join(stationRoot, 'instances', instance, 'config');
  mkdirSync(configDirectory, { recursive: true, mode: 0o700 });
  writeFileSync(join(configDirectory, 'app.json'), '{}\n', { mode: 0o600 });
  const appLog = createWriteStream(join(stationRoot, 'app.log'));
  const child = { exitCode: null, signalCode: null } as unknown as ChildProcess;
  const driver = {
    close: vi.fn(async () => {
      throw new Error('injected WebDriver close failure');
    }),
  };
  const terminateChild = vi.fn(async (process: ChildProcess) => {
    Object.assign(process, { exitCode: 0 });
  });

  const stop = createMemoizedTauriShellFixtureStop({
    driver,
    child,
    appLog,
    stationRoot,
    terminateChild,
  });
  await assert.rejects(stop(), /injected WebDriver close failure/);
  await assert.rejects(stop(), /injected WebDriver close failure/);

  assert.equal(driver.close.mock.calls.length, 1);
  assert.equal(terminateChild.mock.calls.length, 1);
  assert.equal(appLog.closed, true);
  assert.equal(existsSync(stationRoot), false);
});
