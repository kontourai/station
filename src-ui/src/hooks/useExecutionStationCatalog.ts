import type { EnvironmentRef } from '@kontourai/station-contracts/execution-target';
import {
  usePeerCredentialsQuery,
  useSshEnvironmentsQuery,
} from '@kontourai/station-sdk';
import { discoverDelegationOptions } from '@kontourai/station-sdk/client';
import { useQuery } from '@tanstack/react-query';
import type { AgentData } from '../contexts/AgentsContext';
import { useHostRequestAuthorityScope } from '../contexts/ApiBaseContext';
import {
  profileCompatibilityReason,
  type SelectableModel,
} from '../utils/modelCapabilities';
import {
  peerStationLabel,
  selectablePeerStations,
} from '../utils/peerEnvironmentOptions';
import { useDevicePresentation } from './useDevicePresentation';

export type ExecutionStation = {
  id: string;
  name: string;
  kind: 'current' | 'ssh' | 'paired';
};

/**
 * The Stations this caller may choose to run work on, as the server reports
 * them: This Station, every SSH environment with a verified Project path, and
 * every paired Station. Each list joins only when its read SUCCEEDS for this
 * caller — a scoped Device whose `GET /api/environments/peers` is refused
 * (`access:manage`) never sees a paired choice, and an unverified SSH
 * environment (which the task launcher refuses) is never offered. `settled`
 * is false until both reads have answered, so a caller can avoid offering a
 * choice before it knows there is one.
 */
export function useExecutionStations() {
  const scope = useHostRequestAuthorityScope();
  const device = useDevicePresentation();
  const enabled = Boolean(scope?.isCurrent());
  const environments = useSshEnvironmentsQuery({ enabled });
  const peers = usePeerCredentialsQuery({ enabled });
  const saved = environments.isSuccess ? (environments.data ?? []) : [];
  const paired = peers.isSuccess
    ? selectablePeerStations(peers.data, saved)
    : [];
  const stations: ExecutionStation[] = [
    {
      id: 'current',
      name: device?.hostName ?? 'This Station',
      kind: 'current',
    },
    ...saved.flatMap((entry): ExecutionStation[] =>
      entry.profile.environmentId && entry.profile.verifiedProjectPath
        ? [
            {
              id: entry.profile.environmentId,
              name: entry.profile.name,
              kind: 'ssh',
            },
          ]
        : [],
    ),
    ...paired.map(
      (entry): ExecutionStation => ({
        id: entry.environmentId,
        name: peerStationLabel(entry),
        kind: 'paired',
      }),
    ),
  ];
  return {
    enabled,
    stations,
    settled:
      enabled &&
      (environments.isSuccess || environments.isError) &&
      (peers.isSuccess || peers.isError),
    stationsUnavailable: environments.isError || peers.isError,
  };
}

export function useExecutionStationCatalog(
  profile: AgentData,
  environmentId: string,
) {
  const scope = useHostRequestAuthorityScope();
  const { enabled, stations, stationsUnavailable } = useExecutionStations();
  const query = useQuery({
    queryKey: [
      'execution-station-catalog',
      scope?.authorityKey,
      scope?.apiBase,
      environmentId,
    ],
    enabled: enabled && environmentId !== 'current',
    staleTime: 0,
    refetchOnMount: 'always',
    retry: false,
    queryFn: () => {
      if (!scope?.isCurrent())
        throw new Error(
          'Reconnect to this Station before reading engine choices.',
        );
      return discoverDelegationOptions(
        scope.apiBase,
        { environmentId },
        { requestScope: scope },
      );
    },
  });
  const catalog =
    enabled && query.isSuccess && !query.isFetching ? query.data : undefined;
  const sameEnvironment = catalog?.environment.id === environmentId;
  const counterpart = sameEnvironment
    ? catalog.targets.find(
        (entry) =>
          entry.id === profile.slug &&
          profile.definitionFingerprint &&
          entry.definitionFingerprint === profile.definitionFingerprint,
      )
    : undefined;
  const stationName =
    stations.find((entry) => entry.id === environmentId)?.name ??
    'Selected Station';
  const models: SelectableModel[] = counterpart
    ? catalog!.targets.flatMap((binding) => {
        if (!binding.executionDefault) return [];
        const incompatibility =
          profileCompatibilityReason(
            counterpart.profileCapabilities,
            binding.unsupportedProfileCapabilities,
          ) ??
          (binding.engineId === 'station' && counterpart.engineId !== 'station'
            ? 'This Station engine cannot apply an external Agent profile as an override.'
            : undefined);
        return binding.models.map((model) => ({
          ...model,
          executionAgentId: binding.id,
          providerId: binding.engineConnectionId ?? binding.id,
          engineId: binding.engineId,
          engineName: binding.engineName,
          stationName,
          environmentId,
          expectedDefinitionFingerprint: profile.definitionFingerprint,
          available:
            counterpart.ready &&
            binding.executionReady === true &&
            !incompatibility,
          unavailableReason:
            incompatibility ??
            (!counterpart.ready
              ? counterpart.unavailableReason
              : binding.executionReady
                ? undefined
                : (binding.unavailableReason ?? 'Engine is not ready.')),
        }));
      })
    : [];
  return {
    stations,
    models,
    loading: environmentId !== 'current' && query.isFetching,
    error: query.error,
    unmatched: environmentId !== 'current' && sameEnvironment && !counterpart,
    stationName,
    stationsUnavailable,
  };
}

/**
 * Where a start runs before anything is chosen: an explicit choice wins,
 * else the Project's saved default environment, else This Station.
 */
export function effectiveExecutionStationId(
  environmentId: string | undefined,
  projectDefault: EnvironmentRef | undefined,
): string {
  if (environmentId) return environmentId;
  return projectDefault?.kind === 'saved' ? projectDefault.id : 'current';
}
