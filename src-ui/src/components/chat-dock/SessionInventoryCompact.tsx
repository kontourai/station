import { buildSessionInventoryViewModel } from '@kontourai/station-basis-pane/session-inventory-view';
import type {
  SessionInventoryGroupId,
  SessionInventoryScope,
} from '@kontourai/station-contracts/session-inventory';
import { useSessionInventoryQuery } from '@kontourai/station-sdk/session-inventory';
import { useEffect, useMemo } from 'react';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import type { SessionInventorySelection } from '../../workspace-panes/sessionInventorySelection';
import {
  commitSessionInventorySelection,
  readSessionInventorySelection,
  useSessionInventorySelection,
} from '../../workspace-panes/sessionInventorySelection';
import { SkeletonBlock } from '../state';
import {
  sessionInventoryLiveItems,
  useSessionInventoryLive,
} from './useSessionInventoryLive';

const PREVIEW_GROUPS = new Set<SessionInventoryGroupId>([
  'inputs',
  'execution',
  'outputs',
  'live-now',
  'attention',
]);

/**
 * Lazy compact density.  It consumes the same authorized projection and
 * occurrence-local selection store as the full Basis pane; it only limits
 * presentation.  No item action, detail page, image, or external navigation
 * is mounted from this surface.
 */
export function SessionInventoryCompact({
  scope,
  density,
  chatStoreId,
  onClose,
  onOpenFull,
}: {
  scope: SessionInventoryScope;
  density: 'aside' | 'card';
  chatStoreId: string;
  onClose(): void;
  onOpenFull(trigger: HTMLElement, selection: SessionInventorySelection): void;
}) {
  const requestScope = useHostRequestAuthorityScope();
  const liveNow = useSessionInventoryLive(
    requestScope,
    scope.sessionId,
    chatStoreId,
  );
  const key = useMemo(
    () =>
      requestScope ? { ...requestScope, sessionId: scope.sessionId } : null,
    [requestScope, scope.sessionId],
  );
  const initial = useMemo(
    () => ({ scope, groupId: 'inputs' as const }),
    [scope],
  );
  const selection = useSessionInventorySelection(key, initial);
  // Activation is the boundary: this component itself is dynamically imported
  // only after the trigger.  Capture/commit never consults current chat state.
  useEffect(() => {
    if (
      key &&
      (!readSessionInventorySelection(key) ||
        JSON.stringify(readSessionInventorySelection(key)?.scope) !==
          JSON.stringify(scope))
    )
      commitSessionInventorySelection(key, initial);
    // The prepared selection belongs to this captured occurrence, not a later
    // active chat.  Only mount/authority/session changes may prepare it.
  }, [initial, key, scope]);
  const inventory = useSessionInventoryQuery(selection.scope, {
    enabled: Boolean(requestScope),
    requestScope: requestScope ?? undefined,
  });
  const model = inventory.data
    ? buildSessionInventoryViewModel(
        inventory.data,
        selection,
        'compact',
        sessionInventoryLiveItems(liveNow),
      )
    : null;
  useEffect(() => {
    if (key && model?.repairedSelection)
      commitSessionInventorySelection(key, model.selection);
  }, [key, model]);
  if (!requestScope || !key)
    return (
      <aside aria-label="Session inventory">
        Session inventory is unavailable.
      </aside>
    );
  if (inventory.isLoading)
    return (
      <aside aria-label="Session inventory">
        <SkeletonBlock count={2} label="Loading Session inventory" />
      </aside>
    );
  if (inventory.error || !inventory.data)
    return (
      <aside aria-label="Session inventory">
        Session inventory is unavailable.
      </aside>
    );
  if (!model) return null;
  const previews = model.groups
    .filter((group) => PREVIEW_GROUPS.has(group.id))
    .flatMap((group) =>
      group.items.slice(0, 2).map((item) => ({ group, item })),
    )
    .slice(0, 2);
  const firstGap = model.groups.flatMap((group) => group.gaps)[0];
  return (
    <aside
      className={`session-inventory-compact session-inventory-compact--${density}`}
      aria-label="Session inventory"
    >
      <div className="session-inventory-compact__heading">
        <h2>Session inventory</h2>
        <bdi>{model.scopeLabel}</bdi>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close Session inventory"
        >
          ×
        </button>
      </div>
      <fieldset className="session-inventory-compact__groups">
        <legend>Inventory groups</legend>
        {model.groups.map((group) => (
          <button
            key={group.key}
            type="button"
            aria-pressed={group.selected}
            onClick={() =>
              commitSessionInventorySelection(key, {
                scope: model.scope,
                groupId: group.id,
              })
            }
          >
            <span>{group.label}</span>
            <span>{group.count ?? '—'}</span>
          </button>
        ))}
      </fieldset>
      {liveNow.running.length || liveNow.pendingApprovalIds.length ? (
        <p className="session-inventory-compact__live" role="status">
          Live now: {liveNow.running.length} running
          {liveNow.pendingApprovalIds.length
            ? ` · ${liveNow.pendingApprovalIds.length} pending request${liveNow.pendingApprovalIds.length === 1 ? '' : 's'}`
            : ''}
        </p>
      ) : null}
      {firstGap ? <p role="status">Attention: {firstGap}</p> : null}
      {previews.length ? (
        <ul className="session-inventory-compact__previews">
          {previews.map(({ group, item }) => (
            <li key={item.key}>
              <button
                type="button"
                onClick={() =>
                  commitSessionInventorySelection(key, {
                    scope: model.scope,
                    groupId: group.id,
                    itemKey: item.key,
                  })
                }
              >
                <bdi>{item.label}</bdi>
                <span>
                  {item.classification === 'kept' ? 'Kept' : 'Current'}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <button
        type="button"
        onClick={(event) => onOpenFull(event.currentTarget, selection)}
      >
        Open full Basis
      </button>
    </aside>
  );
}
