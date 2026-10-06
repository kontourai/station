import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../../../src-server/__test-utils__/temp-dirs.js';
import { defaultRun, type ServiceRegistration } from '../commands/service.js';
import { inspectServiceSchedulingPolicy } from '../commands/service-scheduling.js';
import {
  applyWindowsTaskSettings,
  renderWindowsTaskInvocation,
} from '../commands/service-windows.js';

/**
 * Real Task Scheduler evidence for #2970. It registers throwaway tasks with
 * the same `schtasks /Create` shape as `station service install`, so it runs
 * only where a job opts in (the Windows leg of install-smoke.yml). Opting in
 * anywhere but Windows fails instead of skipping.
 */
const optedIn = process.env.STATION_REAL_TASK_SCHEDULER === '1';

// Pinned independently of the constants under test.
const EXPECTED_TASK_SETTINGS =
  'Priority=5, ExecutionTimeLimit=PT0S, RestartCount=255, RestartInterval=PT1M, DisallowStartIfOnBatteries=False, StopIfGoingOnBatteries=False';

const SYSTEM32 = 'C:\\Windows\\System32';
const created: string[] = [];
const makeTempDir = trackTempDirs();

function schtasks(args: string[]) {
  return defaultRun(join(SYSTEM32, 'schtasks.exe'), args);
}

function currentAccount(): string {
  const result = defaultRun(join(SYSTEM32, 'whoami.exe'), [
    '/user',
    '/fo',
    'csv',
    '/nh',
  ]);
  expect(result.status, result.stderr).toBe(0);
  const account = result.stdout?.trim().match(/^"((?:[^"]|"")*)",/u)?.[1];
  expect(account, result.stdout).toBeDefined();
  return (account as string).replaceAll('""', '"');
}

/** Register a task exactly as `installWindowsService` does, minus settings. */
function registerLikeInstall(wrapperPath: string): ServiceRegistration {
  const taskName = `\\KontourStation-ci-2970-${process.pid}-${created.length}`;
  const result = schtasks([
    '/Create',
    '/TN',
    taskName,
    '/TR',
    renderWindowsTaskInvocation(wrapperPath),
    '/SC',
    'ONLOGON',
    '/RL',
    'LIMITED',
    '/RU',
    currentAccount(),
    '/F',
  ]);
  expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
  created.push(taskName);
  return { platform: 'win32', taskName, unitPath: wrapperPath };
}

function taskXml(taskName: string): string {
  const result = schtasks(['/Query', '/TN', taskName, '/XML']);
  expect(result.status, result.stderr).toBe(0);
  return result.stdout ?? '';
}

afterEach(() => {
  for (const taskName of created.splice(0)) {
    schtasks(['/End', '/TN', taskName]);
    schtasks(['/Delete', '/TN', taskName, '/F']);
  }
});

describe.runIf(optedIn)('real Windows Task Scheduler settings', () => {
  test('runs on Windows', () => {
    expect(process.platform).toBe('win32');
  });

  test('a schtasks-registered task gets no time limit and no battery rules', () => {
    const dir = makeTempDir('station-2970-');
    const wrapper = join(dir, 'station-probe.cmd');
    writeFileSync(wrapper, '@echo off\r\nexit /b 0\r\n');
    const registration = registerLikeInstall(wrapper);

    // The premise of #2970, as a Windows runner showed it: without settings
    // XML the task carries no ExecutionTimeLimit element (the scheduler
    // applies 72 hours), no restart-on-failure, and both battery rules on.
    const before = taskXml(registration.taskName as string);
    console.log(`schtasks default settings XML:\n${before}`);
    expect(before).not.toContain('<ExecutionTimeLimit>PT0S');
    expect(before).not.toContain('<RestartOnFailure>');
    expect(before).toContain(
      '<DisallowStartIfOnBatteries>true</DisallowStartIfOnBatteries>',
    );
    expect(before).toContain(
      '<StopIfGoingOnBatteries>true</StopIfGoingOnBatteries>',
    );
    const stale = inspectServiceSchedulingPolicy(registration, {
      run: defaultRun,
    });
    console.log(`default settings as status reads them: ${stale.observed}`);
    expect(stale).toMatchObject({
      expected: EXPECTED_TASK_SETTINGS,
      status: 'stale',
    });
    // The 72-hour limit is not in the XML but is what the scheduler applies.
    expect(stale.observed).toContain('ExecutionTimeLimit=PT72H');
    expect(stale.observed).toContain('DisallowStartIfOnBatteries=True');
    expect(stale.observed).toContain('StopIfGoingOnBatteries=True');

    applyWindowsTaskSettings(registration, defaultRun);

    // Read back through the task's XML, independently of the PowerShell
    // formatter that the install and status share.
    const after = taskXml(registration.taskName as string);
    console.log(`settings XML after install:\n${after}`);
    expect(after).toContain('<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>');
    // Windows writes Count before Interval; the order is not the claim.
    const restart = after.match(
      /<RestartOnFailure>([\s\S]*?)<\/RestartOnFailure>/u,
    )?.[1];
    expect(restart).toContain('<Count>255</Count>');
    expect(restart).toContain('<Interval>PT1M</Interval>');
    expect(after).toContain('<Priority>5</Priority>');
    expect(after).toContain(
      '<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
    );
    expect(after).toContain(
      '<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
    );
    expect(
      inspectServiceSchedulingPolicy(registration, { run: defaultRun }),
    ).toEqual({
      expected: EXPECTED_TASK_SETTINGS,
      observed: EXPECTED_TASK_SETTINGS,
      status: 'current',
    });
  });

  // What RestartOnFailure does NOT buy, measured here because the service
  // launcher's design depends on it: Task Scheduler does not rerun a wrapper
  // that exited non-zero, as a crashed `station service run` would. With a
  // one-minute interval, a second run would land well inside this wait.
  test('Task Scheduler does not rerun a wrapper that exits non-zero', {
    timeout: 180_000,
  }, async () => {
    const dir = makeTempDir('station-2970-');
    const wrapper = join(dir, 'station-probe.cmd');
    const runs = join(dir, 'runs.log');
    writeFileSync(
      wrapper,
      `@echo off\r\necho run %TIME%>>"${runs}"\r\nexit /b 3\r\n`,
    );
    const registration = registerLikeInstall(wrapper);
    applyWindowsTaskSettings(registration, defaultRun);
    const started = schtasks(['/Run', '/TN', registration.taskName as string]);
    expect(started.status, started.stderr).toBe(0);

    await new Promise((resolve) => setTimeout(resolve, 100_000));
    const lines = readFileSync(runs, 'utf8').split(/\r?\n/u).filter(Boolean);
    console.log(`wrapper runs: ${JSON.stringify(lines)}`);
    // If this ever becomes 2, Task Scheduler relaunches an exited service
    // after all, and the comment on the restart constants is out of date.
    expect(lines).toHaveLength(1);
  });
});

describe.runIf(!optedIn)('real Windows Task Scheduler settings', () => {
  test.skip('needs STATION_REAL_TASK_SCHEDULER=1 on Windows', () => {});
});
