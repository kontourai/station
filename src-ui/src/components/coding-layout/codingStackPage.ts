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
 * another host's scope is the Chat page too, and so is any `?pane=` when the
 * layout has no pane host at all (`instances` empty) — the URL cannot strand
 * the reader on a page with nothing on it.
 *
 * A pane id the host's live set does not (yet) list is still a drill-in. The
 * host reports its set only after it commits, so a pane it has just opened —
 * a File Preview a click in Files opened — is named in the URL a render
 * before it is listed; treating that render as the Chat page flashed the
 * conversation and let the Chat page's deep-link consumer open the same file
 * a second time. A pane the host closed is renamed by the host itself (its
 * successor, `navigationSelection="explicit"`), and one it never held shows
 * the host's own selection under this drill-in.
 */
export function resolveCodingStackLocation(
  scope: WorkspacePaneHostScope,
  instances: readonly WorkspacePaneInstance[] | undefined,
  pane: string | null,
  paneScope: string | null,
  shownPaneId?: string | null,
): CodingStackLocation {
  if (!pane || paneScope !== workspacePaneHostScopeKey(scope))
    return { page: 'chat', paneId: null };
  if (instances && instances.length === 0)
    return { page: 'chat', paneId: null };
  // A pane the host does not hold (closed, or a stale link) while the host is
  // showing one of its own: the page is the pane actually on screen, so the
  // breadcrumb and the rail name what the reader sees.
  if (
    instances &&
    shownPaneId &&
    !instances.some((instance) => instance.instanceId === pane) &&
    instances.some((instance) => instance.instanceId === shownPaneId)
  )
    return { page: 'drill-in', paneId: shownPaneId };
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
