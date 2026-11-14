import { INBOX_SCOPE_CURRENT_PROJECT } from '@kontourai/station-contracts/device-settings';
import { useMemo, useSyncExternalStore } from 'react';
import { useAuthorityPersistence } from '../../contexts/AuthorityPersistenceContext';
import {
  useDeviceSettings,
  useDeviceSettingsActions,
} from '../../contexts/DeviceSettingsContext';
import { navigationStore } from '../../contexts/navigation-store';
import { useProjects } from '../../contexts/ProjectsContext';
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
  const { projects } = useProjects();
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
              projects.find((project) => project.slug === routeProject)?.name ??
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
      item.projectSlug
        ? `project:${JSON.stringify([stationById.get(item.id), item.projectSlug])}`
        : null;
    for (const item of items) {
      const key = projectKey(item);
      if (key)
        options.set(
          key,
          `Always ${item.projectLabel ?? projects.find((project) => project.slug === item.projectSlug)?.name ?? item.projectSlug} · ${options.get(stationById.get(item.id)!)}`,
        );
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
    // Following the page follows the project on every Station, so opening a
    // row (which lands on its project page) never hides that row's own work.
    const followedProject =
      inboxScope === INBOX_SCOPE_CURRENT_PROJECT ? routeProject : undefined;
    const matches = (item: HomeWorkItem) =>
      scope === 'all' ||
      (followedProject
        ? item.projectSlug === followedProject
        : scope.startsWith('project:')
          ? projectKey(item) === scope
          : stationById.get(item.id) === scope);
    const filtered = items.filter(matches);
    const snoozed = readSnoozes(now, namespace);
    const hiddenAttention = visible.filter(
      (item) =>
        !matches(item) &&
        !(snoozed[item.id] > now) &&
        workStatus(item, now).lane === 'needsYou',
    ).length;
    return {
      items: filtered,
      options,
      value: inboxScope,
      // Keep the unchosen default as a display-only option on Home. The
      // selectable All work option must save an explicit scope across routes.
      followPageHidden: !routeProject,
      effectiveValue: scope,
      hiddenAttention,
      onChange: (value: string) => setDeviceSetting('inboxScope', value),
    };
  }, [
    items,
    projects,
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
      {scope.hiddenAttention > 0 && (
        <button type="button" onClick={() => scope.onChange('all')}>
          {scope.hiddenAttention} need you outside this filter · Show all
        </button>
      )}
    </div>
  );
}
