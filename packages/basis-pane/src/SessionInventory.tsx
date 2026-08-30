import { type ReactNode, useEffect, useId, useRef } from 'react';
import type {
  SessionInventoryAction,
  SessionInventorySelection,
  SessionInventoryViewItem,
  SessionInventoryViewModel,
} from './session-inventory-view';

const inventorySections = [
  { label: 'Foundation', groups: ['inputs', 'sources'] },
  { label: 'Work', groups: ['work-items', 'execution', 'decisions'] },
  {
    label: 'Results',
    groups: ['outputs', 'verification-delivery'],
  },
  {
    label: 'Continuity',
    groups: ['live-now', 'kept', 'attention', 'resources'],
  },
] as const satisfies readonly {
  label: string;
  groups: readonly SessionInventoryViewModel['groups'][number]['id'][];
}[];

function countAnnouncement(
  group: SessionInventoryViewModel['groups'][number],
): string {
  if (group.count === null) return 'count unavailable';
  if (group.count.endsWith('+'))
    return `at least ${group.count.slice(0, -1)} items`;
  return `${group.count} ${group.count === '1' ? 'item' : 'items'}`;
}

function stateLabel(
  group: SessionInventoryViewModel['groups'][number],
): string {
  switch (group.state) {
    case 'available':
      return group.items.length ? 'Available' : 'No entries shown';
    case 'empty':
      return 'Empty';
    case 'not-captured':
      return 'Not captured';
    case 'restricted':
      return 'Restricted';
    case 'unavailable':
      return 'Unavailable';
    case 'unsupported-version':
      return 'Unsupported';
    case 'corrupt':
      return 'Invalid data';
  }
}

function SessionInventoryOverview({
  groups,
  scope,
  onSelect,
}: {
  groups: SessionInventoryViewModel['groups'];
  scope: SessionInventorySelection['scope'];
  onSelect(selection: SessionInventorySelection): void;
}) {
  const overviewIds = [
    'inputs',
    'sources',
    'outputs',
    'verification-delivery',
    'attention',
    'live-now',
  ] as const satisfies readonly SessionInventoryViewModel['groups'][number]['id'][];
  const pinnedOverviewIds = new Set<
    SessionInventoryViewModel['groups'][number]['id']
  >(overviewIds.slice(0, -1));
  const overviewGroups = groups.filter((group) => {
    if (group.id === 'live-now')
      return group.count !== null && group.count !== '0';
    return (
      pinnedOverviewIds.has(group.id) ||
      group.items.length > 0 ||
      (group.count !== null && group.count !== '0')
    );
  });

  return (
    <section className="session-inventory__overview" aria-label="At a glance">
      <div className="session-inventory__overview-copy">
        <p className="session-inventory__eyebrow">At a glance</p>
        <h3>What this session contains</h3>
        <p>
          Browse each authorized context group. Exact answer standing appears
          above when it is available.
        </p>
      </div>
      <div className="session-inventory__summary-grid">
        {overviewGroups.map((group) => (
          <button
            key={group.key}
            type="button"
            aria-label={`${group.label}: ${countAnnouncement(group)}. ${stateLabel(group)}.`}
            aria-current={group.selected ? 'true' : undefined}
            data-state={group.state}
            data-attention={group.gaps.length > 0 || undefined}
            onClick={() => onSelect({ scope, groupId: group.id })}
          >
            <span>{group.label}</span>
            <strong aria-hidden="true">{group.count ?? '—'}</strong>
            <small>{stateLabel(group)}</small>
            <span className="session-inventory__visually-hidden">
              {group.label}: {countAnnouncement(group)}. {stateLabel(group)}.
            </span>
          </button>
        ))}
      </div>
      <p className="session-inventory__scope-summary">
        Showing inventory for {modelScopeLabel(scope)}.
      </p>
    </section>
  );
}

function modelScopeLabel(scope: SessionInventorySelection['scope']): string {
  return scope.kind === 'current-answer'
    ? 'the current answer'
    : scope.kind === 'kept-in-task'
      ? 'the selected Task'
      : 'the whole Session';
}

export function SessionInventory({
  model,
  onSelect,
  onLoadMore,
  renderAction,
  repairFocus = false,
  scopeOptions = [model.scope],
  onScopeChange,
  focusGroupToken,
}: {
  model: SessionInventoryViewModel;
  onSelect(selection: SessionInventorySelection): void;
  onLoadMore?(
    groupId: SessionInventoryViewModel['groups'][number]['id'],
    continuation: string,
  ): void;
  renderAction?(input: {
    action: SessionInventoryAction;
    item: SessionInventoryViewItem;
  }): ReactNode;
  repairFocus?: boolean;
  scopeOptions?: readonly SessionInventorySelection['scope'][];
  onScopeChange?(scope: SessionInventorySelection['scope']): void;
  focusGroupToken?: number;
}) {
  const selected =
    model.groups.find((group) => group.selected) ?? model.groups[0]!;
  const occurrenceId = useId();
  const headingRefs = useRef(new Map<string, HTMLHeadingElement>());
  const headingId = (groupId: string) =>
    `${occurrenceId}-session-inventory-${groupId}-heading`;
  useEffect(() => {
    if (!repairFocus && focusGroupToken === undefined) return;
    headingRefs.current.get(selected.id)?.focus();
  }, [focusGroupToken, repairFocus, selected.id]);
  return (
    <section
      className="session-inventory"
      aria-labelledby={`${occurrenceId}-session-inventory-heading`}
    >
      <header className="session-inventory__header">
        <div>
          <p className="session-inventory__eyebrow">Session context</p>
          <h2 id={`${occurrenceId}-session-inventory-heading`} tabIndex={-1}>
            Session inventory
          </h2>
          <p className="session-inventory__header-copy">
            A navigable record of the context Station is authorized to show.
          </p>
        </div>
        <fieldset
          className="session-inventory__scope"
          aria-label="Inventory scope"
        >
          <legend>Scope</legend>
          {scopeOptions.map((scope) => {
            const label =
              scope.kind === 'current-answer'
                ? 'Current answer'
                : scope.kind === 'kept-in-task'
                  ? `Kept in Task “${scope.taskId}”`
                  : 'Whole Session';
            return (
              <button
                key={JSON.stringify(scope)}
                type="button"
                aria-label={
                  scope.kind === 'kept-in-task' ? 'Kept in Task' : undefined
                }
                aria-pressed={
                  JSON.stringify(scope) === JSON.stringify(model.scope)
                }
                onClick={() => onScopeChange?.(scope)}
              >
                {scope.kind === 'kept-in-task' ? (
                  <>
                    Kept in Task “
                    <bdi
                      className="session-inventory__scope-id"
                      aria-hidden="true"
                    >
                      {scope.taskId}
                    </bdi>
                    ”
                  </>
                ) : (
                  label
                )}
              </button>
            );
          })}
        </fieldset>
      </header>
      <SessionInventoryOverview
        groups={model.groups}
        scope={model.scope}
        onSelect={onSelect}
      />
      <div className="session-inventory__layout">
        <div className="session-inventory__navigation">
          <label className="session-inventory__compact-selector-label">
            Browse session context
            <select
              value={selected.id}
              onChange={(event) =>
                onSelect({
                  scope: model.scope,
                  groupId: event.currentTarget
                    .value as SessionInventorySelection['groupId'],
                })
              }
            >
              {inventorySections.map((section) => (
                <optgroup key={section.label} label={section.label}>
                  {section.groups.map((groupId) => {
                    const group = model.groups.find(
                      (candidate) => candidate.id === groupId,
                    );
                    return group ? (
                      <option key={group.key} value={group.id}>
                        {group.label} — {countAnnouncement(group)}
                      </option>
                    ) : null;
                  })}
                </optgroup>
              ))}
            </select>
          </label>
          <nav
            aria-label="Inventory groups"
            className="session-inventory__index"
          >
            {inventorySections.map((section) => {
              const groups = section.groups
                .map((groupId) =>
                  model.groups.find((group) => group.id === groupId),
                )
                .filter(
                  (
                    group,
                  ): group is SessionInventoryViewModel['groups'][number] =>
                    Boolean(group),
                );
              if (!groups.length) return null;
              return (
                <section
                  key={section.label}
                  className="session-inventory__index-section"
                  aria-label={section.label}
                >
                  <h3>{section.label}</h3>
                  {groups.map((group) => (
                    <button
                      key={group.key}
                      type="button"
                      aria-label={`${group.label}, ${countAnnouncement(group)}`}
                      aria-current={group.selected ? 'true' : undefined}
                      data-state={group.state}
                      data-attention={group.gaps.length > 0 || undefined}
                      onClick={() =>
                        onSelect({ scope: model.scope, groupId: group.id })
                      }
                    >
                      <span className="session-inventory__index-label">
                        {group.label}
                      </span>
                      <span className="session-inventory__index-count">
                        <span aria-hidden="true">
                          {group.count === null ? '—' : group.count}
                        </span>
                        <span className="session-inventory__visually-hidden">
                          {countAnnouncement(group)}
                        </span>
                      </span>
                    </button>
                  ))}
                </section>
              );
            })}
          </nav>
        </div>
        <section
          className="session-inventory__detail"
          aria-labelledby={headingId(selected.id)}
        >
          <header className="session-inventory__detail-header">
            <div>
              <p className="session-inventory__eyebrow">
                {selected.id.replace(/-/g, ' ')}
              </p>
              <h3
                ref={(node) => {
                  if (node) headingRefs.current.set(selected.id, node);
                  else headingRefs.current.delete(selected.id);
                }}
                id={headingId(selected.id)}
                tabIndex={-1}
              >
                {selected.label}
              </h3>
              <p>
                {selected.count === null
                  ? 'Count unavailable for this group.'
                  : `${countAnnouncement(selected)} reported for this scope.`}
              </p>
            </div>
            <span
              className="session-inventory__state"
              data-state={selected.state}
            >
              {stateLabel(selected)}
            </span>
          </header>
          {selected.stateCopy ? (
            <section
              className="session-inventory__empty-state"
              data-state={selected.state}
              aria-label={`${selected.label} state`}
            >
              <strong>
                {selected.state === 'empty'
                  ? 'Nothing was recorded here'
                  : stateLabel(selected)}
              </strong>
              <p>{selected.stateCopy}</p>
            </section>
          ) : null}
          {selected.gaps.length ? (
            <section
              className="session-inventory__gaps"
              aria-label="Owner gaps"
            >
              <h4>Needs review</h4>
              <ul>
                {selected.gaps.map((gap, index) => (
                  <li key={`${gap}:${index}`}>{gap}</li>
                ))}
              </ul>
            </section>
          ) : null}
          {selected.items.length ? (
            <ul className="session-inventory__items">
              {selected.items.map((item, index) => (
                <li
                  key={item.key}
                  className={
                    item.classification === 'kept'
                      ? 'session-inventory__item session-inventory__item--kept'
                      : 'session-inventory__item'
                  }
                  data-selected={
                    selected.selectedItemKey === item.key || undefined
                  }
                >
                  <div className="session-inventory__item-heading">
                    <span className="session-inventory__classification">
                      {item.classification === 'kept' ? 'Kept' : 'Current'}
                    </span>
                    <button
                      type="button"
                      aria-pressed={selected.selectedItemKey === item.key}
                      aria-label={`Select item ${index + 1} in ${selected.label}`}
                      onClick={() =>
                        onSelect({
                          scope: model.scope,
                          groupId: selected.id,
                          itemKey: item.key,
                        })
                      }
                    >
                      <bdi
                        className="session-inventory__label"
                        aria-hidden="true"
                      >
                        {item.label}
                      </bdi>
                    </button>
                  </div>
                  <p className="session-inventory__relation">
                    {item.classification === 'kept'
                      ? 'Kept in Task'
                      : 'Current Session'}{' '}
                    · {item.relation}
                  </p>
                  {item.actions.length ? (
                    <div className="session-inventory__item-actions">
                      {item.actions.map((action) => (
                        <span key={action}>
                          {renderAction?.({ action, item })}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
          {selected.continuation ? (
            <button
              type="button"
              onClick={() => onLoadMore?.(selected.id, selected.continuation!)}
            >
              Load more {selected.label}
            </button>
          ) : null}
        </section>
      </div>
    </section>
  );
}
