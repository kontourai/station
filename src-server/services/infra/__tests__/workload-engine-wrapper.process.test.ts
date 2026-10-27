/**
 * The engine scope wrapper, run by a real /bin/sh: the engine keeps the
 * wrapper's PID (exec), and the holder it leaves behind holds none of the
 * engine's pipes, so the parent sees stdout/stderr (and, on Linux, an extra
 * descriptor) close when the engine exits while the holder lives on.
 * systemd and cgroups are not involved here; the Linux process fixture covers
 * the scope itself.
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import type { Readable } from 'node:stream';
import { describe, expect, test } from 'vitest';
import { ENGINE_SCOPE_WRAPPER } from '../workload-resources.js';

function closed(stream: Readable, ms = 5000) {
  return Promise.race([
    once(stream, 'close').then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), ms)),
  ]);
}

describe('engine scope wrapper', () => {
  test('keeps the engine PID and holds none of its pipes after it exits', async () => {
    const child = spawn(
      '/bin/sh',
      [
        '-c',
        ENGINE_SCOPE_WRAPPER,
        'station-workload',
        process.execPath,
        '-e',
        'console.log(process.pid); require("node:fs").writeSync(3, "x")',
      ],
      { stdio: ['ignore', 'pipe', 'pipe', 'pipe'], detached: true },
    );
    const stdout = child.stdout as Readable;
    const stderr = child.stderr as Readable;
    try {
      let output = '';
      stdout.on('data', (chunk) => {
        output += chunk;
      });
      const extra = child.stdio[3] as Readable;
      extra.resume();
      const [stdoutClosed, stderrClosed, extraClosed] = await Promise.all([
        closed(stdout),
        closed(stderr),
        // Only Linux has /proc/self/fd for the holder to close inherited
        // descriptors by; elsewhere the extra pipe stays with the holder.
        process.platform === 'linux' ? closed(extra) : Promise.resolve(true),
      ]);
      expect(Number(output.trim())).toBe(child.pid);
      expect([stdoutClosed, stderrClosed, extraClosed]).toEqual([
        true,
        true,
        true,
      ]);
    } finally {
      // The holder shares the wrapper's process group.
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
  });
});
