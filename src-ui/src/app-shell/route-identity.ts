import type { NavigationView } from '../types';

/**
 * One normalized rule for "is this a different route?", used to key the route
 * entrance and the pending publisher.
 *
 * The rule is: **view type + the primary record it is about + the query-backed
 * tabs that are themselves navigations.** Nothing else. Concretely:
 *
 * - INCLUDED — the record: `agent-edit.slug`, `task.taskId`, `project.slug`,
 *   the three `connections-*-edit` ids, `connections-acp-new.providerId`,
 *   `layout`'s project+layout, `workspace-pane`'s full pane identity,
 *   `project-flow-console`'s run, `activity.sessionId`, `not-found.path`.
 *   Going from `/agents/a` to `/agents/b` is a navigation to a different
 *   thing and the entrance replays.
 *
 * - INCLUDED — tabs that ARE routes: `guidance.tab`, `registry.tab`,
 *   `developer.tab`. Each has its own path (`/registry/agents`,
 *   `/developer/telemetry`), its own palette entry, and swaps the whole
 *   surface. Reaching one is a navigation.
 *
 * - EXCLUDED — everything incidental: `agent-edit.initialTab` (the seed for a
 *   tab the editor owns from then on; re-keying on it would remount an editor
 *   mid-edit), `guidance.selectedId` (choosing a row in a split pane's list,
 *   not leaving the surface), `guidance.redirectFromAlias` (provenance of how
 *   the URL was reached). A same-route rerender must never replay the
 *   entrance, so anything that changes without the user having navigated
 *   stays out.
 *
 * Previously this was `currentView.type` with two hand-written exceptions, so
 * every record-scoped route above changed without the entrance replaying,
 * while `guidance`'s tab did replay — inconsistent in both directions.
 */
export function routeIdentity(view: NavigationView): string {
  switch (view.type) {
    case 'agent-edit':
      return `agent-edit:${view.slug}`;
    case 'guidance':
      return `guidance:${view.tab ?? 'remembered'}`;
    case 'registry':
      return `registry:${view.tab ?? 'default'}`;
    case 'developer':
      return `developer:${view.tab ?? 'default'}`;
    case 'activity':
      return `activity:${view.sessionId ?? 'all'}`;
    case 'task':
      return `task:${view.taskId}`;
    case 'board':
      return view.reference.kind === 'task'
        ? `board:task:${view.reference.projectId}:${view.reference.id}`
        : `board:session:${view.reference.id}`;
    case 'connections-provider-edit':
      return `connections-provider-edit:${view.id}`;
    case 'connections-runtime-edit':
      return `connections-runtime-edit:${view.id}`;
    case 'connections-tool-edit':
      return `connections-tool-edit:${view.id}`;
    case 'connections-acp-new':
      return `connections-acp-new:${view.providerId}`;
    case 'project':
      return `project:${view.slug}`;
    case 'project-edit':
      return `project-edit:${view.slug}`;
    case 'project-session-board':
      return `project-session-board:${view.slug}`;
    case 'project-flow-console':
      return `project-flow-console:${view.slug}:${view.runId ?? 'all'}`;
    case 'layout':
      return `layout:${view.projectSlug}:${view.layoutSlug}`;
    case 'workspace-pane':
      return `workspace-pane:${view.projectSlug}:${view.layoutSlug ?? 'none'}:${view.descriptorId}:${view.instanceId}`;
    case 'not-found':
      return `not-found:${view.path}`;
    default:
      return view.type;
  }
}

/**
 * The longer-lived visual surface identity. Route boundaries still need the
 * exact `routeIdentity` above for pending/error/entrance correctness; only a
 * Connections section's split pane can keep its frame and portal root across
 * its list/edit route pair.
 */
export function routeSurfaceIdentity(view: NavigationView): string {
  switch (view.type) {
    case 'connections-providers':
    case 'connections-provider-edit':
      return 'connections-models';
    case 'connections-engines':
    case 'connections-runtime-edit':
      return 'connections-engines';
    case 'connections-tools':
    case 'connections-tool-edit':
      return 'connections-tools';
    default:
      return routeIdentity(view);
  }
}
