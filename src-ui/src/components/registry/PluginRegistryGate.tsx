import {
  useConnectionStatus,
  useConnections,
} from '@kontourai/station-connect';
import { useQueryClient } from '@tanstack/react-query';
import {
  type ReactNode,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { useApiBase } from '../../contexts/ApiBaseContext';
import {
  BANNER_IDS,
  BANNER_PRIORITY,
  bannerStore,
} from '../../contexts/banner-store';
import { useNavigation } from '../../contexts/NavigationContext';
import { pluginRegistry } from '../../core/PluginRegistry';
import { EXTENSIONS_UNAVAILABLE_LABEL } from '../../core/pluginRegistryCopy';
import {
  remoteIsolationDismissalIsStored,
  remotePluginBundlesAllowed,
  storeRemoteIsolationDismissal,
  subscribeRemotePluginBundleConsent,
} from '../../core/remotePluginBundleConsent';
import {
  checkServerHealth,
  probeServerConnection,
} from '../../lib/serverHealth';

/**
 * Storage access can throw (disabled/private-mode browsers). A persistence
 * failure must degrade to session-only dismissal, never break the registry
 * bootstrap.
 */
export function PluginRegistryBootstrap() {
  const { navigate } = useNavigation();
  const { apiBase } = useApiBase();
  const { activeConnection } = useConnections();
  const { status: connectionStatus } = useConnectionStatus({
    checkHealth: checkServerHealth,
    probeEndpoint: probeServerConnection,
    pollInterval: 10_000,
  });
  const queryClient = useQueryClient();
  const loadStatus = useSyncExternalStore(
    pluginRegistry.subscribe,
    pluginRegistry.getLoadStatus,
  );
  const activeConnectionId = activeConnection?.id ?? 'default';
  const remoteProfile = Boolean(
    activeConnection &&
      !activeConnection.injected &&
      !activeConnection.ownerId,
  );
  const [allowRemoteBundles, setAllowRemoteBundles] = useState(() =>
    remotePluginBundlesAllowed(activeConnectionId, apiBase),
  );
  useEffect(() => {
    const refreshConsent = () =>
      setAllowRemoteBundles(
        remotePluginBundlesAllowed(activeConnectionId, apiBase),
      );
    refreshConsent();
    return subscribeRemotePluginBundleConsent(refreshConsent);
  }, [activeConnectionId, apiBase]);
  const connectionKey = [
    activeConnectionId,
    apiBase,
    activeConnection?.credentialState ?? 'none',
  ].join(':');
  const previousConnectionStatus = useRef(connectionStatus);
  const justReconnected =
    connectionStatus === 'connected' &&
    previousConnectionStatus.current !== 'connected';

  useEffect(() => {
    pluginRegistry.setApiBase(apiBase, connectionKey, {
      allowRemoteBundles,
      remoteProfile,
    });
    void pluginRegistry.reload();
  }, [allowRemoteBundles, apiBase, connectionKey, remoteProfile]);

  useEffect(() => {
    if (loadStatus.state === 'loading') return;
    void queryClient.invalidateQueries({ queryKey: ['layouts'] });
  }, [loadStatus, queryClient]);

  useEffect(() => {
    const previous = previousConnectionStatus.current;
    previousConnectionStatus.current = connectionStatus;
    if (
      previous !== 'connected' &&
      connectionStatus === 'connected' &&
      // Not just `degraded`: an outage-era attempt still in flight at the
      // moment of reconnect settles degraded AFTER this transition is spent,
      // so gating on the settled state loses the reload entirely and the
      // banner then reports a failure no post-reconnect attempt produced.
      // `reload` coalesces an in-flight pass through `reloadQueued`.
      loadStatus.state !== 'ready' &&
      loadStatus.failure !== 'remote-isolation'
    ) {
      void pluginRegistry.reload();
    }
  }, [connectionStatus, loadStatus]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: activeConnectionId is the trigger — the previous profile's banner must drop exactly when the profile changes.
  useEffect(
    () => () => {
      // One chrome banner is shared across profiles. Remove the previous
      // profile's instance before the next profile projects its own state.
      bannerStore.dismiss(BANNER_IDS.pluginRegistry);
    },
    [activeConnectionId],
  );

  useEffect(() => {
    const connectionCausedFailure =
      loadStatus.failure !== 'remote-isolation' &&
      (connectionStatus !== 'connected' || justReconnected);
    if (loadStatus.state === 'ready' || connectionCausedFailure) {
      bannerStore.dismiss(BANNER_IDS.pluginRegistry);
      return;
    }
    if (loadStatus.state === 'loading') return;

    if (allowRemoteBundles) {
      bannerStore.dismiss(BANNER_IDS.pluginRegistry);
      return;
    }

    if (
      loadStatus.failure === 'remote-isolation' &&
      remoteIsolationDismissalIsStored(activeConnectionId)
    ) {
      bannerStore.dismiss(BANNER_IDS.pluginRegistry);
      return;
    }

    const failedPluginNames = loadStatus.failedPluginNames.join(', ');
    const message =
      loadStatus.failure === 'remote-isolation'
        ? 'Extensions are off for this remote Station on this device. You can turn them on from the Registry, which explains the trade-off first.'
        : loadStatus.failure === 'bundle-load-failure' && failedPluginNames
          ? `Station could not load the extension bundle for ${failedPluginNames}. Its plugin-provided panes and capabilities remain unavailable until the bundle loads.`
          : 'Station could not load the plugin registry. Plugin-provided panes and capabilities remain unavailable until it reconnects.';
    bannerStore.present({
      id: BANNER_IDS.pluginRegistry,
      priority: BANNER_PRIORITY.capabilityFailure,
      tone: 'warning',
      badge: EXTENSIONS_UNAVAILABLE_LABEL,
      message,
      occurrence:
        loadStatus.failure === 'remote-isolation'
          ? activeConnectionId
          : undefined,
      actions:
        loadStatus.failure === 'remote-isolation'
          ? [
              {
                label: 'Review in Registry',
                onClick: () => navigate('/registry'),
              },
            ]
          : [
              {
                label: 'Retry extensions',
                onClick: () => void pluginRegistry.reload(),
              },
            ],
      // Genuine registry incidents remain active capability invariants and
      // clear only after a confirmed ready reload. Remote isolation is a
      // permanent property of this profile, so remember a user's notice.
      dismissible: loadStatus.failure === 'remote-isolation',
      dismissAriaLabel:
        loadStatus.failure === 'remote-isolation'
          ? 'Dismiss extensions unavailable notice'
          : undefined,
      onDismiss:
        loadStatus.failure === 'remote-isolation'
          ? () => {
              storeRemoteIsolationDismissal(activeConnectionId);
            }
          : undefined,
    });
  }, [
    activeConnectionId,
    allowRemoteBundles,
    connectionStatus,
    justReconnected,
    loadStatus,
    navigate,
  ]);

  useEffect(
    () => () => {
      bannerStore.dismiss(BANNER_IDS.pluginRegistry);
    },
    [],
  );

  return null;
}

export function PluginRegistryGate({ children }: { children: ReactNode }) {
  // Plugin discovery is not a pre-shell gate. Keep the core Station shell
  // usable while a bounded reload runs or while contributed capabilities fail.
  return (
    <>
      <PluginRegistryBootstrap />
      {children}
    </>
  );
}
