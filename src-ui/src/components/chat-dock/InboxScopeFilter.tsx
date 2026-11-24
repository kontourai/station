import { INBOX_SCOPE_CURRENT_PROJECT } from '@kontourai/station-contracts/device-settings';
import { useMemo, useSyncExternalStore } from 'react';
import { useAuthorityPersistence } from '../../contexts/AuthorityPersistenceContext';
import {
  useDeviceSettings,
  useDeviceSettingsActions,
} from '../../contexts/DeviceSettingsContext';
import { navigationStore } from '../../contexts/navigation-store';
import { useProjectNames } from '../../hooks/useProjectNames';
import {
  readSnoozes,
  snoozesVersion,
  subscribeSnoozes,
} from '../../utils/activity-snooze-store';
import type { HomeWorkItem } from '../../views/home/home-view-model';
import type { WorkFactsById } from '../../views/home/work-facts';
import { workStatus } from '../../views/home/work-status';
import { useInboxDismissals } from './inbox-dismissals';

export function useInboxScope(
  items: HomeWorkItem[],
  now: number,
  facts?: WorkFactsById,
) {
  const { namespace } = useAuthorityPersistence();
  const { visible } = useInboxDismissals(items, facts);
  const version = useSyncExternalStore(
    subscribeSnoozes,
    snoozesVersion,
    snoozesVersion,
  );
  const projectNames = useProjectNames();
  const { inboxScope } = useDeviceSettings();
  const { setDeviceSetting } = useDeviceSettingsActions();
  // #4405 (A36): the project page on screen, for the default scope.
  const routeProject = useSyncExternalStore(
    navigationStore.subscribe,
    () => navigationStore.getSnapshot().selectedProject,
    () => null,
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: snooze version invalidates the persisted map read
  return useMemo(() => {
    const options = new Map<string, string>([
      [
        INBOX_SCOPE_CURRENT_PROJECT,
        routeProject
          ? `This project: ${
              items.find(
                (item) =>
                  !item.environmentId &&
                  !facts?.get(item.id)?.station &&
                  item.projectSlug === routeProject,
              )?.projectLabel ??
              projectNames.get(routeProject) ??
              'Current project'
            }`
          : 'All work',
      ],
      ['all', 'All work'],
      ['station:local', 'This Station'],
    ]);
    const stationKey = (item: HomeWorkItem) => {
      const station = facts?.get(item.id)?.station;
      if (station) {
        const key = `station:peer:${station.id}`;
        options.set(key, station.label);
        return key;
      }
      if (item.environmentId) {
        const key = `station:remote:${item.environmentId}`;
        options.set(key, item.environmentLabel ?? item.environmentId);
        return key;
      }
      return 'station:local';
    };
    const stationById = new Map(
      items.map((item) => [item.id, stationKey(item)]),
    );
    const projectKey = (item: HomeWorkItem) =>
      item.projectSlug || item.projectLabel === 'No project'
        ? `project:${JSON.stringify([stationById.get(item.id), item.projectSlug ?? null])}`
        : null;
    const projectChoices = new Map<
      string,
      { key: string; station: string; label: string }
    >();
    for (const item of items) {
      const key = projectKey(item);
      if (!key) continue;
      const station = stationById.get(item.id)!;
      const label = item.projectSlug
        ? ((station === 'station:local'
            ? projectNames.get(item.projectSlug)
            : undefined) ??
          item.projectLabel ??
          item.projectSlug)
        : 'No project';
      projectChoices.set(key, { key, station, label });
      options.set(key, `Always ${label} · ${options.get(station)}`);
    }
    // A saved scope absent from this snapshot stays selected: an outage must
    // not silently change the user's filter or pretend another Station is it.
    if (!options.has(inboxScope) && inboxScope !== INBOX_SCOPE_CURRENT_PROJECT)
      options.set(inboxScope, 'Saved scope (unavailable)');
    // The default follows the project page on screen; anywhere else it is
    // all work. Only this Station's projects have pages here.
    const scope =
      inboxScope !== INBOX_SCOPE_CURRENT_PROJECT
        ? inboxScope
        : routeProject
          ? `project:${JSON.stringify(['station:local', routeProject])}`
          : 'all';
    const matches = (item: HomeWorkItem) =>
      scope === 'all' ||
      (scope.startsWith('project:')
        ? projectKey(item) === scope
        : stationById.get(item.id) === scope);
    const filtered = items.filter(matches);
    const snoozed = readSnoozes(now, namespace);
    const attention = visible.filter(
      (item) =>
        !(snoozed[item.id] > now) &&
        workStatus(item, now, facts?.get(item.id)).lane === 'needsYou',
    );
    const hiddenAttention = attention.filter((item) => !matches(item)).length;
    return {
      items: filtered,
      projectChoices,
      projectNames,
      stationCount: new Set(stationById.values()).size,
      options,
      value: inboxScope,
      // Keep the unchosen default as a display-only option on Home. The
      // selectable All work option must save an explicit scope across routes.
      followPageHidden: !routeProject,
      effectiveValue: scope,
      hiddenAttention,
      visibleAttention: attention.length - hiddenAttention,
      onChange: (value: string) => setDeviceSetting('inboxScope', value),
    };
  }, [
    items,
    projectNames,
    visible,
    now,
    facts,
    inboxScope,
    routeProject,
    setDeviceSetting,
    version,
    namespace,
  ]);
}

export function InboxScopeFilter({
  scope,
  inline = false,
}: {
  scope: ReturnType<typeof useInboxScope>;
  /**
   * A toolbar control beside search: its label is for assistive technology
   * only, and work the scope hides that needs the person is a count badge on
   * the picker (choosing it shows all work), so the toolbar keeps one line.
   */
  inline?: boolean;
}) {
  return (
    <div
      className={`chat-dock-inbox__scope${inline ? ' chat-dock-inbox__scope--inline' : ''}`}
    >
      <label>
        <span className={inline ? 'sr-only' : undefined}>Show work</span>
        <select
          className="choice-trigger"
          aria-label="Chat list scope"
          value={scope.value}
          onChange={(event) => scope.onChange(event.target.value)}
        >
          {[...scope.options].map(([value, label]) => (
            <option
              key={value}
              value={value}
              hidden={
                scope.followPageHidden && value === INBOX_SCOPE_CURRENT_PROJECT
              }
              disabled={
                scope.followPageHidden && value === INBOX_SCOPE_CURRENT_PROJECT
              }
            >
              {label}
            </option>
          ))}
        </select>
      </label>
      {inline ? (
        scope.hiddenAttention > 0 ? (
          <button
            type="button"
            className="chat-dock-inbox__scope-badge"
            aria-label={`${scope.hiddenAttention} need you outside this filter. Show all work`}
            title={`${scope.hiddenAttention} need you outside this filter. Show all work`}
            onClick={() => scope.onChange('all')}
          >
            {scope.hiddenAttention}
          </button>
        ) : null
      ) : (
        <InboxScopeHiddenAttention scope={scope} />
      )}
    </div>
  );
}

/** Work that needs the person but the chosen scope hides, with the way back. */
function InboxScopeHiddenAttention({
  scope,
}: {
  scope: ReturnType<typeof useInboxScope>;
}) {
  if (scope.hiddenAttention <= 0) return null;
  return (
    <button
      type="button"
      className="chat-dock-inbox__hidden-attention"
      onClick={() => scope.onChange('all')}
    >
      {scope.hiddenAttention} need you outside this filter · Show all
    </button>
  );
}
