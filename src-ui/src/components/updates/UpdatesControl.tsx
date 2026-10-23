import { type ReactNode, useEffect, useRef, useState } from 'react';
import { usePlatformProfile } from '../../platform/PlatformProfileContext';
import { Button } from '../Button';
import { Dialog } from '../Dialog';
import { desktopUpdateControlView } from '../desktop-update/desktopUpdatePresentation';
import { useDesktopUpdateState } from '../desktop-update/useDesktopUpdateState';
import { RefreshGlyph } from '../icons/Glyph';
import { LazyBoundary } from '../LazyBoundary';
import { SkeletonBlock } from '../state';
import {
  openUpdates,
  takeOpenUpdatesRequest,
  useOpenUpdatesRequest,
  useUpdateNotices,
} from './updatesEvents';
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
  const { state } = useDesktopUpdateState(profile.isDesktop);
  const desktop = desktopUpdateControlView(state);
  const notices = useUpdateNotices();
  const request = useOpenUpdatesRequest();
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
            : notices.length > 0
              ? 'Update details available'
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
        <RefreshGlyph />
        {!collapsed && <span>Updates{status && <small>{status}</small>}</span>}
        {collapsed && status && (
          <span className="updates-control__indicator" aria-hidden="true" />
        )}
      </button>
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
