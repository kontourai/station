import { useConnections } from '@kontourai/station-connect';
import { useFeaturePreviewsQuery } from '@kontourai/station-sdk';
import { useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useInsertionEffect,
  useMemo,
  useRef,
} from 'react';
import { useHostRequestAuthorityScope } from '../contexts/ApiBaseContext';
import { useAuthorityPersistence } from '../contexts/AuthorityPersistenceContext';
import { useActiveStationName } from '../hooks/useActiveStationName';
import type {
  resolveStationConnection,
  StationConnectionSource,
} from './resolve-station-connection';
import type { ChatStationBindingV1 } from './station-connection';
import {
  registerStationConnectionRegistry,
  StationConnectionRegistry,
} from './station-connection-registry';

interface StationConnections {
  readonly ready: boolean;
  readonly remoteEnabled: boolean;
  resolve(options?: {
    environmentId?: string;
    binding?: ChatStationBindingV1;
    legacyPeer?: boolean;
  }): ReturnType<typeof resolveStationConnection>;
}

const StationConnectionsContext = createContext<StationConnections | null>(
  null,
);

export function StationConnectionsProvider({
  children,
}: {
  children: ReactNode;
}) {
  const { namespace, observation } = useAuthorityPersistence();
  const queryClient = useQueryClient();
  const { activeConnection, connections } = useConnections();
  const activeStationName = useActiveStationName();
  const scope = useHostRequestAuthorityScope();
  const previews = useFeaturePreviewsQuery();
  const remoteEnabled =
    previews.data?.some(
      (preview) => preview.id === 'paired-station-chats' && preview.enabled,
    ) === true;
  const remotePreviewRef = useRef({ enabled: remoteEnabled, epoch: 0 });
  if (remotePreviewRef.current.enabled !== remoteEnabled)
    remotePreviewRef.current = {
      enabled: remoteEnabled,
      epoch: remotePreviewRef.current.epoch + 1,
    };
  // biome-ignore lint/correctness/useExhaustiveDependencies: replacing a query client must mint fresh leases even under the same namespace and scope.
  const registry = useMemo(
    () =>
      new StationConnectionRegistry(() =>
        Boolean(namespace && scope?.isCurrent()),
      ),
    [namespace, scope, queryClient],
  );
  // Insertion cleanup retires the old namespace before descendant layout
  // effects can publish data during an authority replacement.
  useInsertionEffect(
    () => registerStationConnectionRegistry(queryClient, registry),
    [queryClient, registry],
  );
  useEffect(() => {
    if (!remoteEnabled) registry.retireRemote();
  }, [registry, remoteEnabled]);
  // Saved profiles are re-created by every health tick (`lastSuccessAt`,
  // `lastBootId`), so their object identity is not a route change. Keying the
  // value on them made every tick re-resolve each remote chat: a new peer
  // descriptor, a restarted event stream and every conversation read refetched
  // (the "reloading" relay chat). The value follows only the facts `resolve`
  // routes on; `resolve` itself reads the latest profiles.
  const profilesRef = useRef({ activeConnection, connections });
  profilesRef.current = { activeConnection, connections };
  const routeKey = JSON.stringify([
    activeConnection
      ? [
          activeConnection.id,
          activeConnection.name,
          Boolean(activeConnection.brokerRoute),
          Boolean(activeConnection.nativeBrokerRoute),
        ]
      : null,
    connections.map((profile) => [
      profile.id,
      profile.name,
      profile.environmentId,
      profile.credentialState,
    ]),
  ]);
  const hasActiveConnection = Boolean(activeConnection);
  // biome-ignore lint/correctness/useExhaustiveDependencies: routeKey stands for the profiles read through profilesRef.
  const value = useMemo<StationConnections>(
    () => ({
      ready: Boolean(
        namespace &&
          observation &&
          scope?.isCurrent() &&
          hasActiveConnection &&
          !previews.isPending,
      ),
      remoteEnabled,
      resolve: async (options = {}) => {
        const remoteEpoch = remotePreviewRef.current.epoch;
        const { activeConnection, connections } = profilesRef.current;
        // First paint only needs registry retirement. Route negotiation and
        // its wire parsers load when a conversation requests a connection.
        const { resolveStationConnection, StationConnectionUnavailableError } =
          await import('./resolve-station-connection');
        if (!namespace || !observation || !scope || !activeConnection)
          throw new StationConnectionUnavailableError('authority-unavailable');
        const source: StationConnectionSource = {
          authorityNamespace: namespace,
          observation,
          connectionId: activeConnection.id,
          stationName: activeStationName ?? activeConnection.name,
          requestScope: scope,
          mutationAllowed:
            !activeConnection.brokerRoute &&
            !activeConnection.nativeBrokerRoute,
          isCurrent: scope.isCurrent,
          remoteIsCurrent: () =>
            remotePreviewRef.current.enabled &&
            remotePreviewRef.current.epoch === remoteEpoch,
        };
        return resolveStationConnection({
          registry,
          source,
          profiles: connections,
          ...options,
        });
      },
    }),
    [
      registry,
      namespace,
      observation,
      scope,
      hasActiveConnection,
      routeKey,
      activeStationName,
      remoteEnabled,
      previews.isPending,
    ],
  );
  return (
    <StationConnectionsContext.Provider value={value}>
      {children}
    </StationConnectionsContext.Provider>
  );
}

export function useStationConnections(): StationConnections {
  const connections = useContext(StationConnectionsContext);
  if (!connections) throw new Error('StationConnectionsProvider is required');
  return connections;
}

export function useStationConnectionsOptional(): StationConnections | null {
  return useContext(StationConnectionsContext);
}
