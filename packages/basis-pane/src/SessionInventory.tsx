import { type ReactNode, useEffect, useId, useRef } from 'react';
import type {
  SessionInventoryAction,
  SessionInventorySelection,
  SessionInventoryViewItem,
  SessionInventoryViewModel,
} from './session-inventory-view';

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
        <h2 id={`${occurrenceId}-session-inventory-heading`} tabIndex={-1}>
          Session inventory
        </h2>
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
      <div className="session-inventory__layout">
        <nav aria-label="Inventory groups" className="session-inventory__index">
          {model.groups.map((group) => (
            <button
              key={group.key}
              type="button"
              aria-current={group.selected ? 'true' : undefined}
              onClick={() =>
                onSelect({ scope: model.scope, groupId: group.id })
              }
            >
              <span>{group.label}</span>
              {group.count !== null ? <span>{group.count}</span> : null}
            </button>
          ))}
        </nav>
        <section
          className="session-inventory__detail"
          aria-labelledby={headingId(selected.id)}
        >
          <h3
            ref={(node) => {
              if (node) headingRefs.current.set(selected.id, node);
              else headingRefs.current.delete(selected.id);
            }}
            id={headingId(selected.id)}
            tabIndex={-1}
          >
            {selected.label}
            {selected.count !== null ? ` (${selected.count})` : ''}
          </h3>
          {selected.stateCopy ? (
            <p role={selected.state === 'empty' ? undefined : 'status'}>
              {selected.stateCopy}
            </p>
          ) : null}
          {selected.gaps.map((gap, index) => (
            <p key={`${gap}:${index}`} role="status">
              {gap}
            </p>
          ))}
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
                >
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
                  <p>
                    {item.classification === 'kept'
                      ? 'Kept in Task'
                      : 'Current Session'}{' '}
                    · {item.relation}
                  </p>
                  {item.actions.map((action) => (
                    <span key={action}>{renderAction?.({ action, item })}</span>
                  ))}
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
