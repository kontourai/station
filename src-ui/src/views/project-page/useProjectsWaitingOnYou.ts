import {
  useOrchestrationSessionsQuery,
  useTasksQuery,
} from '@kontourai/station-sdk';
import { useEffect, useMemo, useState } from 'react';
import { useProjectOverviewPreview } from './projectOverviewPreview';

type OverviewModel = typeof import('./project-overview-model');

/**
 * Tasks Waiting on you per Project slug (#5064): one Tasks read for every
 * Project and the shared session list, placed by the Overview's own rule
 * (`projectWaitingOnYouCounts`). A read that has not answered counts
 * nothing, so no dot appears from a guess. With the `project-overview`
 * Feature Preview off there is no Tasks read at all, and no dot.
 *
 * The sidebar mounts this on first paint, so the projection (the contract's
 * Task lane and Overview rules) is loaded on demand, and only once the
 * preview is on: it never weighs on the entry bundle. Until it has loaded,
 * nothing is counted.
 */
export function useProjectsWaitingOnYou(): ReadonlyMap<string, number> {
  const enabled = useProjectOverviewPreview();
  const [model, setModel] = useState<OverviewModel | null>(null);
  useEffect(() => {
    if (!enabled || model) return;
    let live = true;
    void import('./project-overview-model').then(
      (loaded) => {
        if (live) setModel(loaded);
      },
      // A chunk that fails to load counts nothing; the dot stays hidden.
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [enabled, model]);
  const { data: tasks } = useTasksQuery(undefined, { enabled });
  const sessionsQuery = useOrchestrationSessionsQuery();
  const sessions = sessionsQuery.data;
  const sessionsKnown = sessions !== undefined && !sessionsQuery.isError;
  return useMemo(
    () =>
      enabled && model && tasks
        ? model.projectWaitingOnYouCounts({
            tasks,
            sessions: sessions ?? [],
            sessionsKnown,
          })
        : new Map<string, number>(),
    [enabled, model, tasks, sessions, sessionsKnown],
  );
}
