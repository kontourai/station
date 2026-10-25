import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
type Row = { pid: number; parent: number; group: number };

function signal(group: number, name: NodeJS.Signals): boolean {
  if (!Number.isSafeInteger(group) || group <= 1)
    throw new Error('Unsafe terminal process group');
  try {
    process.kill(-group, name);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH')
      return false;
    throw error;
  }
}

async function snapshot(timeout: number): Promise<Map<number, Row>> {
  const { stdout } = await run('ps', ['-axo', 'pid=,ppid=,pgid='], {
    timeout,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  });
  const rows = new Map<number, Row>();
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
    if (!match) throw new Error('Invalid terminal process census');
    const pid = Number(match[1]);
    const parent = Number(match[2]);
    const group = Number(match[3]);
    if (![pid, parent, group].every(Number.isSafeInteger))
      throw new Error('Invalid terminal process identity');
    rows.set(pid, { pid, parent, group });
  }
  return rows;
}

function groupsFor(rows: Map<number, Row>, root: number): Set<number> {
  const children = new Map<number, Row[]>();
  for (const row of rows.values()) {
    const list = children.get(row.parent) ?? [];
    list.push(row);
    children.set(row.parent, list);
  }
  const queue = [root],
    groups = new Set<number>(),
    seen = new Set<number>();
  for (let i = 0; i < queue.length; i++) {
    const pid = queue[i]!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    if (seen.size > 4096)
      throw new Error('Terminal descendant census capacity reached');
    const row = rows.get(pid);
    if (!row) continue;
    groups.add(row.group);
    for (const child of children.get(pid) ?? []) queue.push(child.pid);
  }
  return groups;
}

/** Freeze the owned PTY tree before killing groups; job-control children have separate groups. */
export async function terminatePtyProcessGroups(
  root: number,
  current: () => boolean,
): Promise<void> {
  const frozen = new Set<number>();
  const errors: unknown[] = [];
  const deadline = performance.now() + 3000;
  let completed = false;
  try {
    for (let round = 0; round < 8; round++) {
      if (!current())
        throw new Error('Terminal process ownership ended before cleanup');
      const remaining = Math.floor(deadline - performance.now());
      if (remaining <= 0)
        throw new Error('Terminal process groups did not quiesce');
      const rows = await snapshot(Math.min(1000, remaining));
      if (!current() || rows.get(root)?.group !== root)
        throw new Error('Terminal process group ownership unavailable');
      const groups = groupsFor(rows, root);
      let added = false;
      for (const group of groups) {
        if (!frozen.has(group) && signal(group, 'SIGSTOP')) {
          frozen.add(group);
          added = true;
        }
      }
      if (added) continue;
      // Children first, with parents still stopped, so parent exit cannot
      // orphan jobs or release their identities before the signals finish.
      for (const group of [...groups].reverse()) {
        signal(group, 'SIGKILL');
        frozen.delete(group);
      }
      completed = true;
      break;
    }
    if (!completed) throw new Error('Terminal process groups did not quiesce');
  } catch (error) {
    errors.push(error);
  }
  for (const group of [...frozen].reverse()) {
    try {
      signal(group, 'SIGCONT');
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length)
    throw new AggregateError(errors, 'Terminal process-group cleanup failed');
}
