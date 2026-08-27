import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';

import {
  executeOwnedProcess,
  terminateSuiteExecution,
  waitForSuiteSettlement,
} from '../../run-load-reliability.mjs';
import { runInstallerProcess } from './installer-process.js';

const temporaryRoots: string[] = [];

function temporaryRoot() {
  const root = mkdtempSync(path.join(tmpdir(), 'station-installer-process-'));
  temporaryRoots.push(root);
  return root;
}

async function waitUntilProcessExits(pid: number) {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`descendant ${pid} remained alive`);
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('owned installer process', () => {
  it('captures stdout, stderr, and nonzero status without blocking the runner', async () => {
    await expect(
      runInstallerProcess({
        command: process.execPath,
        args: [
          '-e',
          "process.stdout.write('out'); process.stderr.write('err'); process.exit(7)",
        ],
        env: process.env,
        timeoutMs: 1_000,
      }),
    ).resolves.toEqual({ status: 7, stdout: 'out', stderr: 'err' });
  });

  it('reports spawn failures directly', async () => {
    await expect(
      runInstallerProcess({
        command: path.join(temporaryRoot(), 'missing-command'),
        args: [],
        env: process.env,
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow(/failed to spawn macOS installer harness.*ENOENT/);
  });

  it('terminates the owned descendant tree when the deadline expires', async () => {
    const pidFile = path.join(temporaryRoot(), 'descendant.pid');
    const source = `
      const { spawn } = require('node:child_process');
      const { writeFileSync } = require('node:fs');
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        stdio: ['ignore', 'inherit', 'inherit'],
      });
      writeFileSync(process.env.PID_FILE, String(child.pid));
      process.on('SIGTERM', () => {
        child.once('exit', () => process.exit(0));
        child.kill('SIGTERM');
      });
      setInterval(() => {}, 1000);
    `;

    let timeoutError: unknown;
    try {
      await runInstallerProcess({
        command: process.execPath,
        args: ['-e', source],
        env: { ...process.env, PID_FILE: pidFile },
        timeoutMs: 100,
      });
    } catch (error) {
      timeoutError = error;
    }
    expect(timeoutError).toEqual(
      expect.objectContaining({
        message: expect.stringMatching(
          /^macOS installer harness exceeded 100ms/,
        ),
      }),
    );

    const descendantPid = Number(readFileSync(pidFile, 'utf8'));
    await waitUntilProcessExits(descendantPid);
  });

  it('settles after cooperative process-tree termination without escalation', async () => {
    const execution = executeOwnedProcess(
      process.execPath,
      [
        '-e',
        "process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000)",
      ],
      undefined,
      'cooperative child',
      { stdio: 'ignore' },
    );
    await new Promise((resolve) => setTimeout(resolve, 50));

    await expect(
      terminateSuiteExecution(execution, {
        processLabel: 'cooperative child',
        waitForSuiteSettlement,
        terminationGraceMs: 1_000,
        terminationForceMs: 1_000,
      }),
    ).resolves.toEqual({ settled: true, escalated: false, errors: [] });
  });

  it('rejects normal wrapper exit when an owned descendant stays alive', async () => {
    const pidFile = path.join(temporaryRoot(), 'detached-descendant.pid');
    const source = `
      const { spawn } = require('node:child_process');
      const { writeFileSync } = require('node:fs');
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        stdio: 'ignore',
      });
      child.unref();
      writeFileSync(process.env.PID_FILE, String(child.pid));
    `;

    await expect(
      runInstallerProcess({
        command: process.execPath,
        args: ['-e', source],
        env: { ...process.env, PID_FILE: pidFile },
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow(
      /^macOS installer harness exited while owned descendants remained alive/,
    );

    const descendantPid = Number(readFileSync(pidFile, 'utf8'));
    await waitUntilProcessExits(descendantPid);
  });

  it('fails closed when process-tree termination cannot be proven', async () => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    const never = new Promise<never>(() => {});

    await expect(
      runInstallerProcess(
        {
          args: [],
          env: process.env,
          timeoutMs: 1,
          terminationGraceMs: 1,
          terminationForceMs: 1,
        },
        {
          execute: () =>
            ({
              child,
              promise: never,
              isAlive: () => true,
              terminate: () => {
                throw new Error('soft kill failed');
              },
              forceTerminate: () => {
                throw new Error('force kill failed');
              },
            }) as never,
          terminate: async () => ({
            settled: false,
            escalated: true,
            errors: [
              {
                signal: 'SIGTERM',
                name: 'Error',
                message: 'soft kill failed',
              },
              {
                signal: 'SIGKILL',
                name: 'Error',
                message: 'force kill failed',
              },
            ],
          }),
          waitForSettlement: async () => false,
        } as never,
      ),
    ).rejects.toThrow(
      /cleanup failed: SIGTERM: soft kill failed; SIGKILL: force kill failed/,
    );
  });
});
