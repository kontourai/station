import type { SavedConnection } from '@kontourai/station-connect';
import type { AuthorityObservation } from '@kontourai/station-contracts/authority-observation';
import { getAuthorityObservation } from '@kontourai/station-sdk/authority-observation';
import {
  type ApiRequestScope,
  DEFAULT_CLIENT_REQUEST_TIMEOUT_MS,
  StationRequestAuthorityError,
} from '@kontourai/station-sdk/client';
import { buildAuthorityNamespace } from '../lib/authorityNamespace';
import {
  type ChatStationBindingV1,
  conversationCapabilitiesFromAuthority,
  stationConnectionKey,
} from './station-connection';
import { captureStationConnectionAuthority } from './station-connection-authority';
import {
  type PreparedStationConnection,
  type StationConnectionLease,
  StationConnectionRegistry,
} from './station-connection-registry';

export class StationConnectionUnavailableError extends Error {
  constructor(
    readonly reason:
      | 'profile-unavailable'
      | 'protocol-unavailable'
      | 'authority-unavailable',
  ) {
    super('Station connection unavailable');
    this.name = 'StationConnectionUnavailableError';
  }
}

export interface StationConnectionSource {
  authorityNamespace: string;
  observation: AuthorityObservation;
  connectionId: string;
  stationName: string;
  requestScope: ApiRequestScope;
  mutationAllowed?: boolean;
  isCurrent(): boolean;
}

export interface ResolveStationConnectionOptions {
  registry: StationConnectionRegistry;
  source: StationConnectionSource;
  profiles: readonly SavedConnection[];
  environmentId?: string;
  binding?: ChatStationBindingV1;
}

export async function resolveStationConnection(
  options: ResolveStationConnectionOptions,
): Promise<StationConnectionLease> {
  const { registry, source, profiles, binding } = options;
  const environmentId =
    binding?.environmentId ??
    options.environmentId ??
    source.observation.environmentId;
  if (!source.isCurrent()) throw new StationRequestAuthorityError();
  if (binding?.affinity.kind === 'peer')
    throw new StationConnectionUnavailableError('protocol-unavailable');
  if (
    binding?.affinity.kind === 'host' &&
    environmentId !== source.observation.environmentId
  )
    throw new StationConnectionUnavailableError('authority-unavailable');
  const lease = await registry.acquire(environmentId, async () => {
    if (
      environmentId === source.observation.environmentId &&
      (!binding || binding.affinity.kind === 'host')
    ) {
      return {
        environmentId,
        stationName: source.stationName,
        stationKey: stationConnectionKey(
          source.authorityNamespace,
          environmentId,
        ),
        routeKind: 'host',
        targetApiBase: source.requestScope.apiBase,
        requestScope: source.requestScope,
        authorityNamespace: source.authorityNamespace,
        binding: {
          version: 1,
          environmentId,
          stationName: source.stationName,
          affinity: { kind: 'host' },
        },
        capabilities: conversationCapabilitiesFromAuthority(
          source.observation,
          { remote: false, mutationAllowed: source.mutationAllowed ?? true },
        ),
        isCurrent: source.isCurrent,
        dispose: () => {},
      } satisfies PreparedStationConnection;
    }
    const affinity = binding?.affinity;
    const candidates = profiles.filter(
      (profile) =>
        profile.environmentId === environmentId &&
        (profile.credentialState === 'saved' ||
          profile.credentialState === 'device-session') &&
        (affinity?.kind !== 'device' || profile.id === affinity.connectionId),
    );
    for (const profile of candidates) {
      const authority = await captureStationConnectionAuthority(
        profile.id,
        () => source.isCurrent() && registry.isCurrent(),
      ).catch(() => null);
      if (!authority) continue;
      try {
        // Saved handshake identity is only a candidate. Verify this principal
        // at the exact captured endpoint before publishing a usable route.
        const observation = await getAuthorityObservation(
          authority.requestScope.apiBase,
          {
            requestScope: authority.requestScope,
            timeoutMs: DEFAULT_CLIENT_REQUEST_TIMEOUT_MS,
          },
        );
        if (
          !authority.isCurrent() ||
          !source.isCurrent() ||
          observation.environmentId !== environmentId
        )
          throw new StationRequestAuthorityError();
        const principalNamespace = buildAuthorityNamespace(observation);
        if (
          affinity?.kind === 'device' &&
          affinity.principalNamespace !== principalNamespace
        )
          throw new StationRequestAuthorityError();
        return {
          environmentId,
          stationName: profile.name,
          stationKey: stationConnectionKey(
            source.authorityNamespace,
            environmentId,
          ),
          routeKind: 'direct',
          targetApiBase: authority.requestScope.apiBase,
          requestScope: authority.requestScope,
          authorityNamespace: JSON.stringify([
            source.authorityNamespace,
            principalNamespace,
          ]),
          binding: {
            version: 1,
            environmentId,
            stationName: profile.name,
            affinity: {
              kind: 'device',
              connectionId: profile.id,
              principalNamespace,
            },
          },
          capabilities: conversationCapabilitiesFromAuthority(observation, {
            remote: true,
            mutationAllowed: authority.mutationAllowed,
          }),
          isCurrent: () => source.isCurrent() && authority.isCurrent(),
          dispose: authority.release,
        } satisfies PreparedStationConnection;
      } catch {
        authority.release();
      }
    }
    throw new StationConnectionUnavailableError('profile-unavailable');
  });
  const selected = lease.connection.binding.affinity;
  if (
    binding &&
    (selected.kind !== binding.affinity.kind ||
      (selected.kind === 'device' &&
        binding.affinity.kind === 'device' &&
        (selected.connectionId !== binding.affinity.connectionId ||
          selected.principalNamespace !== binding.affinity.principalNamespace)))
  ) {
    lease.release();
    throw new StationConnectionUnavailableError('profile-unavailable');
  }
  return lease;
}
