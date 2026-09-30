import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
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
  'Priority=5, ExecutionTimeLimit=PT0S, RestartCount=255, RestartInterval=PT1M';

const SYSTEM32 = 'C:\\Windows\\System32';
const created: string[] = [];

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

  test('a schtasks-registered task gets no time limit and restarts on failure', () => {
    const dir = mkdtempSync(join(tmpdir(), 'station-2970-'));
    try {
      const wrapper = join(dir, 'station-probe.cmd');
      writeFileSync(wrapper, '@echo off\r\nexit /b 0\r\n');
      const registration = registerLikeInstall(wrapper);

      // The premise of #2970: without settings XML the task is limited to 72
      // hours and has no restart-on-failure.
      const before = taskXml(registration.taskName as string);
      console.log(`schtasks default settings XML:\n${before}`);
      expect(before).toContain(
        '<ExecutionTimeLimit>PT72H</ExecutionTimeLimit>',
      );
      expect(before).not.toContain('<RestartOnFailure>');
      expect(
        inspectServiceSchedulingPolicy(registration, { run: defaultRun }),
      ).toMatchObject({ expected: EXPECTED_TASK_SETTINGS, status: 'stale' });

      applyWindowsTaskSettings(registration, defaultRun);

      // Read back through the task's XML, independently of the PowerShell
      // formatter that the install and status share.
      const after = taskXml(registration.taskName as string);
      console.log(`settings XML after install:\n${after}`);
      expect(after).toContain('<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>');
      expect(after).toMatch(
        /<RestartOnFailure>\s*<Interval>PT1M<\/Interval>\s*<Count>255<\/Count>\s*<\/RestartOnFailure>/u,
      );
      expect(after).toContain('<Priority>5</Priority>');
      expect(
        inspectServiceSchedulingPolicy(registration, { run: defaultRun }),
      ).toEqual({
        expected: EXPECTED_TASK_SETTINGS,
        observed: EXPECTED_TASK_SETTINGS,
        status: 'current',
      });
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  // What RestartOnFailure buys: Task Scheduler reruns a wrapper that exited
  // non-zero, as a crashed `station service run` would. Its shortest
  // interval is one minute, so this waits for up to two and a half.
  test('Task Scheduler reruns a wrapper that exits non-zero', {
    timeout: 240_000,
  }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'station-2970-'));
    try {
      const wrapper = join(dir, 'station-probe.cmd');
      const runs = join(dir, 'runs.log');
      writeFileSync(
        wrapper,
        `@echo off\r\necho run %TIME%>>"${runs}"\r\nexit /b 3\r\n`,
      );
      const registration = registerLikeInstall(wrapper);
      applyWindowsTaskSettings(registration, defaultRun);
      const started = schtasks([
        '/Run',
        '/TN',
        registration.taskName as string,
      ]);
      expect(started.status, started.stderr).toBe(0);

      const deadline = Date.now() + 150_000;
      let lines: string[] = [];
      while (Date.now() < deadline) {
        try {
          lines = readFileSync(runs, 'utf8').split(/\r?\n/u).filter(Boolean);
        } catch {
          lines = [];
        }
        if (lines.length >= 2) break;
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
      console.log(`wrapper runs: ${JSON.stringify(lines)}`);
      const info = defaultRun(join(SYSTEM32, 'schtasks.exe'), [
        '/Query',
        '/TN',
        registration.taskName as string,
        '/V',
        '/FO',
        'LIST',
      ]);
      console.log(info.stdout);
      expect(lines.length).toBeGreaterThanOrEqual(2);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });
});

describe.runIf(!optedIn)('real Windows Task Scheduler settings', () => {
  test.skip('needs STATION_REAL_TASK_SCHEDULER=1 on Windows', () => {});
});
