import { useMemo, useSyncExternalStore } from 'react';
import {
  useDeviceSettings,
  useDeviceSettingsActions,
} from '../../contexts/DeviceSettingsContext';
import {
  readSnoozes,
  snoozesVersion,
  subscribeSnoozes,
} from '../../utils/activity-snooze-store';
import type { HomeWorkItem } from '../../views/home/home-view-model';
import type { WorkFactsById } from '../../views/home/work-facts';
import { workStatus } from '../../views/home/work-status';

export function useInboxScope(
  items: HomeWorkItem[],
  now: number,
  facts?: WorkFactsById,
) {
  const version = useSyncExternalStore(
    subscribeSnoozes,
    snoozesVersion,
    snoozesVersion,
  );
  const { inboxScope } = useDeviceSettings();
  const { setDeviceSetting } = useDeviceSettingsActions();
  // biome-ignore lint/correctness/useExhaustiveDependencies: snooze version invalidates the persisted map read
  return useMemo(() => {
    const options = new Map([
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
      item.projectSlug
        ? `project:${JSON.stringify([stationById.get(item.id), item.projectSlug])}`
        : null;
    for (const item of items) {
      const key = projectKey(item);
      if (key)
        options.set(
          key,
          `Project: ${item.projectLabel} · ${options.get(stationById.get(item.id)!)}`,
        );
    }
    // A saved scope absent from this snapshot stays selected: an outage must
    // not silently change the user's filter or pretend another Station is it.
    if (!options.has(inboxScope))
      options.set(inboxScope, 'Saved scope (unavailable)');
    const matches = (item: HomeWorkItem) =>
      inboxScope === 'all' ||
      (inboxScope.startsWith('project:')
        ? projectKey(item) === inboxScope
        : stationById.get(item.id) === inboxScope);
    const filtered = items.filter(matches);
    const snoozed = readSnoozes(now);
    const hiddenAttention = items.filter(
      (item) =>
        !matches(item) &&
        !(snoozed[item.id] > now) &&
        workStatus(item, now).lane === 'needsYou',
    ).length;
    return {
      items: filtered,
      options,
      value: inboxScope,
      hiddenAttention,
      onChange: (value: string) => setDeviceSetting('inboxScope', value),
    };
  }, [items, now, facts, inboxScope, setDeviceSetting, version]);
}

export function InboxScopeFilter({
  scope,
}: {
  scope: ReturnType<typeof useInboxScope>;
}) {
  return (
    <div className="chat-dock-inbox__scope">
      <label>
        Show work
        <select
          className="choice-trigger"
          aria-label="Inbox scope"
          value={scope.value}
          onChange={(event) => scope.onChange(event.target.value)}
        >
          {[...scope.options].map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      {scope.hiddenAttention > 0 && (
        <button type="button" onClick={() => scope.onChange('all')}>
          {scope.hiddenAttention} need you outside this filter · Show all
        </button>
      )}
    </div>
  );
}
