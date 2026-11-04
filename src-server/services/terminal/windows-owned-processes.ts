/**
 * Which live Windows processes a command still owns, from successive
 * process-table snapshots (#3994). Windows has no process group to signal;
 * each process records the pid of the parent that created it, and pids are
 * reused quickly. A process is attributed to the command only when a parent
 * it names is a process already attributed, by pid AND creation time, that
 * provably held that pid when the child was created (the same birth-order
 * rule as `verifiedWindowsProcessTree` from the owned-process sweep, #3873).
 *
 * The parent provably held its pid at the child's creation when it was
 * created no later than the child, and was seen alive in a snapshot that
 * began no earlier than the child's creation (or is alive now). A child
 * created after its parent was last seen alive, by a parent that has since
 * exited, is not attributed: its parent pid may name a later process.
 */
import type { WindowsProcessEntry } from '../infra/process-utils.js';

/** A process attributed to the command, by identity. */
export interface OwnedWindowsProcess {
  pid: number;
  /** Creation time, µs since 1601 (as the process table reports it). */
  createdUs: bigint;
  /** The start of the latest snapshot that saw it alive. */
  lastSeenUs: bigint;
}

const UNIX_EPOCH_FROM_1601_US = 11_644_473_600_000_000n;

/** Now, in the process table's clock (µs since 1601 UTC). */
export function windowsNowUs(now = Date.now()): bigint {
  return BigInt(now) * 1000n + UNIX_EPOCH_FROM_1601_US;
}

/**
 * Updates `owned` from a snapshot that began at `snapshotStartUs` and
 * returns the attributed processes alive in it. `owned` keeps processes that
 * have exited, so their children created while they lived stay attributable.
 */
export function attributeWindowsProcesses(
  owned: Map<number, OwnedWindowsProcess>,
  table: readonly WindowsProcessEntry[],
  snapshotStartUs: bigint,
  self = process.pid,
): WindowsProcessEntry[] {
  const same = (entry: WindowsProcessEntry) =>
    owned.get(entry.pid)?.createdUs === entry.createdUs;
  const alive = new Set<number>();
  for (const entry of table)
    if (same(entry)) {
      alive.add(entry.pid);
      const known = owned.get(entry.pid)!;
      known.lastSeenUs = snapshotStartUs;
    }
  let added = true;
  while (added) {
    added = false;
    for (const entry of table) {
      if (entry.pid === self || entry.pid === entry.ppid || same(entry))
        continue;
      const parent = owned.get(entry.ppid);
      if (
        !parent ||
        entry.createdUs < parent.createdUs ||
        (!alive.has(parent.pid) && entry.createdUs > parent.lastSeenUs)
      )
        continue;
      // A pid now naming a different process than the one recorded: the
      // record is replaced only by a process this snapshot proves is owned.
      owned.set(entry.pid, {
        pid: entry.pid,
        createdUs: entry.createdUs,
        lastSeenUs:
          entry.createdUs > snapshotStartUs ? entry.createdUs : snapshotStartUs,
      });
      alive.add(entry.pid);
      added = true;
    }
  }
  return table.filter((entry) => alive.has(entry.pid) && same(entry));
}
