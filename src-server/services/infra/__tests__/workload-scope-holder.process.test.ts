/**
 * The engine scope holder, as real processes: Codex is spawned detached and
 * its teardown kills the engine's whole process group (`terminateCodexProcess`,
 * processGroup: true) in the same tick the scope starts closing. The holder
 * must survive that, or the scope is collected before Station reads its
 * memory.events. Placement into the scope (systemd, cgroups) is covered by the
 * Linux process fixture.
 */
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { afterEach, describe, expect, test } from 'vitest';
import { spawnScopeHolder } from '../workload-resources.js';

const started: ChildProcess[] = [];
afterEach(() => {
  for (const child of started.splice(0)) {
    try {
      if (child.pid) process.kill(child.pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
});

function processGroup(pid: number): number {
  return Number(
    execFileSync('/bin/ps', ['-o', 'pgid=', '-p', String(pid)], {
      encoding: 'utf8',
      windowsHide: true,
    }).trim(),
  );
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('engine scope holder', () => {
  test('lives in its own process group and survives the group kill that tears a Codex engine down', async () => {
    const engine = spawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      },
    );
    started.push(engine);
    const holder = spawnScopeHolder();
    started.push(holder);
    const enginePid = engine.pid as number;
    const holderPid = holder.pid as number;
    expect(
      execFileSync('/bin/ps', ['-o', 'args=', '-p', String(holderPid)], {
        encoding: 'utf8',
        windowsHide: true,
      }).trim(),
    ).toBe('/bin/sleep 2147483647');
    // Its own group (leader), not the engine's and not Station's.
    expect(processGroup(holderPid)).toBe(holderPid);
    expect(processGroup(holderPid)).not.toBe(processGroup(enginePid));
    expect(processGroup(holderPid)).not.toBe(processGroup(process.pid));
    const exited = once(engine, 'exit');
    process.kill(-enginePid, 'SIGKILL');
    await exited;
    expect(alive(holderPid)).toBe(true);
  });
});
