import { useCoreUpdateStatusQuery } from '@kontourai/station-sdk';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { readClientReleaseVersion } from '../../build-info';
import {
  coreUpdateScopeFromContext,
  useConnectedServerUpdateContext,
} from '../../hooks/useConnectedServerUpdateContext';
import { usePlatformProfile } from '../../platform/PlatformProfileContext';
import { serverIdentityMatchesView } from '../../views/settings/coreUpdatePresentation';
import { Button } from '../Button';
import { Dialog } from '../Dialog';
import { desktopUpdateControlView } from '../desktop-update/desktopUpdatePresentation';
import { useDesktopUpdateState } from '../desktop-update/useDesktopUpdateState';
import { LazyBoundary } from '../LazyBoundary';
import { SkeletonBlock } from '../state';
import { PostUpdateChangelog } from './PostUpdateChangelog';
import { UpdateDownloadIcon } from './UpdateDownloadIcon';
import {
  openUpdates,
  takeOpenUpdatesRequest,
  useOpenUpdatesRequest,
  useUpdateNotices,
} from './updatesEvents';
import { usePostUpdateChangelog } from './usePostUpdateChangelog';
import './Updates.css';

const loadUpdatesPanel = () =>
  import('./UpdatesPanel').then((module) => ({ default: module.UpdatesPanel }));

export function UpdatesControl({
  collapsed = false,
  onNavigate,
}: {
  collapsed?: boolean;
  onNavigate: (path: string) => void;
}) {
  const profile = usePlatformProfile();
  const server = useConnectedServerUpdateContext();
  const serverReady =
    server.identityReady &&
    server.isCurrent() &&
    server.reachability === 'connected' &&
    !server.nativeObservationPending &&
    !server.claimedOwnerUnresolved &&
    server.kind !== 'embedded-sidecar';
  const { data: installedServer } = useCoreUpdateStatusQuery(
    server.apiBase,
    { enabled: serverReady, staleTime: 60_000 },
    {
      scopeKey: coreUpdateScopeFromContext(server),
      assertCurrent: () => {
        if (!server.isCurrent()) throw new Error('Connected server changed');
      },
    },
  );
  const { state } = useDesktopUpdateState(profile.isDesktop);
  const desktop = desktopUpdateControlView(state);
  const notices = useUpdateNotices();
  const progress =
    desktop.kind === 'downloading'
      ? {
          percent: desktop.percent,
          text: desktop.progressText,
          label: 'Downloading app update',
        }
      : notices.find((notice) => notice.progress)?.progress;
  const request = useOpenUpdatesRequest();
  const serverKey = `${server.apiBase}:${server.identity?.instanceId ?? ''}`;
  // Resolve both pending versions before mounting either dialog: child effects
  // cannot arbitrate focus/history when app and server upgrades arrive together.
  const appChangelog = usePostUpdateChangelog(
    profile.isDevBuild
      ? null
      : profile.isDesktop
        ? (state?.currentVersion ?? null)
        : readClientReleaseVersion(),
  );
  const bundleVersion = profile.isDesktop
    ? state?.currentVersion
    : readClientReleaseVersion();
  const duplicateServerNotes =
    !profile.isTauri &&
    (installedServer?.currentVersion === bundleVersion ||
      new URL(server.apiBase, window.location.origin).origin ===
        window.location.origin);
  const serverChangelog = usePostUpdateChangelog(
    !duplicateServerNotes &&
      serverReady &&
      installedServer &&
      serverIdentityMatchesView(installedServer, server.identity)
      ? (installedServer.currentVersion ?? null)
      : null,
    serverKey,
  );
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (takeOpenUpdatesRequest(request.sequence)) {
      setLoaded(true);
      setOpen(true);
    }
  }, [request.sequence]);
  const status =
    desktop.kind === 'downloading'
      ? `App downloading ${desktop.progressText}`
      : desktop.kind === 'restart'
        ? 'App ready to restart'
        : desktop.kind === 'installing'
          ? 'Installing app update…'
          : desktop.kind === 'download'
            ? desktop.failed
              ? 'App download failed'
              : 'App update available'
            : progress
              ? `Server downloading ${progress.text}`
              : notices.some((notice) => notice.updateAvailable)
                ? 'Update available'
                : null;
  const close = () => setOpen(false);
  const loadingDialog = (children: ReactNode) => (
    <Dialog
      title="Updates"
      closeLabel="Close Updates"
      onClose={close}
      returnFocusTarget={triggerRef.current}
    >
      {children}
    </Dialog>
  );
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`updates-control${collapsed ? ' updates-control--collapsed' : ''}`}
        aria-label={status ? `Updates: ${status}` : 'Updates'}
        title={status ? `Updates: ${status}` : 'Updates'}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => openUpdates()}
      >
        <UpdateDownloadIcon progress={progress} />
        {!collapsed && <span>Updates{status && <small>{status}</small>}</span>}
        {collapsed && status && !progress && (
          <span className="updates-control__indicator" aria-hidden="true" />
        )}
      </button>
      <PostUpdateChangelog
        version={appChangelog.pendingVersion}
        nativeApp={profile.isDesktop || profile.isMobile}
        onClose={appChangelog.dismiss}
        updatesOpen={open}
      />
      <PostUpdateChangelog
        key={serverKey}
        version={serverChangelog.pendingVersion}
        serverKey={serverKey}
        nativeApp={false}
        paused={!!appChangelog.pendingVersion}
        onClose={serverChangelog.dismiss}
        updatesOpen={open}
      />
      {loaded && (
        <LazyBoundary
          load={loadUpdatesPanel}
          pending={
            open
              ? loadingDialog(
                  <SkeletonBlock count={1} label="Loading updates" />,
                )
              : null
          }
          unavailable={(retry) =>
            open
              ? loadingDialog(
                  <>
                    <p role="alert">Could not load Updates.</p>
                    <Button onClick={retry}>Retry</Button>
                  </>,
                )
              : null
          }
          componentProps={{
            open,
            onClose: close,
            onNavigate: (path: string) => {
              close();
              onNavigate(path);
            },
            returnFocusTarget: triggerRef.current,
            target: request.target,
            requestSequence: request.sequence,
          }}
        />
      )}
    </>
  );
}
