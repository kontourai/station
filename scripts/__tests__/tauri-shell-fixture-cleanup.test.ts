import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
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
import {
  createMemoizedTauriShellFixtureStop,
  type TauriShellFixtureCleanupReceipt,
} from '../../tests/tauri-shell/direct-webdriver.js';
import { executeOwnedCommand } from '../lib/owned-process.mjs';

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

test.skipIf(process.platform === 'win32')(
  'kills a delayed sidecar descendant before removing the shell fixture root',
  async () => {
    const stationRoot = createStationTempDirSync('station-tauri-shell-e2e');
    roots.push(stationRoot);
    const instance = basename(stationRoot);
    const configDirectory = join(stationRoot, 'instances', instance, 'config');
    const appConfig = join(configDirectory, 'app.json');
    const descendantReady = join(stationRoot, 'sidecar-ready');
    mkdirSync(configDirectory, { recursive: true, mode: 0o700 });
    writeFileSync(appConfig, '{}\n', { mode: 0o600 });
    const appLog = createWriteStream(join(stationRoot, 'app.log'));

    // The owned leader exits immediately, leaving a same-group sidecar-like
    // descendant that would recreate app.json after the old 250ms quiet check.
    const descendantProgram = [
      'const fs = require("node:fs");',
      `fs.writeFileSync(${JSON.stringify(descendantReady)}, 'ready');`,
      `setTimeout(() => { fs.mkdirSync(${JSON.stringify(configDirectory)}, { recursive: true }); fs.writeFileSync(${JSON.stringify(appConfig)}, '{"firstRun":{"pending":true}}\\n'); }, 1100);`,
      'setInterval(() => {}, 1000);',
    ].join('\n');
    const leaderProgram = [
      'const { spawn } = require("node:child_process");',
      `spawn(${JSON.stringify(process.execPath)}, ["-e", ${JSON.stringify(descendantProgram)}], { stdio: "inherit" });`,
      'process.exit(0);',
    ].join('\n');
    const execution = executeOwnedCommand(
      process.execPath,
      ['-e', leaderProgram],
      spawn,
      'Tauri shell delayed sidecar regression',
      {
        cwd: process.cwd(),
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
    const child = execution.child;
    if (!('once' in child))
      throw new Error('Tauri shell delayed sidecar fixture failed to launch');
    child.stdout?.pipe(appLog, { end: false });
    child.stderr?.pipe(appLog, { end: false });

    let receipt: TauriShellFixtureCleanupReceipt | undefined;
    const driver = {
      close: vi.fn(async () => {
        throw new Error('injected WebDriver close failure');
      }),
    };
    const stop = createMemoizedTauriShellFixtureStop({
      driver,
      execution,
      appLog,
      stationRoot,
      onReceipt: (value) => {
        receipt = value;
      },
    });

    try {
      if (child.exitCode === null && child.signalCode === null) {
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(
            () => reject(new Error('owned fixture leader did not exit')),
            5_000,
          );
          child.once('exit', () => {
            clearTimeout(timeout);
            resolve();
          });
        });
      }
      assert.equal(child.exitCode, 0);
      const readyDeadline = Date.now() + 5_000;
      while (!existsSync(descendantReady) && Date.now() < readyDeadline)
        await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal(
        existsSync(descendantReady),
        true,
        'the sidecar-like descendant must confirm it is running before parent exit cleanup',
      );
      assert.equal(
        execution.isAlive(),
        true,
        'the delayed descendant should remain in the owned group after its leader exits',
      );
      await new Promise((resolve) => setTimeout(resolve, 350));

      await assert.rejects(stop(), /injected WebDriver close failure/);
      await assert.rejects(stop(), /injected WebDriver close failure/);
      assert.equal(driver.close.mock.calls.length, 1);
      assert.equal(appLog.closed, true);
      assert.equal(receipt?.processGroupId, child.pid);
      assert.equal(receipt?.processGroupSettled, true);
      assert.equal(receipt?.childExitCodeBeforeTermination, 0);
      assert.equal(receipt?.appConfigRemoved, true);
      assert.equal(receipt?.fixtureRootExistsImmediatelyAfterRemoval, false);
      assert.equal(receipt?.fixtureRootExistsAfterQuietPeriod, false);
      assert.equal(receipt?.fixtureRootRemoved, true);

      // Let the descendant's delayed write deadline pass. A parent-PID-only stop
      // would have returned while it was alive and this would find a recreated
      // root/config; process-group settlement prevents the write entirely.
      await new Promise((resolve) => setTimeout(resolve, 800));
      assert.equal(existsSync(appConfig), false);
      assert.equal(existsSync(stationRoot), false);
    } finally {
      await stop().catch(() => {});
    }
  },
);
