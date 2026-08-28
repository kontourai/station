import {
  SESSION_INVENTORY_GROUP_IDS,
  type SessionInventoryGroup,
  type SessionInventoryGroupPage,
  type SessionInventoryGroupId,
  type SessionInventoryProjection,
  type SessionInventoryRow,
  type SessionInventoryScope,
} from '@kontourai/station-contracts/session-inventory';

export function mergeSessionInventoryGroupPages(
  projection: SessionInventoryProjection | undefined,
  pages: readonly SessionInventoryGroupPage[],
  scope: SessionInventoryScope,
): SessionInventoryProjection | undefined {
  if (!projection || JSON.stringify(projection.scope) !== JSON.stringify(scope))
    return undefined;
  let current = projection;
  for (const page of pages) {
    if (JSON.stringify(page.scope) !== JSON.stringify(scope)) return undefined;
    if (
      scope.kind === 'current-answer' &&
      (JSON.stringify(page.basis) !== JSON.stringify(current.basis) ||
        JSON.stringify(page.basisBinding) !==
          JSON.stringify(current.basisBinding))
    )
      return undefined;
    const existing = current.groups.find((group) => group.id === page.group.id);
    if (!existing) return undefined;
    const rows = [...existing.items];
    for (const row of page.group.items) {
      const prior = rows.find((item) => item.key === row.key);
      if (prior && JSON.stringify(prior) !== JSON.stringify(row))
        return undefined;
      if (!prior) rows.push(row);
    }
    current = {
      ...current,
      groups: current.groups.map((group) =>
        group.id === page.group.id ? { ...page.group, items: rows } : group,
      ),
    };
  }
  return current;
}

export type SessionInventoryDensity = 'compact' | 'full';
export type SessionInventorySelection = {
  scope: SessionInventoryScope;
  groupId: SessionInventoryGroupId;
  itemKey?: string;
};
export type SessionInventoryAction = 'inspect-output' | 'keep-file' | 'keep-pr';

export type SessionInventoryViewItem = {
  key: string;
  label: string;
  relation: 'Contributed to this answer' | 'Context from this Session';
  classification: 'current' | 'kept';
  actions: readonly SessionInventoryAction[];
  row?: SessionInventoryRow;
};
export type SessionInventoryLiveItem = {
  key: string;
  kind: 'tool' | 'agent' | 'approval';
  label: string;
};
export type SessionInventoryViewGroup = {
  id: SessionInventoryGroupId;
  key: string;
  label: string;
  count: string | null;
  state: SessionInventoryGroup['state'];
  stateCopy: string;
  gaps: readonly string[];
  items: readonly SessionInventoryViewItem[];
  continuation?: string;
  selected: boolean;
  selectedItemKey?: string;
  focusKey: string;
};
export type SessionInventoryViewModel = {
  density: SessionInventoryDensity;
  scope: SessionInventoryScope;
  scopeLabel: string;
  groups: readonly SessionInventoryViewGroup[];
  selection: SessionInventorySelection;
  repairedSelection: boolean;
};

const labels: Readonly<Record<SessionInventoryGroupId, string>> = {
  inputs: 'Inputs',
  sources: 'Sources',
  execution: 'Execution',
  decisions: 'Decisions',
  outputs: 'Outputs',
  'verification-delivery': 'Verification & delivery',
  'live-now': 'Live now',
  kept: 'Kept',
  attention: 'Attention',
  resources: 'Resources',
};

function scopeLabel(scope: SessionInventoryScope): string {
  switch (scope.kind) {
    case 'current-answer':
      return 'Current answer';
    case 'whole-session':
      return 'Whole Session';
    case 'kept-in-task':
      return `Kept in Task “${scope.taskId}”`;
  }
}

function sameScope(
  left: SessionInventoryScope,
  right: SessionInventoryScope,
): boolean {
  return (
    left.kind === right.kind &&
    left.sessionId === right.sessionId &&
    (left.kind !== 'current-answer' ||
      (right.kind === 'current-answer' && left.turnId === right.turnId)) &&
    (left.kind !== 'kept-in-task' ||
      (right.kind === 'kept-in-task' && left.taskId === right.taskId))
  );
}

function stateCopy(group: SessionInventoryGroup, label: string): string {
  switch (group.state) {
    case 'available':
      return group.items.length
        ? ''
        : `No ${label.toLocaleLowerCase()} are available.`;
    case 'empty':
      return `No ${label.toLocaleLowerCase()} were recorded for this scope.`;
    case 'not-captured':
      return 'Not captured by this owner.';
    case 'restricted':
      return 'This owner is restricted.';
    case 'unavailable':
      return 'This owner is unavailable.';
    case 'unsupported-version':
      return 'This owner does not provide this projection version.';
    case 'corrupt':
      return 'This owner returned an invalid projection.';
  }
}
function gapCopy(kind: SessionInventoryGroup['gaps'][number]['kind']): string {
  switch (kind) {
    case 'not-captured':
      return 'Not captured by this owner.';
    case 'restricted':
      return 'This owner is restricted.';
    case 'unavailable':
      return 'This owner is unavailable.';
    case 'unsupported-version':
      return 'This owner does not provide this projection version.';
    case 'corrupt':
      return 'This owner returned an invalid projection.';
  }
}

function itemLabel(row: SessionInventoryRow): string {
  switch (row.kind) {
    case 'thread-authored-input':
      return row.inputKind === 'attachment'
        ? 'Attachment'
        : row.inputKind === 'steer'
          ? 'Steer'
          : 'Authored message';
    case 'surface-answer-contribution':
      return 'Answer contribution';
    case 'flow-agents-narrative':
      return 'Retained narrative';
    case 'thread-tool-result':
      return row.name;
    case 'station-plan-snapshot':
      return `Plan snapshot ${row.revision}`;
    case 'station-request-decision':
      return `Request ${row.status}`;
    case 'station-delegation':
      return 'Delegation';
    case 'station-session-output':
      return (
        row.output.label ??
        (row.output.descriptor.kind === 'workspace-file'
          ? row.output.descriptor.relativePath
          : 'Pull request')
      );
    case 'flow-gate-verdict':
      return `Gate ${row.verdict}`;
    case 'flow-policy-verdict':
      return `Policy ${row.verdict}`;
    case 'gate-evaluation':
      return `Gate evaluation ${row.verdict}`;
    case 'task-kept-answer':
      return 'Kept answer';
    case 'task-kept-input':
      return 'Kept input';
    case 'task-kept-result':
      return 'Kept result';
    case 'task-kept-gate':
      return 'Kept gate evaluation';
    case 'task-kept-output':
      return 'Kept output';
    case 'task-kept-pull-request':
      return 'Kept pull request';
    case 'station-resource-summary':
      return 'Resource summary';
  }
}

function actions(row: SessionInventoryRow): readonly SessionInventoryAction[] {
  if (row.kind !== 'station-session-output') return [];
  return row.output.descriptor.kind === 'workspace-file'
    ? ['inspect-output', 'keep-file']
    : ['inspect-output', 'keep-pr'];
}

function toItem(
  row: SessionInventoryRow,
  groupId: SessionInventoryGroupId,
): SessionInventoryViewItem {
  return {
    key: row.key,
    label: itemLabel(row),
    relation: row.relations.includes('contributed-to')
      ? 'Contributed to this answer'
      : 'Context from this Session',
    classification:
      groupId === 'kept' || row.relations.includes('kept-in-task')
        ? 'kept'
        : 'current',
    actions: actions(row),
    row,
  };
}

/**
 * Presentation-only inventory model. It deliberately consumes only the
 * owner-projected transport; it neither joins records nor makes authority,
 * trust, completeness, or network decisions.
 */
export function buildSessionInventoryViewModel(
  projection: SessionInventoryProjection,
  selection: SessionInventorySelection,
  density: SessionInventoryDensity = 'full',
  liveItems: readonly SessionInventoryLiveItem[] = [],
): SessionInventoryViewModel {
  const byId = new Map(projection.groups.map((group) => [group.id, group]));
  const groups = SESSION_INVENTORY_GROUP_IDS.map((id) => {
    const group = byId.get(id) ?? {
      id,
      owner: { owner: 'station', id: 'missing-owner' },
      state: 'not-captured' as const,
      items: [],
      gaps: [{ kind: 'not-captured' as const }],
    };
    const items =
      id === 'live-now' && liveItems.length
        ? liveItems.map((live) => ({
            key: `session-inventory:live:${live.kind}:${live.key}`,
            label: live.label,
            relation: 'Context from this Session' as const,
            classification: 'current' as const,
            actions: [],
          }))
        : group.items.map((row) => toItem(row, id));
    return {
      id,
      key: `session-inventory:group:${id}`,
      label: labels[id],
      count:
        id === 'live-now' && liveItems.length
          ? String(liveItems.length)
          : group.count
            ? group.count.kind === 'exact'
              ? String(group.count.value)
              : `${group.count.value}+`
            : null,
      state: id === 'live-now' && liveItems.length ? 'available' : group.state,
      stateCopy: stateCopy(group, labels[id]),
      gaps: group.gaps
        .map((gap) => gapCopy(gap.kind))
        .filter((gap) => gap !== stateCopy(group, labels[id])),
      items,
      ...(group.continuation ? { continuation: group.continuation } : {}),
      selected: false,
      focusKey: `session-inventory:group:${id}`,
    };
  });
  const requested =
    groups.find((group) => group.id === selection.groupId) ?? groups[0]!;
  const item = selection.itemKey
    ? requested.items.find((candidate) => candidate.key === selection.itemKey)
    : undefined;
  const repairedSelection =
    !sameScope(selection.scope, projection.scope) ||
    Boolean(selection.itemKey && !item) ||
    selection.groupId !== requested.id;
  const repaired: SessionInventorySelection = {
    scope: projection.scope,
    groupId: requested.id,
    ...(item ? { itemKey: item.key } : {}),
  };
  // Attention is a projection of every owner-qualified typed gap. It is
  // independent of the selected group and deliberately includes ordinary
  // not-captured/unsupported gaps, not only errors.
  const ownerGaps = [
    ...new Set(
      groups
        .filter((group) => group.id !== 'attention')
        .flatMap((group) => group.gaps),
    ),
  ];
  const withAttention = groups.map((group) =>
    group.id === 'attention' && ownerGaps.length
      ? {
          ...group,
          gaps: [
            ...group.gaps,
            ...ownerGaps.filter((gap) => !group.gaps.includes(gap)),
          ],
          stateCopy: 'Some owner context needs attention.',
        }
      : group,
  );
  return {
    density,
    scope: projection.scope,
    scopeLabel: scopeLabel(projection.scope),
    groups: withAttention.map((group) =>
      group.id === requested.id
        ? {
            ...group,
            selected: true,
            ...(item ? { selectedItemKey: item.key } : {}),
          }
        : group,
    ),
    selection: repaired,
    repairedSelection,
  };
}

/** Portable density is a local presentation choice; it never changes authority. */
export function buildSessionInventoryCompactViewModel(
  projection: SessionInventoryProjection,
  selection: SessionInventorySelection,
): SessionInventoryViewModel {
  return buildSessionInventoryViewModel(projection, selection, 'compact');
}
