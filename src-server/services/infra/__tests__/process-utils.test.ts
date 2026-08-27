import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { describe, expect, test, vi } from 'vitest';
import { terminateProcessTree } from '../process-utils.js';

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

describe('terminateProcessTree', () => {
  test('awaits Windows tree termination and confirms forced taskkill', async () => {
    const invocations: Array<{ command: string; args: readonly string[] }> = [];
    const spawnProcess = vi.fn((command: string, args: readonly string[]) => {
      invocations.push({ command, args });
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('exit', 0));
      return child;
    });
    const processHandle = {
      pid: 42,
      exitCode: null,
      signalCode: null,
      kill: vi.fn(() => true),
    };

    await terminateProcessTree(processHandle, {
      processGroup: true,
      graceMs: 1,
      killConfirmMs: 1,
      platform: 'win32',
      spawnProcess: spawnProcess as any,
    });

    expect(invocations).toEqual([
      { command: 'taskkill', args: ['/pid', '42', '/t'] },
      { command: 'taskkill', args: ['/pid', '42', '/t', '/f'] },
    ]);
    expect(processHandle.kill).not.toHaveBeenCalled();
  });

  test('bounds a Windows taskkill helper that never settles', async () => {
    const helpers: Array<EventEmitter & { kill: ReturnType<typeof vi.fn> }> =
      [];
    const spawnProcess = vi.fn(() => {
      const child = Object.assign(new EventEmitter(), { kill: vi.fn() });
      helpers.push(child);
      return child;
    });
    const processHandle = {
      pid: 42,
      exitCode: null,
      signalCode: null,
      kill: vi.fn(() => true),
    };

    await expect(
      terminateProcessTree(processHandle, {
        processGroup: true,
        graceMs: 1,
        killConfirmMs: 1,
        taskkillTimeoutMs: 10,
        platform: 'win32',
        spawnProcess: spawnProcess as any,
      }),
    ).rejects.toThrow('taskkill did not settle within 10ms');

    expect(spawnProcess).toHaveBeenCalledTimes(2);
    expect(helpers).toHaveLength(2);
    expect(helpers.every((helper) => helper.kill.mock.calls.length === 1)).toBe(
      true,
    );
  });

  test.skipIf(process.platform === 'win32')(
    'kills a signal-resistant grandchild in the owned process group',
    async () => {
      const parent = spawn(
        process.execPath,
        [
          '-e',
          [
            "const { spawn } = require('node:child_process');",
            "const child = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)\"], { stdio: 'ignore' });",
            'process.stdout.write(String(child.pid));',
            "process.on('SIGTERM', () => {});",
            'setInterval(() => {}, 1000);',
          ].join(' '),
        ],
        { detached: true, stdio: ['ignore', 'pipe', 'ignore'] },
      );
      const grandchildPid = await new Promise<number>((resolve, reject) => {
        parent.once('error', reject);
        parent.stdout.once('data', (chunk) =>
          resolve(Number(chunk.toString())),
        );
      });

      try {
        expect(processExists(parent.pid!)).toBe(true);
        expect(processExists(grandchildPid)).toBe(true);

        await terminateProcessTree(parent, {
          processGroup: true,
          graceMs: 50,
          killConfirmMs: 2_000,
        });

        expect(processExists(parent.pid!)).toBe(false);
        expect(processExists(grandchildPid)).toBe(false);
      } finally {
        try {
          process.kill(-parent.pid!, 'SIGKILL');
        } catch {
          // The expected path already removed the process group.
        }
      }
    },
  );
});
