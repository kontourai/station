import type { EnvironmentRef } from '@kontourai/station-contracts/execution-target';
import {
  usePeerCredentialsQuery,
  useSshEnvironmentsQuery,
} from '@kontourai/station-sdk';
import { getAuthorityObservation } from '@kontourai/station-sdk/authority-observation';
import { discoverDelegationOptions } from '@kontourai/station-sdk/client';
import { useQuery } from '@tanstack/react-query';
import type { AgentData } from '../contexts/AgentsContext';
import { useHostRequestAuthorityScope } from '../contexts/ApiBaseContext';
import {
  peerPlacementRefusals,
  sshPlacementRefusals,
} from '../utils/executionPlacement';
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
 * them. Each list joins only when its read SUCCEEDS for this caller: a
 * scoped Device whose `GET /api/environments/peers` is refused
 * (`access:manage`) never sees a paired choice. A listed Station is offered
 * only when the task launcher would accept it (`executionPlacement.ts`, the
 * rules both read): no unverified SSH environment, no SSH environment while a
 * Project is selected, no paired Station whose credential cannot operate.
 *
 * Another Station runs the work as a task, which needs
 * `orchestration:operate` here, so a caller whose authority observation
 * reports a grant without it is offered This Station only. An observation
 * that cannot be read (an older Station without it, or a failed read) hides
 * nothing: the launcher and the server still refuse what is not allowed.
 * `settled` is false until every read has answered, so nothing is offered
 * before it is known.
 *
 * A paired Station whose id is also a saved SSH profile is that SSH profile:
 * the server resolves a saved id to its SSH profile first and the launcher
 * selects it the same way, so it is listed (or refused) once, as SSH.
 */
export function useExecutionStations({
  projectSelected = false,
}: {
  projectSelected?: boolean;
} = {}) {
  const scope = useHostRequestAuthorityScope();
  const device = useDevicePresentation();
  const enabled = Boolean(scope?.isCurrent());
  const environments = useSshEnvironmentsQuery({ enabled });
  const peers = usePeerCredentialsQuery({ enabled });
  const authority = useQuery({
    queryKey: [
      'execution-station-authority',
      scope?.apiBase,
      scope?.authorityKey,
    ],
    enabled,
    staleTime: 0,
    retry: false,
    queryFn: ({ signal }) => {
      if (!scope?.isCurrent())
        throw new Error('Reconnect to this Station before choosing one.');
      return getAuthorityObservation(scope.apiBase, {
        requestScope: scope,
        signal,
      });
    },
  });
  const grant = authority.data?.grant;
  const canStartTasks = authority.isError
    ? true
    : grant?.kind === 'operator' ||
      (grant?.kind === 'device' &&
        grant.grantedScopes.includes('orchestration:operate'));
  const saved = environments.isSuccess ? (environments.data ?? []) : [];
  const paired = peers.isSuccess
    ? selectablePeerStations(peers.data, saved)
    : [];
  const current: ExecutionStation = {
    id: 'current',
    name: device?.hostName ?? 'This Station',
    kind: 'current',
  };
  const listed: Array<ExecutionStation & { offered: boolean }> = [
    { ...current, offered: true },
    ...saved.flatMap((entry) =>
      entry.profile.environmentId
        ? [
            {
              id: entry.profile.environmentId,
              name: entry.profile.name,
              kind: 'ssh' as const,
              offered:
                canStartTasks &&
                sshPlacementRefusals(entry.profile, projectSelected).length ===
                  0,
            },
          ]
        : [],
    ),
    ...paired.map((entry) => ({
      id: entry.environmentId,
      name: peerStationLabel(entry),
      kind: 'paired' as const,
      offered: canStartTasks && peerPlacementRefusals(entry).length === 0,
    })),
  ];
  const stations: ExecutionStation[] = listed
    .filter((station) => station.offered)
    .map(({ offered: _offered, ...station }) => station);
  return {
    enabled,
    stations,
    /** A listed Station's name, offered or not (a remembered choice). */
    nameFor: (id: string) => listed.find((station) => station.id === id)?.name,
    settled:
      enabled &&
      (environments.isSuccess || environments.isError) &&
      (peers.isSuccess || peers.isError) &&
      (authority.isSuccess || authority.isError),
    stationsUnavailable: environments.isError || peers.isError,
  };
}

export function useExecutionStationCatalog(
  profile: AgentData,
  environmentId: string,
  projectSelected = false,
) {
  const scope = useHostRequestAuthorityScope();
  const { enabled, stations, nameFor, stationsUnavailable } =
    useExecutionStations({ projectSelected });
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
  const stationName = nameFor(environmentId) ?? 'Selected Station';
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
