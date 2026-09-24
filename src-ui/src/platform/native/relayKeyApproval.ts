import { invokeTauri } from './tauriInvoke';

/** Host-verified public candidate metadata. It never contains the signing key. */
export interface RelayKeyCandidate {
  pendingId: string;
  profileName: string;
  brokerOrigin: string;
  stationId: string;
  enrollmentId: string;
  generation: number;
  keyId: string;
  confirmationCode: string;
  expiresAt: number;
  trustRevision: number;
  status: 'pending';
}

export interface RelayKeyTrustStatus {
  profileName: string;
  brokerOrigin: string;
  stationId: string;
  enrollmentId: string;
  generation: number | null;
  keyId: string | null;
  status: 'untrusted' | 'approved' | 'revoked';
  trustRevision: number;
}

export interface RelayKeyApprovalSurface {
  profileName: string;
  brokerOrigin: string;
  stationId: string;
  enrollmentId: string;
  appIdentifier: string;
  channel: string;
  clientInstanceId: string;
  keyThumbprint: string;
  publicKey: { kty: string; crv: string; x: string; y: string };
}

export interface RelayKeyApprovalAdapter {
  prepare(profileName: string): Promise<RelayKeyApprovalSurface>;
  begin(
    profileName: string,
    invitationJson: string,
  ): Promise<RelayKeyCandidate>;
  cancel(profileName: string): Promise<void>;
  pending(profileName: string): Promise<RelayKeyCandidate | null>;
  approve(input: {
    pendingId: string;
    confirmationCode: string;
    fullKeyId: string;
  }): Promise<RelayKeyTrustStatus>;
  revoke(input: {
    profileName: string;
    expectedTrustRevision: number;
    fullKeyId: string;
  }): Promise<RelayKeyTrustStatus>;
  status(profileName: string): Promise<RelayKeyTrustStatus>;
}

type Dict = Record<string, unknown>;
const isDict = (value: unknown): value is Dict =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
function requireDict(value: unknown, label: string): Dict {
  if (!isDict(value)) throw new Error(`Invalid native ${label} response.`);
  return value;
}
function requireString(
  value: unknown,
  field: string,
  maxLength = 4096,
): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxLength
  ) {
    throw new Error(`Invalid native Station key field: ${field}.`);
  }
  return value;
}
function requireSafeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`Invalid native Station key field: ${field}.`);
  }
  return value as number;
}
function requireNullableInteger(value: unknown, field: string): number | null {
  if (value === null) return null;
  return requireSafeInteger(value, field);
}
function parseCandidate(value: unknown): RelayKeyCandidate {
  const dto = requireDict(value, 'Station key candidate');
  if (dto.status !== 'pending')
    throw new Error('Invalid native Station key candidate status.');
  const confirmationCode = requireString(
    dto.confirmationCode,
    'confirmationCode',
    16,
  );
  if (!/^[a-z0-9]{16}$/iu.test(confirmationCode)) {
    throw new Error('Invalid native Station key confirmation code.');
  }
  return {
    pendingId: requireString(dto.pendingId, 'pendingId', 512),
    profileName: requireString(dto.profileName, 'profileName', 128),
    brokerOrigin: requireString(dto.brokerOrigin, 'brokerOrigin', 2048),
    stationId: requireString(dto.stationId, 'stationId', 128),
    enrollmentId: requireString(dto.enrollmentId, 'enrollmentId', 128),
    generation: requireSafeInteger(dto.generation, 'generation'),
    keyId: requireString(dto.keyId, 'keyId', 512),
    confirmationCode,
    expiresAt: requireSafeInteger(dto.expiresAt, 'expiresAt'),
    trustRevision: requireSafeInteger(dto.trustRevision, 'trustRevision'),
    status: 'pending',
  };
}
function parseStatus(value: unknown): RelayKeyTrustStatus {
  const dto = requireDict(value, 'Station key trust status');
  if (!['untrusted', 'approved', 'revoked'].includes(String(dto.status))) {
    throw new Error('Invalid native Station key trust status.');
  }
  const status = dto.status as RelayKeyTrustStatus['status'];
  const generation = requireNullableInteger(dto.generation, 'generation');
  const keyId =
    dto.keyId === null ? null : requireString(dto.keyId, 'keyId', 512);
  if (
    (status === 'untrusted' && (keyId !== null || generation !== null)) ||
    (status !== 'untrusted' && (keyId === null || generation === null))
  ) {
    throw new Error('Inconsistent native Station key trust status fields.');
  }
  return {
    profileName: requireString(dto.profileName, 'profileName', 128),
    brokerOrigin: requireString(dto.brokerOrigin, 'brokerOrigin', 2048),
    stationId: requireString(dto.stationId, 'stationId', 128),
    enrollmentId: requireString(dto.enrollmentId, 'enrollmentId', 128),
    generation,
    keyId,
    status,
    trustRevision: requireSafeInteger(dto.trustRevision, 'trustRevision'),
  };
}
function parseSurface(value: unknown): RelayKeyApprovalSurface {
  const dto = requireDict(value, 'Station key preparation');
  const publicKey = requireDict(dto.publicKey, 'Station install public key');
  if (publicKey.kty !== 'EC' || publicKey.crv !== 'P-256') {
    throw new Error('Invalid native Station install public key type.');
  }
  return {
    profileName: requireString(dto.profileName, 'profileName', 128),
    brokerOrigin: requireString(dto.brokerOrigin, 'brokerOrigin', 2048),
    stationId: requireString(dto.stationId, 'stationId', 128),
    enrollmentId: requireString(dto.enrollmentId, 'enrollmentId', 128),
    appIdentifier: requireString(dto.appIdentifier, 'appIdentifier', 256),
    channel: requireString(dto.channel, 'channel', 128),
    clientInstanceId: requireString(
      dto.clientInstanceId,
      'clientInstanceId',
      256,
    ),
    keyThumbprint: requireString(dto.keyThumbprint, 'keyThumbprint', 512),
    publicKey: {
      kty: requireString(publicKey.kty, 'publicKey.kty', 32),
      crv: requireString(publicKey.crv, 'publicKey.crv', 32),
      x: requireString(publicKey.x, 'publicKey.x', 256),
      y: requireString(publicKey.y, 'publicKey.y', 256),
    },
  };
}

function parseInvitation(input: string): Dict {
  if (input.length === 0 || input.length > 16 * 1024) {
    throw new Error('Invitation must be JSON under 16 KiB.');
  }
  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch {
    throw new Error('Invitation must be valid JSON.');
  }
  const invitation = requireDict(value, 'Station invitation');
  if (invitation.version !== 'station-broker-native-route-invitation/v2') {
    throw new Error('Invitation version is not supported.');
  }
  const scope = requireDict(invitation.scope, 'Station invitation scope');
  const surface = requireDict(invitation.surface, 'Station invitation surface');
  if (surface.kind !== 'station-native') {
    throw new Error('Invitation is not for a native Station client.');
  }
  requireString(invitation.brokerOrigin, 'invitation.brokerOrigin', 2048);
  requireString(scope.stationId, 'invitation.scope.stationId', 128);
  requireString(scope.enrollmentId, 'invitation.scope.enrollmentId', 128);
  requireSafeInteger(
    scope.routingGeneration,
    'invitation.scope.routingGeneration',
  );
  requireString(
    invitation.stationSigningKeyId,
    'invitation.stationSigningKeyId',
    512,
  );
  requireSafeInteger(
    invitation.stationSigningGeneration,
    'invitation.stationSigningGeneration',
  );
  requireString(surface.appIdentifier, 'invitation.surface.appIdentifier', 256);
  requireString(surface.channel, 'invitation.surface.channel', 128);
  requireString(
    surface.clientInstanceId,
    'invitation.surface.clientInstanceId',
    256,
  );
  requireString(surface.keyThumbprint, 'invitation.surface.keyThumbprint', 512);
  requireString(invitation.invitationId, 'invitation.invitationId', 512);
  requireString(
    invitation.invitationSecret,
    'invitation.invitationSecret',
    4096,
  );
  requireSafeInteger(invitation.expiresAt, 'invitation.expiresAt');
  return invitation;
}

/**
 * Native Station key admission. Kept behind a platform adapter so the route
 * editor and browser UI cannot import or invoke Tauri commands directly.
 */
export const nativeRelayKeyApproval: RelayKeyApprovalAdapter = {
  prepare: async (profileName) =>
    parseSurface(
      await invokeTauri<unknown>('station_native_relay_key_approval_prepare', {
        profileName,
      }),
    ),
  begin: async (profileName, invitationJson) =>
    parseCandidate(
      await invokeTauri<unknown>('station_native_relay_key_approval_begin', {
        profileName,
        invitation: parseInvitation(invitationJson),
      }),
    ),
  cancel: async (profileName) => {
    const reply = await invokeTauri<unknown>(
      'station_native_relay_key_approval_cancel',
      {
        profileName,
      },
    );
    if (reply !== null && reply !== undefined) {
      throw new Error('Invalid native Station key cancellation response.');
    }
  },
  pending: async (profileName) => {
    const reply = await invokeTauri<unknown>(
      'station_native_relay_key_approval_pending',
      { profileName },
    );
    return reply === null ? null : parseCandidate(reply);
  },
  approve: async (input) =>
    parseStatus(
      await invokeTauri<unknown>(
        'station_native_relay_key_approval_approve',
        input,
      ),
    ),
  revoke: async (input) =>
    parseStatus(
      await invokeTauri<unknown>(
        'station_native_relay_key_approval_revoke',
        input,
      ),
    ),
  status: async (profileName) =>
    parseStatus(
      await invokeTauri<unknown>('station_native_relay_key_approval_status', {
        profileName,
      }),
    ),
};
