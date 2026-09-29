import type { WorkspacePaneInstance } from '@kontourai/station-contracts/workspace-pane';
import type { WorkspacePaneHostScope } from '@kontourai/station-contracts/workspace-pane-host';
import { useSyncExternalStore } from 'react';
import { navigationStore } from '../../contexts/navigation-store';
import { workspacePaneHostScopeKey } from '../../workspace-panes/workspacePaneHostNavigation';

/**
 * The two pages of the Coding layout's navigation stack (#928 coding stack):
 * the conversation, and a pane drilled into from it.
 */
export type CodingStackPage = 'chat' | 'drill-in';

export interface CodingStackLocation {
  page: CodingStackPage;
  /** The drilled-in pane's instance id; null on the Chat page. */
  paneId: string | null;
}

/**
 * Which page the URL names. There is no page parameter of its own: a drill-in
 * IS the pane host's selection (`?pane=` + `?paneScope=`, a history entry the
 * host already writes), and the Chat page is its absence. A `?pane=` for
 * another host's scope, or for a pane this host no longer holds, is the Chat
 * page too — the URL cannot strand the reader on a page with nothing on it.
 *
 * `instances` is the host's live pane set when known. Before the host has
 * reported one (it reports only once it holds its persistence lease), the URL
 * is trusted, so a reload on a pane the host is still restoring (a File
 * Preview) lands on that pane instead of flashing the Chat page.
 */
export function resolveCodingStackLocation(
  scope: WorkspacePaneHostScope,
  instances: readonly WorkspacePaneInstance[] | undefined,
  pane: string | null,
  paneScope: string | null,
): CodingStackLocation {
  if (!pane || paneScope !== workspacePaneHostScopeKey(scope))
    return { page: 'chat', paneId: null };
  if (instances && !instances.some((instance) => instance.instanceId === pane))
    return { page: 'chat', paneId: null };
  return { page: 'drill-in', paneId: pane };
}

const selectPane = () => navigationStore.getSnapshot().activeWorkspacePane;
const selectPaneScope = () =>
  navigationStore.getSnapshot().activeWorkspacePaneScope;

/**
 * The URL's pane selection, subscribed. A hook of its own so a host can call
 * it before the early returns that precede knowing its scope, and resolve the
 * page with `resolveCodingStackLocation` once it does.
 */
export function useCodingStackSelection(): {
  pane: string | null;
  paneScope: string | null;
} {
  const pane = useSyncExternalStore(
    navigationStore.subscribe,
    selectPane,
    selectPane,
  );
  const paneScope = useSyncExternalStore(
    navigationStore.subscribe,
    selectPaneScope,
    selectPaneScope,
  );
  return { pane, paneScope };
}
