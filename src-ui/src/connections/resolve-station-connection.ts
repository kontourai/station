import type { SavedConnection } from '@kontourai/station-connect';
import type { AuthorityObservation } from '@kontourai/station-contracts/authority-observation';
import { parsePublicStationHandshake } from '@kontourai/station-contracts/environment-security';
import {
  STATION_ENVELOPE_HEADER,
  STATION_ENVELOPE_HEADER_VALUE,
} from '@kontourai/station-contracts/http';
import { parsePeerChatConnection } from '@kontourai/station-contracts/peer-chat';
import { hasCapability } from '@kontourai/station-sdk';
import { getAuthorityObservation } from '@kontourai/station-sdk/authority-observation';
import {
  type ApiRequestScope,
  DEFAULT_CLIENT_REQUEST_TIMEOUT_MS,
  getJson,
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
      if (affinity?.kind === 'peer') break;
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
    if (!affinity || affinity.kind === 'peer') {
      if (!source.isCurrent() || !registry.isCurrent())
        throw new StationRequestAuthorityError();
      if (source.mutationAllowed === false)
        throw new StationConnectionUnavailableError('protocol-unavailable');
      const opts = {
        requestScope: source.requestScope,
        timeoutMs: DEFAULT_CLIENT_REQUEST_TIMEOUT_MS,
      };
      const handshakeReply = await getJson(
        `${source.requestScope.apiBase}/.well-known/station/v1`,
        opts,
      );
      const handshake = handshakeReply.ok
        ? parsePublicStationHandshake(await handshakeReply.json())
        : null;
      if (!hasCapability(handshake, 'peerChatTunnelV1'))
        throw new StationConnectionUnavailableError('protocol-unavailable');
      const prefix = `${source.requestScope.apiBase}/api/environments/peers/${encodeURIComponent(environmentId)}`;
      const reply = await getJson(`${prefix}/chat-connection`, opts);
      const envelope: unknown = await reply.json();
      const descriptor =
        reply.ok &&
        reply.headers.get(STATION_ENVELOPE_HEADER) ===
          STATION_ENVELOPE_HEADER_VALUE &&
        envelope &&
        typeof envelope === 'object' &&
        'data' in envelope
          ? parsePeerChatConnection(envelope.data)
          : null;
      if (
        !source.isCurrent() ||
        !descriptor ||
        descriptor.environmentId !== environmentId ||
        (affinity?.kind === 'peer' &&
          (affinity.sourceEnvironmentId !== source.observation.environmentId ||
            affinity.sourceConnectionId !== source.connectionId ||
            affinity.principalNamespace !== descriptor.principalNamespace))
      )
        throw new StationConnectionUnavailableError('authority-unavailable');
      const ceiling = conversationCapabilitiesFromAuthority(
        source.observation,
        { remote: true, mutationAllowed: true },
      );
      const capabilities = { ...ceiling };
      const reads = new Set([
        'historyRead',
        'liveEvents',
        'contentRead',
        'attachmentRead',
        'deliveryLookup',
        'approvalInspect',
        'checkpointRead',
      ]);
      const unsupported = new Set([
        'folderSelect',
        'fullAccess',
        'approvalTrustTool',
        'approvalTrustServer',
        'fork',
        'childInstruction',
        'sharedHistoryRead',
        'uiBlockActions',
      ]);
      for (const name of Object.keys(
        capabilities,
      ) as (keyof typeof capabilities)[]) {
        if (
          unsupported.has(name) ||
          (!descriptor.ceiling.localConversation &&
            ['continue', 'queue'].includes(name))
        )
          capabilities[name] = {
            state: 'denied',
            reason: unsupported.has(name)
              ? 'direct-connection-required'
              : 'protocol-unavailable',
          };
        else if (
          reads.has(name)
            ? !descriptor.ceiling.read
            : !descriptor.ceiling.operate
        )
          capabilities[name] = {
            state: 'denied',
            reason: 'permission-required',
          };
      }
      return {
        environmentId,
        stationName: descriptor.stationName,
        stationKey: stationConnectionKey(
          source.authorityNamespace,
          environmentId,
        ),
        routeKind: 'relay',
        targetApiBase: `${prefix}/chat-api`,
        requestScope: source.requestScope,
        authorityNamespace: JSON.stringify([
          source.authorityNamespace,
          descriptor.principalNamespace,
        ]),
        binding: {
          version: 1,
          environmentId,
          stationName: descriptor.stationName,
          affinity: {
            kind: 'peer',
            sourceEnvironmentId: source.observation.environmentId,
            sourceConnectionId: source.connectionId,
            principalNamespace: descriptor.principalNamespace,
          },
        },
        capabilities,
        isCurrent: source.isCurrent,
        dispose: () => {},
      } satisfies PreparedStationConnection;
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
