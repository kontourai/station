/**
 * An engine scope's holder, as real processes: the scope's shell wrapper
 * (`engineScopeWrapper`, run by /bin/sh exactly as systemd-run execs it)
 * starts the holder and then execs the engine. Codex is spawned detached and
 * its teardown kills the engine's whole process group
 * (`terminateCodexProcess`, processGroup: true); the holder must survive that
 * and hold none of the engine's pipes, or the engine's stdio never closes.
 * That the holder lands in the scope's cgroup is covered by the Linux
 * workload process fixture.
 */
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readdirSync, readlinkSync } from 'node:fs';
import { chmod, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { engineScopeWrapper } from '../workload-resources.js';

const tempDir = trackTempDirs();
const started: number[] = [];
afterEach(() => {
  for (const pid of started.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
});

function processes(): Array<{ pid: number; pgid: number; args: string }> {
  return execFileSync('/bin/ps', ['-A', '-o', 'pid=,pgid=,args='], {
    encoding: 'utf8',
    windowsHide: true,
  })
    .split('\n')
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
    .filter((match) => match !== null)
    .map((match) => ({
      pid: Number(match[1]),
      pgid: Number(match[2]),
      args: match[3] as string,
    }));
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * setsid(1) where the host has it (Linux); elsewhere a stand-in with the same
 * contract for `-f`: fork, new session in the child, exec with every inherited
 * descriptor kept (Perl closes only descriptors it opened itself).
 */
async function setsidBinary(directory: string): Promise<string> {
  if (existsSync('/usr/bin/setsid')) return '/usr/bin/setsid';
  const standIn = join(directory, 'setsid');
  await writeFile(
    standIn,
    '#!/usr/bin/perl\nuse POSIX;\nshift @ARGV if $ARGV[0] eq "-f";\nexit 0 if fork;\nPOSIX::setsid();\nexec { $ARGV[0] } @ARGV or exit 127;\n',
  );
  await chmod(standIn, 0o755);
  return standIn;
}

describe('engine scope holder', () => {
  test('starts before the engine in its own session, holds no engine pipe, and survives the group kill that tears a Codex engine down', async () => {
    const directory = tempDir('scope-holder-');
    // A sleep under a unique path names this test's holder in ps.
    const sleep = join(directory, 'holder-sleep');
    await symlink(
      existsSync('/usr/bin/sleep') ? '/usr/bin/sleep' : '/bin/sleep',
      sleep,
    );
    const bash = ['/usr/bin/bash', '/bin/bash'].find((path) =>
      existsSync(path),
    );
    if (!bash) throw new Error('this test needs bash(1)');
    const script = engineScopeWrapper({
      setsid: await setsidBinary(directory),
      sleep,
      bash,
    });
    // Stdio, Node IPC-style and browser extra pipes at descriptors 0-4, and a
    // pipe at 11 standing for a descriptor Station itself inherited without
    // close-on-exec (a harness, a terminal, a CI step): above what dash can
    // name, so only the holder's own sweep closes it.
    const engine: ChildProcess = spawn(
      '/bin/sh',
      [
        '-c',
        script,
        'station-workload',
        process.execPath,
        '-e',
        'const fs=require("node:fs");fs.writeSync(3,"fd3");fs.writeSync(4,"fd4");console.log("ready");setInterval(()=>{},1000)',
      ],
      {
        detached: true,
        stdio: [
          'pipe',
          'pipe',
          'pipe',
          'pipe',
          'pipe',
          'ignore',
          'ignore',
          'ignore',
          'ignore',
          'ignore',
          'ignore',
          'pipe',
        ],
        windowsHide: true,
      },
    );
    const enginePid = engine.pid as number;
    started.push(enginePid);
    const closed = once(engine, 'close');
    let extra = '';
    for (const stream of [engine.stdio[3], engine.stdio[4]])
      if (stream && 'on' in stream)
        stream.on('data', (data) => {
          extra += data;
        });
    await once(engine.stdout!, 'data');
    // Only the holder's descriptors 3-9 are closed: the engine keeps its own.
    await expect.poll(() => extra).toBe('fd3fd4');
    // The holder was forked before the engine's exec.
    const holders = processes().filter(
      (entry) => entry.args === `${sleep} 2147483647`,
    );
    expect(holders).toHaveLength(1);
    const holder = holders[0]!;
    started.push(holder.pid);
    // Its own group (a session leader), not the engine's and not Station's.
    expect(holder.pgid).toBe(holder.pid);
    expect(holder.pgid).not.toBe(enginePid);
    expect(holder.pgid).not.toBe(
      processes().find((entry) => entry.pid === process.pid)?.pgid,
    );
    // Exactly /dev/null on 0-2 and nothing else, whatever the parent left
    // open: the full list (each link's target) is in the failure message.
    if (existsSync(`/proc/${holder.pid}/fd`)) {
      const fds = readdirSync(`/proc/${holder.pid}/fd`).map((fd) => {
        let target: string;
        try {
          target = readlinkSync(`/proc/${holder.pid}/fd/${fd}`);
        } catch (error) {
          target = String(error);
        }
        return [fd, target];
      });
      expect(fds, JSON.stringify(fds)).toEqual([
        ['0', '/dev/null'],
        ['1', '/dev/null'],
        ['2', '/dev/null'],
      ]);
    }
    process.kill(-enginePid, 'SIGKILL');
    // Every engine pipe closes: the holder kept none of them open.
    const late = new Promise((resolve) => setTimeout(resolve, 5_000, 'late'));
    expect(await Promise.race([closed.then(() => 'closed'), late])).toBe(
      'closed',
    );
    expect(alive(holder.pid)).toBe(true);
  });
});
