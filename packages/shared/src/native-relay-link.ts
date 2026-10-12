import type {
  NativeRelayLinkChannel,
  NativeRelayLinkV1,
} from '@kontourai/station-contracts/native-relay-link';
import type { SelfHostedBrokerNativeRouteInvitationV2 } from '@kontourai/station-contracts/self-hosted-broker';

const VERSION = 'station-native-relay-link/v1';
const MAX_BYTES = 16 * 1024;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OPAQUE = /^[A-Za-z0-9_-]{43}$/;

function invalid(): never {
  throw new Error('native_relay_link_invalid');
}

function exact(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== [...keys].sort().join(','))
    invalid();
  return record;
}

function text(value: unknown, pattern?: RegExp): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 2048 ||
    (pattern && !pattern.test(value))
  )
    invalid();
  return value;
}

function positive(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)
    invalid();
  return value;
}

function origin(value: unknown, channel: NativeRelayLinkChannel): string {
  const input = text(value);
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    invalid();
  }
  if (
    url.origin !== input ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    !(
      url.protocol === 'https:' ||
      (url.protocol === 'http:' &&
        channel === 'dev' &&
        ['127.0.0.1', '[::1]'].includes(url.hostname))
    )
  )
    invalid();
  return input;
}

export function nativeRelayLinkScheme(
  channel: NativeRelayLinkChannel,
  devScheme?: string,
): string {
  if (channel === 'dev') {
    if (
      !devScheme ||
      !/^station-relay-dev-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(devScheme)
    )
      invalid();
    return devScheme;
  }
  if (!['stable', 'beta', 'nightly'].includes(channel)) invalid();
  return `station-relay-${channel}`;
}

function invitation(
  value: unknown,
  channel: NativeRelayLinkChannel,
  appIdentifier: string | undefined,
  now: number,
): SelfHostedBrokerNativeRouteInvitationV2 {
  const dto = exact(value, [
    'version',
    'brokerOrigin',
    'scope',
    'stationSigningKeyId',
    'stationSigningGeneration',
    'surface',
    'invitationId',
    'invitationSecret',
    'expiresAt',
  ]);
  if (dto.version !== 'station-broker-native-route-invitation/v2') invalid();
  const scope = exact(dto.scope, [
    'stationId',
    'enrollmentId',
    'routingGeneration',
  ]);
  const surface = exact(dto.surface, [
    'kind',
    'appIdentifier',
    'channel',
    'clientInstanceId',
    'keyThumbprint',
  ]);
  const expiresAt = positive(dto.expiresAt);
  if (expiresAt <= now) invalid();
  const identifier = text(surface.appIdentifier);
  if (
    surface.kind !== 'station-native' ||
    surface.channel !== channel ||
    (appIdentifier !== undefined && identifier !== appIdentifier)
  )
    invalid();
  return {
    version: 'station-broker-native-route-invitation/v2',
    brokerOrigin: origin(dto.brokerOrigin, channel),
    scope: {
      stationId: text(scope.stationId, UUID),
      enrollmentId: text(scope.enrollmentId, UUID),
      routingGeneration: positive(scope.routingGeneration),
    },
    stationSigningKeyId: text(dto.stationSigningKeyId, OPAQUE),
    stationSigningGeneration: positive(dto.stationSigningGeneration),
    surface: {
      kind: 'station-native',
      appIdentifier: identifier,
      channel,
      clientInstanceId: text(surface.clientInstanceId, UUID),
      keyThumbprint: text(surface.keyThumbprint, OPAQUE),
    },
    invitationId: text(dto.invitationId, /^[A-Za-z0-9_-]{8,128}$/),
    invitationSecret: text(dto.invitationSecret, OPAQUE),
    expiresAt,
  };
}

function envelope(
  value: unknown,
  options: {
    channel: NativeRelayLinkChannel;
    appIdentifier?: string;
    now?: number;
  },
): NativeRelayLinkV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const kind = (value as Record<string, unknown>).kind;
  if (kind === 'route-intent') {
    const dto = exact(value, [
      'version',
      'kind',
      'applicationOrigin',
      'brokerOrigin',
      'stationId',
      'enrollmentId',
    ]);
    if (dto.version !== VERSION) invalid();
    return {
      version: VERSION,
      kind,
      applicationOrigin: origin(dto.applicationOrigin, options.channel),
      brokerOrigin: origin(dto.brokerOrigin, options.channel),
      stationId: text(dto.stationId, UUID),
      enrollmentId: text(dto.enrollmentId, UUID),
    };
  }
  if (kind === 'bound-invitation') {
    const dto = exact(value, [
      'version',
      'kind',
      'applicationOrigin',
      'invitation',
    ]);
    if (dto.version !== VERSION) invalid();
    return {
      version: VERSION,
      kind,
      applicationOrigin: origin(dto.applicationOrigin, options.channel),
      invitation: invitation(
        dto.invitation,
        options.channel,
        options.appIdentifier,
        options.now ?? Date.now(),
      ),
    };
  }
  invalid();
}

/** Publisher-side encoding. Receiving native apps use opaque host delivery. */
export function encodeNativeRelayLink(
  value: NativeRelayLinkV1,
  options: {
    channel: NativeRelayLinkChannel;
    devScheme?: string;
    now?: number;
  },
): string {
  const scheme = nativeRelayLinkScheme(options.channel, options.devScheme);
  const validated = envelope(value, options);
  const bytes = new TextEncoder().encode(JSON.stringify(validated));
  if (bytes.length > MAX_BYTES) invalid();
  const encoded = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `${scheme}://relay#relay-link=${encoded}`;
}

/** Inspection codec only; this parser grants no native or application authority. */
export function parseNativeRelayLink(
  value: string,
  options: {
    channel: NativeRelayLinkChannel;
    devScheme?: string;
    appIdentifier: string;
    now?: number;
  },
): NativeRelayLinkV1 {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    invalid();
  }
  const scheme = nativeRelayLinkScheme(options.channel, options.devScheme);
  if (
    url.protocol !== `${scheme}:` ||
    url.hostname !== 'relay' ||
    url.pathname ||
    url.search ||
    url.username ||
    url.password ||
    url.port
  )
    invalid();
  const match = /^#relay-link=([A-Za-z0-9_-]+)$/.exec(url.hash);
  if (!match || match[1]!.length > Math.ceil(MAX_BYTES / 3) * 4) invalid();
  let decoded: unknown;
  try {
    const binary = atob(match[1]!.replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0),
    );
    if (bytes.length > MAX_BYTES) invalid();
    decoded = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    );
  } catch {
    invalid();
  }
  return envelope(decoded, options);
}
