import {
  RELAY_ICE_CONFIGURATION_VERSION,
  RELAY_ICE_MAX_TTL_SECONDS,
  type RelayIceConfigurationV1,
} from '@kontourai/station-contracts/relay-ice';

function exact(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}
function boundedText(value: unknown, max: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= max &&
    [...value].every(
      (character) =>
        character.charCodeAt(0) > 31 && character.charCodeAt(0) !== 127,
    )
  );
}
function turnUrl(value: unknown): value is string {
  if (!boundedText(value, 2048)) return false;
  const match =
    /^(turns?):([a-zA-Z0-9.-]+|\[[a-fA-F0-9:]+\])(?::([0-9]{1,5}))?(?:\?transport=(udp|tcp))?$/u.exec(
      value,
    );
  return (
    !!match &&
    (!match[3] || (Number(match[3]) >= 1 && Number(match[3]) <= 65535)) &&
    (match[1] !== 'turns' || match[4] !== 'udp')
  );
}

/** Structural validation and exact route binding; never an authorization decision. */
export function parseRelayIceConfiguration(
  value: unknown,
  expected: Pick<RelayIceConfigurationV1, 'scope' | 'surface'>,
  now = Date.now(),
): RelayIceConfigurationV1 {
  const refuse = () => {
    throw new Error('relay_ice_configuration_invalid');
  };
  const keys = [
    'version',
    'scope',
    'iceTransportPolicy',
    'issuedAt',
    'expiresAt',
    'iceServers',
    ...(expected.surface ? ['surface'] : []),
  ];
  if (!exact(value, keys)) return refuse();
  if (
    !exact(value.scope, ['stationId', 'enrollmentId', 'routingGeneration']) ||
    !boundedText(value.scope.stationId, 128) ||
    value.scope.stationId.length < 8 ||
    !boundedText(value.scope.enrollmentId, 128) ||
    value.scope.enrollmentId.length < 8 ||
    !Number.isSafeInteger(value.scope.routingGeneration) ||
    (value.scope.routingGeneration as number) < 1 ||
    value.scope.stationId !== expected.scope.stationId ||
    value.scope.enrollmentId !== expected.scope.enrollmentId ||
    value.scope.routingGeneration !== expected.scope.routingGeneration
  )
    return refuse();
  if (
    expected.surface &&
    (!exact(value.surface, [
      'kind',
      'appIdentifier',
      'channel',
      'clientInstanceId',
      'keyThumbprint',
    ]) ||
      value.surface.kind !== 'station-native' ||
      !boundedText(value.surface.appIdentifier, 256) ||
      !['dev', 'beta', 'nightly', 'stable'].includes(
        value.surface.channel as string,
      ) ||
      typeof value.surface.clientInstanceId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
        value.surface.clientInstanceId,
      ) ||
      typeof value.surface.keyThumbprint !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/u.test(value.surface.keyThumbprint) ||
      Object.entries(expected.surface).some(
        ([key, item]) =>
          (value.surface as Record<string, unknown>)[key] !== item,
      ))
  )
    return refuse();
  if (
    value.version !== RELAY_ICE_CONFIGURATION_VERSION ||
    value.iceTransportPolicy !== 'relay' ||
    !Number.isSafeInteger(value.issuedAt) ||
    !Number.isSafeInteger(value.expiresAt) ||
    (value.issuedAt as number) > now + 5000 ||
    (value.expiresAt as number) <= now + 15_000 ||
    (value.expiresAt as number) <= (value.issuedAt as number) ||
    (value.expiresAt as number) - (value.issuedAt as number) >
      RELAY_ICE_MAX_TTL_SECONDS * 1000 ||
    !Array.isArray(value.iceServers) ||
    value.iceServers.length < 1 ||
    value.iceServers.length > 4
  )
    return refuse();
  const iceServers = value.iceServers.map((server: unknown) => {
    if (
      !exact(server, ['urls', 'username', 'credential']) ||
      !Array.isArray(server.urls) ||
      server.urls.length < 1 ||
      server.urls.length > 8 ||
      !server.urls.every(turnUrl) ||
      !boundedText(server.username, 512) ||
      !boundedText(server.credential, 1024)
    )
      return refuse();
    return Object.freeze({
      urls: Object.freeze([...server.urls] as string[]),
      username: server.username,
      credential: server.credential,
    });
  });
  return Object.freeze({
    version: RELAY_ICE_CONFIGURATION_VERSION,
    scope: Object.freeze({ ...expected.scope }),
    ...(expected.surface
      ? { surface: Object.freeze({ ...expected.surface }) }
      : {}),
    iceTransportPolicy: 'relay',
    issuedAt: value.issuedAt as number,
    expiresAt: value.expiresAt as number,
    iceServers: Object.freeze(iceServers),
  });
}
