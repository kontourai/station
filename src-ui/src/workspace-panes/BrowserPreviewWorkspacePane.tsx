import {
  migrateWorkspaceBrowserPaneState,
  parseWorkspaceBrowserPaneState,
  WORKSPACE_BROWSER_PANE_STATE_VERSION,
} from '@kontourai/station-contracts/workspace-browser-pane';
import { useCallback, useState } from 'react';
import { LazyBoundary } from '../components/LazyBoundary';
import { SkeletonBlock } from '../components/state';
import type { BrowserPaneTarget } from './browser-pane/BrowserPane';
import { isCanonicalBrowserPreviewPaneInstance } from './browserPreviewPaneInstance';
import {
  readBrowserPreviewPaneState,
  storedBrowserPaneProjectId,
  writeBrowserPreviewPaneState,
} from './browserPreviewPaneStateStorage';
import type { BuiltinWorkspacePaneProps } from './builtinWorkspacePaneRegistry';
import { useWorkspacePaneBoundIdentity } from './useWorkspacePaneBoundIdentity';
import { WorkspacePaneBindingUnavailable } from './WorkspacePaneBindingUnavailable';

// The pane itself (address bar, live canvas, session list, acquisition) is a
// separate chunk: nothing of it reaches the entry bundle.
const loadBrowserPane = () => import('./browser-pane/BrowserPane');

/**
 * The Browser pane's registry slot (descriptor
 * `pane:builtin:workspace-preview:browser-preview`). Pane state is per
 * device and names only the server-owned session this pane shows (v2). A v1
 * Browser Preview record is migrated on first mount: the pane opens or
 * restores a session for its URL, then this writes v2 in its place.
 */
export function BrowserPreviewWorkspacePane({
  instance,
}: BuiltinWorkspacePaneProps) {
  const identity = useWorkspacePaneBoundIdentity(instance, false);
  const projectId = identity.state === 'resolved' ? identity.project.id : '';
  const [, setRevision] = useState(0);
  const stored = readBrowserPreviewPaneState(
    window.localStorage,
    instance.stateKey,
  );
  // The Add-pane grid opens the Project's occurrence with no state yet: it
  // then belongs to its bound Project and asks for a page.
  const storedProject = stored
    ? storedBrowserPaneProjectId(stored)
    : (instance.boundContext?.projectId ?? null);
  const canonical = Boolean(
    storedProject &&
      instance.boundContext?.projectId === projectId &&
      isCanonicalBrowserPreviewPaneInstance(instance, {
        projectId: storedProject,
      }),
  );
  const onAttach = useCallback(
    (browserSessionId: string) => {
      if (!storedProject) return;
      const updatedAt = new Date().toISOString();
      const next = !stored
        ? parseWorkspaceBrowserPaneState({
            version: WORKSPACE_BROWSER_PANE_STATE_VERSION,
            projectId: storedProject,
            browserSessionId,
            updatedAt,
          })
        : stored.version === '1.0'
          ? migrateWorkspaceBrowserPaneState(
              stored.migration,
              browserSessionId,
              updatedAt,
            )
          : parseWorkspaceBrowserPaneState({
              version: WORKSPACE_BROWSER_PANE_STATE_VERSION,
              projectId: stored.state.projectId,
              browserSessionId,
              updatedAt,
            });
      if (
        next &&
        writeBrowserPreviewPaneState(
          window.localStorage,
          instance.stateKey,
          next,
        )
      )
        setRevision((current) => current + 1);
    },
    [instance.stateKey, stored, storedProject],
  );
  if (identity.state !== 'resolved')
    return <WorkspacePaneBindingUnavailable identity={identity} />;
  if (!canonical)
    return (
      <WorkspacePaneBindingUnavailable
        identity={{ state: 'pane-state-mismatch' }}
      />
    );
  const target: BrowserPaneTarget = !stored
    ? { kind: 'new' }
    : stored.version === '2.0'
      ? { kind: 'session', browserSessionId: stored.state.browserSessionId }
      : { kind: 'migrate', migration: stored.migration };
  return (
    <LazyBoundary
      load={loadBrowserPane}
      componentProps={{
        projectSlug: identity.project.slug,
        target,
        onAttach,
      }}
      pending={<SkeletonBlock count={2} label="Loading the browser" />}
    />
  );
}
