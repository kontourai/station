/**
 * The dock's project binding, read once and shared (#2155). It lived inside
 * `RegionPaneHost.tsx` while that host was its only caller; the toolbar's
 * chooser panel needs the SAME derivation — which project a dock region's
 * panes bind to decides which of the chooser's rows are enabled — and a
 * second copy of these four query reads is exactly the drift `#2047 D3/D5`
 * settled once.
 */
import { useMemo } from 'react';
import { useDeviceSettings } from '../contexts/DeviceSettingsContext';
import { useProject } from '../contexts/ProjectsContext';
import { useActiveProject } from '../hooks/useActiveProject';

/**
 * The project a dock region binds its panes to (#2047 D3/D5): the dock's own
 * remembered binding (`chatDockProjectSlug`, the setting `useDockShellChrome`
 * exposes as `activeProjectSlug` and Chat's project switcher writes), else
 * the route's active project, the same fallback `ChatDock` takes for a user
 * who has never bound one. Resolved through the project read to the record
 * itself — the coding instances bind its id, the catalog queries by its
 * slug — so an unknown or deleted slug is no project rather than a dangling
 * id. Both null when the dock has none.
 *
 * `pending` is the project read in flight, which is NOT "no project" (review
 * M3): the read is a per-slug fetch with nothing seeding it from the projects
 * list, so on a cold load with a bound project every docked coding pane would
 * otherwise render the "pick one from Chat's project switcher" instruction —
 * an instruction for a state the user is not in — and the mount-time
 * reconcile would write a document derived from it. While it is true the
 * region shows the pane's loading skeleton, the "+" stays hidden
 * (`chooserRegion` reads it) and the reconcile is deferred. Narrower than "nothing
 * is written": a region whose SELECTED pane the dock already supplies (Chat,
 * with a Terminal behind its tab) still mounts the host on the pending-time
 * document and the host persists that until the read settles, when the
 * deferred reconcile restores the full pane set — a transient the strip
 * never shows, since it reads the arrangement.
 *
 * `!boundProject` after settle conflates "no such project" with "the read
 * failed" (the SDK throws for both a 404 and a network failure), so a
 * transient failure on the bound read with a cached route project falls back
 * to the route's project until the bound read refetches and the fingerprint
 * re-binds. Disclosed rather than gated: the SDK does not yet distinguish a
 * not-found error.
 *
 * The stale-binding fallback (review L1): `useDockShellChrome` clears a
 * `chatDockProjectSlug` naming a deleted project only while the shell holds
 * Chat, so with Chat in no region a deleted binding would otherwise leave
 * every docked coding pane on the placeholder forever while the route has a
 * project. Once the bound read has SETTLED with no record, the route's
 * active project is read instead. Only then: while the bound read is in
 * flight there is no evidence the binding is stale. The second
 * `useProject` is the same query key `useActiveProject` already reads (and
 * is disabled on the empty slug), so the fallback costs no extra fetch.
 */
export function useDockProject(): {
  projectId: string | null;
  projectSlug: string | null;
  pending: boolean;
} {
  const { chatDockProjectSlug } = useDeviceSettings();
  const { projectSlug: activeProjectSlug } = useActiveProject();
  const boundSlug = chatDockProjectSlug ?? activeProjectSlug ?? '';
  const { project: boundProject, isLoading: boundPending } =
    useProject(boundSlug);
  const staleBinding =
    !boundPending &&
    !boundProject &&
    activeProjectSlug !== null &&
    activeProjectSlug !== boundSlug;
  const { project: fallbackProject, isLoading: fallbackPending } = useProject(
    staleBinding ? activeProjectSlug : '',
  );
  const project = boundProject ?? (staleBinding ? fallbackProject : undefined);
  const pending = boundPending || (staleBinding && fallbackPending);
  const id = project?.id ?? null;
  const resolvedSlug = project?.slug ?? null;
  return useMemo(
    () => ({ projectId: id, projectSlug: resolvedSlug, pending }),
    [id, pending, resolvedSlug],
  );
}
