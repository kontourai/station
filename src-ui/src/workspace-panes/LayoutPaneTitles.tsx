import type { LayoutMetadata } from '@kontourai/station-contracts/layout';
import type { ProjectMetadata } from '@kontourai/station-contracts/project';
import { parseWorkspaceLayoutPaneId } from '@kontourai/station-contracts/workspace-layout-pane';
import {
  usePersonalLayoutsQuery,
  useProjectLayoutsQuery,
} from '@kontourai/station-sdk';
import { useEffect, useMemo, useRef } from 'react';
import { useScopedProjectsQuery } from '../contexts/ProjectsContext';

/**
 * One reporter's batch: the surface ids it answers for and the titles it
 * resolved among them. Both are carried so the host can MERGE — a Board
 * reporter and a per-project reporter each own a disjoint set of ids, and
 * an id a reporter owns but did not resolve (dropped from the list) is
 * cleared rather than left at a stale name.
 */
export type LayoutPaneTitleReport = (
  surfaceIds: readonly string[],
  titles: ReadonlyMap<string, string>,
) => void;

/**
 * The tab titles of a region's Board and Layout panes (#2157), resolved from
 * the SDK's metadata LISTS — the Layout's `name`, the same word the
 * sidebar's pill shows — and reported to `RegionPaneHost` through
 * `onResolved`. Nothing here renders; it is a component rather than a hook
 * so the host mounts it ONLY when a region holds such a pane: every other
 * region host (and the fourteen tests that mount one without a query
 * client) keeps calling no SDK query, and a host holding two projects'
 * Layouts gets one `ProjectLayoutTitles` per project without the host
 * calling a hook in a loop.
 *
 * Only the lists are read, never the records, so the host chunk gains no
 * layout renderer: the renderer (`LayoutWorkspacePane`) is lazy and reads
 * the record itself. An id the list does not carry gets no title and the
 * host keeps the prefix's fallback ("Board" / "Layout") — the tab is still
 * the user's to close, and the pane body says "not found".
 */
export function LayoutPaneTitles({
  surfaceIds,
  onResolved,
}: {
  surfaceIds: readonly string[];
  onResolved: LayoutPaneTitleReport;
}) {
  const families = useMemo(() => {
    const boards: string[] = [];
    const projects = new Map<string, string[]>();
    for (const id of surfaceIds) {
      const key = parseWorkspaceLayoutPaneId(id);
      if (!key) continue;
      if (key.kind === 'board') boards.push(id);
      else {
        const list = projects.get(key.projectId) ?? [];
        list.push(id);
        projects.set(key.projectId, list);
      }
    }
    return { boards, projects: [...projects.entries()] };
  }, [surfaceIds]);
  return (
    <>
      {families.boards.length > 0 ? (
        <BoardTitles surfaceIds={families.boards} onResolved={onResolved} />
      ) : null}
      {families.projects.map(([projectId, ids]) => (
        <ProjectLayoutTitles
          key={projectId}
          projectId={projectId}
          surfaceIds={ids}
          onResolved={onResolved}
        />
      ))}
    </>
  );
}

function BoardTitles({
  surfaceIds,
  onResolved,
}: {
  surfaceIds: readonly string[];
  onResolved: LayoutPaneTitleReport;
}) {
  const { data } = usePersonalLayoutsQuery();
  useReportTitles(surfaceIds, data, onResolved);
  return null;
}

function ProjectLayoutTitles({
  projectId,
  surfaceIds,
  onResolved,
}: {
  projectId: string;
  surfaceIds: readonly string[];
  onResolved: LayoutPaneTitleReport;
}) {
  const projects = useScopedProjectsQuery();
  const slug = useMemo(() => {
    const matches = (
      (projects.data ?? []) as readonly ProjectMetadata[]
    ).filter((project) => project.id === projectId);
    return matches.length === 1 ? (matches[0] as ProjectMetadata).slug : '';
  }, [projects.data, projectId]);
  const { data } = useProjectLayoutsQuery(slug, { enabled: slug !== '' });
  useReportTitles(
    surfaceIds,
    data as readonly LayoutMetadata[] | undefined,
    onResolved,
  );
  return null;
}

/**
 * Report `name` per surface id whose Layout the list carries exactly once.
 * Reported only when the CONTENT changes: the host stores the map in state,
 * so a report per render (or per same-content refetch) would re-render it
 * forever. React Query keeps `data`'s identity across a refetch that changed
 * nothing, and the fingerprint guard covers a list that re-ordered around
 * the same names.
 */
function useReportTitles(
  surfaceIds: readonly string[],
  layouts: readonly LayoutMetadata[] | undefined,
  onResolved: LayoutPaneTitleReport,
) {
  const entries = useMemo(() => {
    const resolved: [string, string][] = [];
    for (const id of surfaceIds) {
      const key = parseWorkspaceLayoutPaneId(id);
      if (!key) continue;
      const matches = (layouts ?? []).filter(
        (layout) => layout.id === key.layoutId,
      );
      if (matches.length === 1)
        resolved.push([id, (matches[0] as LayoutMetadata).name]);
    }
    return resolved;
  }, [surfaceIds, layouts]);
  const reported = useRef<string | null>(null);
  useEffect(() => {
    const fingerprint = JSON.stringify(entries);
    if (reported.current === fingerprint) return;
    reported.current = fingerprint;
    onResolved(surfaceIds, new Map(entries));
  }, [entries, onResolved, surfaceIds]);
}
