import { useEffect } from 'react';
import { Button } from '../Button';
import { Dialog } from '../Dialog';
import { LazyBoundary } from '../LazyBoundary';
import { SkeletonBlock } from '../state';
import { usePostUpdateChangelog } from './usePostUpdateChangelog';

const loadWhatsNew = () =>
  import('./WhatsNewDialog').then((module) => ({
    default: module.WhatsNewDialog,
  }));

export function PostUpdateChangelog({
  version,
  nativeApp,
  serverKey,
  updatesOpen,
  paused = false,
  onPendingChange,
}: {
  version: string | null;
  nativeApp: boolean;
  serverKey?: string;
  updatesOpen: boolean;
  paused?: boolean;
  onPendingChange?: (pending: boolean) => void;
}) {
  const { pendingVersion, dismiss } = usePostUpdateChangelog(
    version,
    serverKey,
  );
  useEffect(() => {
    onPendingChange?.(!!pendingVersion);
  }, [pendingVersion, onPendingChange]);
  useEffect(() => {
    if (updatesOpen) dismiss();
  }, [updatesOpen, dismiss]);
  if (!pendingVersion || updatesOpen || paused) return null;
  return (
    <LazyBoundary
      load={loadWhatsNew}
      pending={
        <Dialog
          title={`Updated ${serverKey ? 'server' : 'to Station'} ${pendingVersion}`}
          closeLabel="Close what’s new"
          onClose={dismiss}
        >
          <SkeletonBlock count={1} label="Loading what’s new" />
        </Dialog>
      }
      unavailable={(retry) => (
        <Dialog
          title="What’s new"
          closeLabel="Close what’s new"
          onClose={dismiss}
        >
          <p>Could not load the changelog.</p>
          <Button onClick={retry}>Retry changelog</Button>
        </Dialog>
      )}
      componentProps={{
        version: pendingVersion,
        nativeApp,
        serverKey,
        onClose: dismiss,
      }}
    />
  );
}
