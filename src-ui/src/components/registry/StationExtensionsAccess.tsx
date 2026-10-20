import { useConnections } from '@kontourai/station-connect';
import { useState, useSyncExternalStore } from 'react';
import { useApiBase } from '../../contexts/ApiBaseContext';
import { pluginRegistry } from '../../core/PluginRegistry';
import {
  reloadAfterRemotePluginBundleRevoke,
  remotePluginBundlesAllowed,
  setRemotePluginBundlesAllowed,
  subscribeRemotePluginBundleConsent,
} from '../../core/remotePluginBundleConsent';
import { usePlatformProfile } from '../../platform/PlatformProfileContext';
import { Button } from '../Button';
import { ConfirmModal } from '../modals/ConfirmModal';
import './StationExtensionsAccess.css';

export function useStationExtensionsAccess() {
  const { activeConnection, captureSelectionIntent } = useConnections();
  const { apiBase } = useApiBase();
  const { isTauri } = usePlatformProfile();
  const connectionId = activeConnection?.id ?? 'default';
  const name =
    activeConnection?.name ||
    activeConnection?.url ||
    apiBase ||
    'this Station';
  const origin = (() => {
    try {
      return new URL(apiBase).origin;
    } catch {
      return apiBase;
    }
  })();
  const allowed = useSyncExternalStore(subscribeRemotePluginBundleConsent, () =>
    remotePluginBundlesAllowed(connectionId, apiBase),
  );
  const status = useSyncExternalStore(
    pluginRegistry.subscribe,
    pluginRegistry.getLoadStatus,
  );
  const blocked = status.failure === 'remote-isolation' && !allowed;
  const remote = Boolean(
    activeConnection && !activeConnection.injected && !activeConnection.ownerId,
  );
  const [review, setReview] = useState<{
    connectionId: string;
    apiBase: string;
    name: string;
    origin: string;
    enable: boolean;
    selection: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const openReview = (enable: boolean) => {
    setError(null);
    setReview({
      connectionId,
      apiBase,
      name,
      origin,
      enable,
      selection: captureSelectionIntent(),
    });
  };
  const dialog = review ? (
    <ConfirmModal
      isOpen
      title={`${review.enable ? 'Allow' : 'Turn off'} extensions from ${review.name}?`}
      message={
        review.enable
          ? `Extensions add custom views and controls. This choice is saved for ${review.origin}, but enabled code has access across this app: other Stations' data, credentials available in this window, and these permission settings.${isTauri ? ' This includes the native bridge and your paired Station credentials.' : ''} Only allow a Station you control or trust.`
          : `This stops loading extensions from ${review.name} on this device. Station will reload to stop code that is already running. Installed plugins stay on the Station.`
      }
      confirmLabel={review.enable ? 'Allow extensions' : 'Turn off and reload'}
      cancelLabel="Not now"
      variant="warning"
      error={error}
      onCancel={() => setReview(null)}
      onConfirm={() => {
        if (
          captureSelectionIntent() !== review.selection ||
          connectionId !== review.connectionId ||
          apiBase !== review.apiBase
        ) {
          setError(
            'The selected Station changed. Close this review and try again.',
          );
          return;
        }
        if (
          !setRemotePluginBundlesAllowed(
            review.connectionId,
            review.apiBase,
            review.enable,
          )
        ) {
          setError(
            review.enable
              ? "Couldn't save this permission. Extensions are still off."
              : "Couldn't turn extensions off. They are still allowed.",
          );
          return;
        }
        setReview(null);
        if (!review.enable) reloadAfterRemotePluginBundleRevoke();
      }}
    />
  ) : null;
  return {
    allowed,
    blocked,
    manageable: blocked || (isTauri && (allowed || remote)),
    name,
    review: () => openReview(true),
    disable: () => openReview(false),
    dialog,
  };
}

export function StationExtensionsAccess({
  onlyWhenOff = false,
  installation = false,
}: {
  onlyWhenOff?: boolean;
  installation?: boolean;
}) {
  const access = useStationExtensionsAccess();
  if (!access.manageable || (onlyWhenOff && access.allowed)) return null;
  return (
    <section
      className="station-extensions-access"
      aria-label={`Extensions from ${access.name}`}
    >
      <p>
        {access.allowed
          ? `Extensions from ${access.name} are allowed on this device.`
          : installation
            ? `You can install this plugin now. Its custom extension code stays off on this device until you allow extensions from ${access.name}. Built-in views still work.`
            : `Extensions from ${access.name} are off on this device.`}
      </p>
      <Button onClick={access.allowed ? access.disable : access.review}>
        {access.allowed ? 'Turn off extensions' : 'Review and enable'}
      </Button>
      {access.dialog}
    </section>
  );
}
