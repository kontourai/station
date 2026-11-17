import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { constants } from 'node:os';
import { join } from 'node:path';

/**
 * Runs inside a fallow child's memory-capped user scope (#5111):
 *
 *     node fallow-memory-scope.mjs <events-file> <cgroup-dir|''> <command> [args...]
 *
 * Runs the command, then copies its scope's `memory.events` and `memory.peak`
 * to `<events-file>` before exiting with the command's status (128 + signal
 * number for a signal). The scope's cgroup is gone once its last process
 * exits, so only a process inside it can read why the analyzer died. An empty
 * `<cgroup-dir>` means this process's own cgroup (cgroup v2).
 */

function ownCgroupDirectory() {
  const line = readFileSync('/proc/self/cgroup', 'utf8')
    .split('\n')
    .find((entry) => entry.startsWith('0::'));
  if (!line) throw new Error('No cgroup v2 membership');
  return join('/sys/fs/cgroup', line.slice(3));
}

function recordMemory(eventsFile, cgroupDirectory) {
  try {
    const directory = cgroupDirectory || ownCgroupDirectory();
    const events = readFileSync(join(directory, 'memory.events'), 'utf8');
    let peak = '';
    try {
      peak = `peak ${readFileSync(join(directory, 'memory.peak'), 'utf8').trim()}\n`;
    } catch {
      // memory.peak needs Linux 5.19; the OOM verdict does not.
    }
    writeFileSync(eventsFile, `${events}${peak}`);
  } catch {
    // Nothing recorded: the caller reports the plain exit, not a budget verdict.
  }
}

const [eventsFile, cgroupDirectory, command, ...args] = process.argv.slice(2);
// The owner signals the whole process group, so an interruption ends this
// wrapper and the command together, exactly as it would end the command alone.
const child = spawn(command, args, { stdio: 'inherit', windowsHide: true });
child.on('error', (error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(127);
});
child.on('exit', (status, signal) => {
  recordMemory(eventsFile, cgroupDirectory);
  if (status !== null) process.exit(status);
  // Report a signal death as one, not as an exit status.
  process.kill(process.pid, signal);
  process.exit(128 + (constants.signals[signal] ?? 0));
});
