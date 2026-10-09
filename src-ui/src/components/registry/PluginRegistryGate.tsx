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
import { BANNER_IDS, bannerStore } from '../../contexts/banner-store';
import { useNavigation } from '../../contexts/NavigationContext';
import { toastStore } from '../../contexts/ToastContext';
import { pluginRegistry } from '../../core/PluginRegistry';
import {
  remotePluginBundlesAllowed,
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
    activeConnection && !activeConnection.injected && !activeConnection.ownerId,
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
  const initialConnection = useRef(connectionStatus === 'connecting');
  const retryAfterInitialLoad = useRef(false);
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
    const firstConnection =
      initialConnection.current && connectionStatus === 'connected';
    if (connectionStatus !== 'connecting') initialConnection.current = false;
    if (connectionStatus !== 'connected') retryAfterInitialLoad.current = false;
    const needsRetry =
      loadStatus.state !== 'ready' && loadStatus.failure !== 'remote-isolation';
    if (retryAfterInitialLoad.current && loadStatus.state !== 'loading') {
      retryAfterInitialLoad.current = false;
      if (needsRetry) void pluginRegistry.reload();
    }
    if (
      previous !== 'connected' &&
      connectionStatus === 'connected' &&
      needsRetry
    ) {
      // The first health result can arrive while a successful initial load is
      // running. Queuing a reload then tears down its freshly mounted panes.
      // An actual outage still queues a fresh pass, even before its old load
      // settles; a failed first load gets one retry after it settles.
      if (firstConnection && loadStatus.state === 'loading')
        retryAfterInitialLoad.current = true;
      else void pluginRegistry.reload();
    }
  }, [connectionStatus, loadStatus]);

  const notifiedIncident = useRef<string | null>(null);
  useEffect(() => {
    bannerStore.dismiss(BANNER_IDS.pluginRegistry);
    if (pluginRegistry.getLoadStatus() !== loadStatus) return;
    if (loadStatus.state === 'ready') {
      notifiedIncident.current = null;
      return;
    }
    if (
      loadStatus.state === 'loading' ||
      loadStatus.failure === 'remote-isolation' ||
      connectionStatus !== 'connected' ||
      justReconnected
    )
      return;
    const incident = JSON.stringify([
      connectionKey,
      loadStatus.failure,
      loadStatus.failedPluginNames,
    ]);
    if (notifiedIncident.current === incident) return;
    notifiedIncident.current = incident;
    const message =
      loadStatus.failure === 'bundle-load-failure' &&
      loadStatus.failedPluginNames.length
        ? `Station could not load extensions: ${loadStatus.failedPluginNames.join(', ')}.`
        : 'Station could not load extensions.';
    const noticeId = toastStore.show(
      message,
      undefined,
      9000,
      [{ label: 'Open Extensions', onClick: () => navigate('/registry') }],
      undefined,
      'warning',
    );
    return () => toastStore.dismiss(noticeId);
  }, [connectionKey, connectionStatus, justReconnected, loadStatus, navigate]);

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
