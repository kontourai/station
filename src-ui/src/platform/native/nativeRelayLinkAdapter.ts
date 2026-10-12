import type { NativeRelayLinkDelivery } from '@kontourai/station-contracts/native-relay-link';
import { invokeTauri, listenTauri } from './tauriInvoke';

const invalid = () =>
  new Error('Station could not verify native link metadata.');
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw invalid();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== keys.sort().join(','))
    throw invalid();
  return record;
}
function text(value: unknown, pattern?: RegExp): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 2048 ||
    (pattern && !pattern.test(value))
  )
    throw invalid();
  return value;
}
function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)
    throw invalid();
  return value;
}
function origin(value: unknown, allowDevelopmentHttp: boolean): string {
  const input = text(value);
  const url = new URL(input);
  if (
    url.origin !== input ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !(
      url.protocol === 'https:' ||
      (allowDevelopmentHttp &&
        url.protocol === 'http:' &&
        ['127.0.0.1', '[::1]'].includes(url.hostname))
    )
  )
    throw invalid();
  return input;
}
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const KEY = /^[A-Za-z0-9_-]{43}$/u;
function delivery(
  value: unknown,
  allowDevelopmentHttp: boolean,
): NativeRelayLinkDelivery {
  if (!value || typeof value !== 'object') throw invalid();
  const kind = (value as Record<string, unknown>).kind;
  if (kind === 'rejected') {
    const dto = object(value, ['kind', 'code', 'message']);
    if (
      !['unsupported', 'invalid', 'expired', 'unavailable'].includes(
        String(dto.code),
      )
    )
      throw invalid();
    return {
      kind,
      code: dto.code as 'unsupported' | 'invalid' | 'expired' | 'unavailable',
      message:
        'Station cannot use this link. Ask the operator for a supported, current link.',
    };
  }
  if (kind !== 'route-intent' && kind !== 'bound-invitation') throw invalid();
  const dto = object(
    value,
    kind === 'route-intent'
      ? ['kind', 'pendingId', 'route']
      : ['kind', 'pendingId', 'route', 'invitation'],
  );
  const rawRoute = object(dto.route, [
    'applicationOrigin',
    'brokerOrigin',
    'stationId',
    'enrollmentId',
  ]);
  const route = {
    applicationOrigin: origin(rawRoute.applicationOrigin, allowDevelopmentHttp),
    brokerOrigin: origin(rawRoute.brokerOrigin, allowDevelopmentHttp),
    stationId: text(rawRoute.stationId, UUID),
    enrollmentId: text(rawRoute.enrollmentId, UUID),
  };
  const pendingId = text(dto.pendingId, UUID);
  if (kind === 'route-intent') return { kind, pendingId, route };
  const raw = object(dto.invitation, [
    'invitationId',
    'expiresAt',
    'routingGeneration',
    'stationSigningKeyId',
    'stationSigningGeneration',
    'surface',
  ]);
  const surface = object(raw.surface, [
    'kind',
    'appIdentifier',
    'channel',
    'clientInstanceId',
    'keyThumbprint',
  ]);
  if (
    surface.kind !== 'station-native' ||
    !['dev', 'stable', 'beta', 'nightly'].includes(String(surface.channel))
  )
    throw invalid();
  return {
    kind,
    pendingId,
    route,
    invitation: {
      invitationId: text(raw.invitationId),
      expiresAt: integer(raw.expiresAt),
      routingGeneration: integer(raw.routingGeneration),
      stationSigningKeyId: text(raw.stationSigningKeyId, KEY),
      stationSigningGeneration: integer(raw.stationSigningGeneration),
      surface: {
        kind: 'station-native',
        appIdentifier: text(surface.appIdentifier),
        channel: surface.channel as 'dev' | 'stable' | 'beta' | 'nightly',
        clientInstanceId: text(surface.clientInstanceId, UUID),
        keyThumbprint: text(surface.keyThumbprint, KEY),
      },
    },
  };
}

/** Register before launch drain; late launch results cannot replace a newer event. */
export async function subscribeNativeRelayLinks(
  receive: (value: NativeRelayLinkDelivery) => void,
  allowDevelopmentHttp: boolean,
): Promise<() => void> {
  let eventVersion = 0;
  const emit = (raw: unknown) => {
    try {
      receive(delivery(raw, allowDevelopmentHttp));
    } catch {
      receive({
        kind: 'rejected',
        code: 'invalid',
        message: 'Station could not verify native link metadata.',
      });
    }
  };
  const unlisten = await listenTauri<unknown>(
    'station://native-relay-link',
    (payload) => {
      eventVersion++;
      emit(payload);
    },
  );
  try {
    const version = eventVersion;
    const launch = await invokeTauri<unknown>('station_native_relay_link_take');
    if (launch !== null && version === eventVersion) emit(launch);
    return unlisten;
  } catch {
    unlisten();
    throw new Error('Station could not receive native relay links.');
  }
}
