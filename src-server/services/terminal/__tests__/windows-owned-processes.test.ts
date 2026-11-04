/**
 * #3994 which Windows processes a terminating command still owns. Parent
 * pids are recorded at creation and reused quickly, so a process is the
 * command's only when the parent it names provably held that pid when it
 * was created. Synthetic process tables; the rule is platform-independent.
 */
import { describe, expect, it } from 'vitest';
import type { WindowsProcessEntry } from '../../infra/process-utils.js';
import {
  attributeWindowsProcesses,
  type OwnedWindowsProcess,
} from '../windows-owned-processes.js';

const SELF = 1;
const entry = (
  pid: number,
  ppid: number,
  createdUs: number,
): WindowsProcessEntry => ({ pid, ppid, createdUs: BigInt(createdUs) });

function seeded(leader: WindowsProcessEntry, seenUs: number) {
  return new Map<number, OwnedWindowsProcess>([
    [
      leader.pid,
      {
        pid: leader.pid,
        createdUs: leader.createdUs,
        lastSeenUs: BigInt(seenUs),
      },
    ],
  ]);
}

const pids = (entries: WindowsProcessEntry[]) =>
  entries.map((item) => item.pid).sort((a, b) => a - b);

describe('attributeWindowsProcesses', () => {
  it("finds the leader's live descendants, however deep", () => {
    const leader = entry(100, SELF, 10);
    const owned = seeded(leader, 50);
    const alive = attributeWindowsProcesses(
      owned,
      [leader, entry(200, 100, 20), entry(300, 200, 30), entry(400, 7, 15)],
      50n,
      SELF,
    );
    expect(pids(alive)).toEqual([100, 200, 300]);
  });

  it('keeps attributing an orphan its exited parent started while seen alive', () => {
    const leader = entry(100, SELF, 10);
    const owned = seeded(leader, 50);
    attributeWindowsProcesses(owned, [leader, entry(200, 100, 20)], 50n, SELF);
    // The child exited; the grandchild it started at 40 (before it was last
    // seen alive at 50) remains, its parent pid naming a dead process.
    const alive = attributeWindowsProcesses(
      owned,
      [entry(300, 200, 40)],
      60n,
      SELF,
    );
    expect(pids(alive)).toEqual([300]);
  });

  it('never attributes a process whose parent pid was reused by another process', () => {
    const leader = entry(100, SELF, 10);
    const owned = seeded(leader, 50);
    // The leader exited; pid 100 now names an unrelated process created at
    // 70, and that process's child names pid 100 as its parent.
    const alive = attributeWindowsProcesses(
      owned,
      [entry(100, 9, 70), entry(500, 100, 80)],
      90n,
      SELF,
    );
    expect(alive).toEqual([]);
  });

  it('does not attribute a child created after its exited parent was last seen', () => {
    const leader = entry(100, SELF, 10);
    const owned = seeded(leader, 50);
    // Parent 100 is gone; this child was created at 55, after the snapshot
    // that last saw 100 alive: 100 may have been a different process then.
    const alive = attributeWindowsProcesses(
      owned,
      [entry(600, 100, 55)],
      60n,
      SELF,
    );
    expect(alive).toEqual([]);
  });

  it('does not attribute a process created before the parent it names', () => {
    const leader = entry(100, SELF, 10);
    const owned = seeded(leader, 50);
    const alive = attributeWindowsProcesses(
      owned,
      [leader, entry(700, 100, 5)],
      50n,
      SELF,
    );
    expect(pids(alive)).toEqual([100]);
  });

  it('never attributes Station itself', () => {
    const leader = entry(100, 42, 10);
    const owned = seeded(leader, 50);
    const alive = attributeWindowsProcesses(
      owned,
      [leader, entry(42, 100, 20)],
      50n,
      42,
    );
    expect(pids(alive)).toEqual([100]);
  });
});
