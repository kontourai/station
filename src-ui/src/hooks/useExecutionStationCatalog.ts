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

export function useExecutionStationCatalog(
  profile: AgentData,
  environmentId: string,
) {
  const scope = useHostRequestAuthorityScope();
  const device = useDevicePresentation();
  const enabled = Boolean(scope?.isCurrent());
  const environments = useSshEnvironmentsQuery({ enabled });
  const peers = usePeerCredentialsQuery({ enabled });
  const saved = environments.isSuccess ? (environments.data ?? []) : [];
  const paired = peers.isSuccess
    ? selectablePeerStations(peers.data, saved)
    : [];
  const stations = [
    { id: 'current', name: device?.hostName ?? 'This Station' },
    ...saved.flatMap((entry) =>
      entry.profile.environmentId
        ? [{ id: entry.profile.environmentId, name: entry.profile.name }]
        : [],
    ),
    ...paired.map((entry) => ({
      id: entry.environmentId,
      name: peerStationLabel(entry),
    })),
  ];
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
    stationsUnavailable: environments.isError || peers.isError,
  };
}
