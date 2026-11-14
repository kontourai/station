import { useEffect } from 'react';
import { Button } from '../Button';
import { Dialog } from '../Dialog';
import { LazyBoundary } from '../LazyBoundary';
import { SkeletonBlock } from '../state';

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
  onClose,
}: {
  version: string | null;
  nativeApp: boolean;
  serverKey?: string;
  updatesOpen: boolean;
  paused?: boolean;
  onClose: () => void;
}) {
  useEffect(() => {
    if (updatesOpen) onClose();
  }, [updatesOpen, onClose]);
  if (!version || updatesOpen || paused) return null;
  return (
    <LazyBoundary
      load={loadWhatsNew}
      pending={
        <Dialog
          title={`Updated ${serverKey ? 'server' : 'to Station'} ${version}`}
          closeLabel="Close what’s new"
          onClose={onClose}
        >
          <SkeletonBlock count={1} label="Loading what’s new" />
        </Dialog>
      }
      unavailable={(retry) => (
        <Dialog
          title="What’s new"
          closeLabel="Close what’s new"
          onClose={onClose}
        >
          <p>Could not load the changelog.</p>
          <Button onClick={retry}>Retry changelog</Button>
        </Dialog>
      )}
      componentProps={{
        version,
        nativeApp,
        serverKey,
        onClose,
      }}
    />
  );
}
