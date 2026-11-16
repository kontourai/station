import type { ChildWorkKind } from '@kontourai/station-contracts/child-work';

/**
 * A chat's running background work by kind: the engine's own children
 * (`agent`, `command`, `monitor`) and the chat's tool calls still running
 * after its turn ended (`tool`). The chat's background strip and its status
 * pill both name work by these counts, so they cannot disagree.
 */
export type BackgroundWorkCounts = Record<ChildWorkKind | 'tool', number>;

const NOUNS: Record<keyof BackgroundWorkCounts, [string, string]> = {
  agent: ['agent', 'agents'],
  command: ['command', 'commands'],
  monitor: ['monitor', 'monitors'],
  tool: ['tool', 'tools'],
};

const ORDER: (keyof BackgroundWorkCounts)[] = [
  'agent',
  'command',
  'monitor',
  'tool',
];

export function backgroundWorkCounts(
  children: readonly { workKind?: ChildWorkKind }[],
  runningToolCount: number,
): BackgroundWorkCounts {
  const counts: BackgroundWorkCounts = {
    agent: 0,
    command: 0,
    monitor: 0,
    tool: runningToolCount,
  };
  for (const child of children) counts[child.workKind ?? 'agent'] += 1;
  return counts;
}

export function backgroundWorkTotal(counts: BackgroundWorkCounts): number {
  return ORDER.reduce((total, kind) => total + counts[kind], 0);
}

/** "9 agents and 3 tools running", "1 command running"; empty for none. */
export function backgroundWorkRunningLabel(
  counts: BackgroundWorkCounts,
): string {
  const parts = ORDER.filter((kind) => counts[kind] > 0).map((kind) => {
    const [one, many] = NOUNS[kind];
    return `${counts[kind]} ${counts[kind] === 1 ? one : many}`;
  });
  if (parts.length === 0) return '';
  const joined =
    parts.length === 1
      ? parts[0]
      : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
  return `${joined} running`;
}
