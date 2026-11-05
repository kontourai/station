import { AUTHORITY_OBSERVATION_SCHEMA_VERSION } from '@kontourai/station-contracts/authority-observation';
import {
  conversationCapabilitiesFromAuthority,
  type StationConnection,
} from '../../../connections/station-connection';

/** Client network fixtures; these are not evidence of server authorization. */
export function conversationConnection(
  routeKind: StationConnection['routeKind'],
): StationConnection {
  const source = 'http://source.test';
  const environmentId = routeKind === 'host' ? 'source' : 'receiver';
  const targetApiBase =
    routeKind === 'relay'
      ? `${source}/api/environments/peers/receiver/chat-api`
      : routeKind === 'host'
        ? source
        : 'http://receiver.test';
  const namespace = `${routeKind}-principal`;
  return {
    environmentId,
    stationName: routeKind === 'host' ? 'Source' : 'Receiver',
    stationKey: `${namespace}:${environmentId}`,
    routeKind,
    targetApiBase,
    requestScope: {
      apiBase: routeKind === 'relay' ? source : targetApiBase,
      authorityKey: namespace,
    },
    authorityNamespace: namespace,
    runtimeKey: namespace,
    binding: {
      version: 1,
      environmentId,
      stationName: routeKind === 'host' ? 'Source' : 'Receiver',
      affinity:
        routeKind === 'host'
          ? { kind: 'host' }
          : routeKind === 'relay'
            ? {
                kind: 'peer',
                sourceEnvironmentId: 'source',
                sourceConnectionId: 'source-profile',
                principalNamespace: namespace,
              }
            : {
                kind: 'device',
                connectionId: 'receiver-profile',
                principalNamespace: namespace,
              },
    },
    capabilities: conversationCapabilitiesFromAuthority(
      {
        schemaVersion: AUTHORITY_OBSERVATION_SCHEMA_VERSION,
        environmentId,
        principal: { kind: 'human', id: 'fixture-person' },
        grant: {
          kind: 'device',
          deviceId: 'fixture-device',
          grantedScopes: ['orchestration:read', 'orchestration:operate'],
        },
      },
      { remote: routeKind !== 'host', mutationAllowed: true },
    ),
    isCurrent: () => true,
  };
}
