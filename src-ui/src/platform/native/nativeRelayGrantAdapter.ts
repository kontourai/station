import { isStationProfileStore } from '@kontourai/station-contracts';
import type {
  SelfHostedBrokerNativeRouteInvitationV2,
  SelfHostedBrokerSupersededNativeScopeObservedV1,
} from '@kontourai/station-contracts/self-hosted-broker';
import { invokeTauri } from './tauriInvoke';

type RecordValue = Record<string, unknown>;
type Invoke = <T>(
  command: string,
  args?: Record<string, unknown>,
) => Promise<T>;

type NativeRelayGrantStatusCode =
  | 'shape'
  | 'profile'
  | 'route'
  | 'ambiguous'
  | 'scope'
  | 'metadata'
  | 'cleanup'
  | 'unavailable'
  | 'unknown';

export class NativeRelayGrantStatusError extends Error {
  constructor(readonly code: NativeRelayGrantStatusCode) {
    super('Native relay grant status was refused.');
    this.name = 'NativeRelayGrantStatusError';
  }
}

export interface NativeRelayGrantRoute {
  brokerOrigin: string;
  stationId: string;
  enrollmentId: string;
  routingGeneration: number;
  grantId: string;
}

export interface NativeRelayGrantMetadata {
  route: NativeRelayGrantRoute;
  stationSigningKeyId: string;
  stationSigningGeneration: number;
  expiresAt: number;
}

export interface NativeRelayGrantCleanupStatus {
  cleanupId: string;
  route: NativeRelayGrantRoute;
  stagedAt: number;
  recordPresent: boolean;
  brokerRetired: boolean;
  localCleanupRequired: boolean;
  localCleanupComplete: boolean;
}

export interface NativeRelayGrantState {
  profileName: string;
  profileRevision: number;
  stationId: string;
  enrollmentId: string;
  grants: Array<{ metadata: NativeRelayGrantMetadata; expired: boolean }>;
  cleanups: NativeRelayGrantCleanupStatus[];
}

export type NativeRelayGrantCleanupDisposition =
  | 'notAttempted'
  | 'complete'
  | {
      status: 'pending';
      localRevokeFailed: boolean;
      brokerRetireFailed: boolean;
      custodyFailed: boolean;
    };

export type NativeRelayGrantRedemptionFailureCode =
  | 'invalidProfile'
  | 'staleProfile'
  | 'stationTrustRequired'
  | 'invitationInvalid'
  | 'invitationExpired'
  | 'stationTrustUnavailable'
  | 'proofKey'
  | 'proofKeyMissing'
  | 'brokerTransport'
  | 'brokerRejected'
  | 'grantInvalid'
  | 'grantStore'
  | 'grantMissing'
  | 'grantExists'
  | 'grantExpired'
  | 'grantRenewalConflict'
  | 'grantRenewalNotDue';

export interface NativeRelayGrantRecoveryInfo {
  brokerOrigin: string;
  stationId: string;
  enrollmentId: string;
  routingGeneration: number;
  grantId: string;
  cleanupId: string | null;
  cleanupError: NativeRelayGrantRedemptionFailureCode | null;
  credentialStatus: 'notStored' | 'retainedOrUnknown' | 'durablePending';
}

export type NativeRelayGrantRedemptionResult =
  | { status: 'redeemed'; grant: NativeRelayGrantMetadata }
  | {
      status: 'failed';
      failure: {
        primary: NativeRelayGrantRedemptionFailureCode;
        cleanup: NativeRelayGrantCleanupDisposition;
        recovery: NativeRelayGrantRecoveryInfo | null;
      };
    };

type NativeRelayCleanupRemoteBasis =
  | { kind: 'individual-grant-retired' }
  | {
      kind: 'superseded-generation-observed';
      observation: SelfHostedBrokerSupersededNativeScopeObservedV1;
    };
interface NativeRelayRecoveryResult {
  state: NativeRelayGrantState;
  outcomes: Array<{
    route: NativeRelayGrantRoute;
    remoteBasis: NativeRelayCleanupRemoteBasis | null;
    localCleanupComplete: boolean;
    failure: NativeRelayGrantRedemptionFailureCode | null;
  }>;
}
interface NativeRelayRecoverySelection {
  pendingId: string;
  profileName: string;
  expectedUpdatedAt: number;
  expectedRoute: Pick<
    NativeRelayGrantRoute,
    'brokerOrigin' | 'stationId' | 'enrollmentId'
  >;
}

export interface NativeRelayGrantAdapter {
  recoveryPreview(
    input: NativeRelayRecoverySelection,
  ): Promise<NativeRelayRecoveryResult>;
  resetConnectionInvitation(
    input: NativeRelayRecoverySelection & { expectedProfileRevision: number },
  ): Promise<NativeRelayRecoveryResult>;

  status(input: {
    profileName: string;
    expectedRoute: Pick<
      NativeRelayGrantRoute,
      'brokerOrigin' | 'stationId' | 'enrollmentId'
    >;
  }): Promise<NativeRelayGrantState>;
  assertCurrentRoute(input: {
    profileName: string;
    expectedProfileRevision: number;
    expectedUpdatedAt: number;
    expectedRoute: Pick<
      NativeRelayGrantRoute,
      'brokerOrigin' | 'stationId' | 'enrollmentId'
    >;
  }): Promise<void>;
  redeem(input: {
    profileName: string;
    expectedProfileRevision: number;
    expectedUpdatedAt: number;
    invitationJson: string;
    expectedRoute: Pick<
      NativeRelayGrantRoute,
      'brokerOrigin' | 'stationId' | 'enrollmentId'
    >;
  }): Promise<NativeRelayGrantRedemptionResult>;
  redeemLinked(input: {
    profileName: string;
    expectedProfileRevision: number;
    expectedUpdatedAt: number;
    pendingId: string;
    expectedRoute: Pick<
      NativeRelayGrantRoute,
      'brokerOrigin' | 'stationId' | 'enrollmentId'
    >;
  }): Promise<NativeRelayGrantRedemptionResult>;
}

const ERROR_CODES = new Set<NativeRelayGrantRedemptionFailureCode>([
  'invalidProfile',
  'staleProfile',
  'stationTrustRequired',
  'invitationInvalid',
  'invitationExpired',
  'stationTrustUnavailable',
  'proofKey',
  'proofKeyMissing',
  'brokerTransport',
  'brokerRejected',
  'grantInvalid',
  'grantStore',
  'grantMissing',
  'grantExists',
  'grantExpired',
  'grantRenewalConflict',
  'grantRenewalNotDue',
]);
const GRANT_SECRET = /^[A-Za-z0-9_-]{43}$/u;
const GRANT_ID = /^[A-Za-z0-9_-]{22}$/u;
const MAX_INVITATION_BYTES = 16 * 1024;

function record(value: unknown, label: string): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`Invalid native relay grant ${label}.`);
  return value as RecordValue;
}

function exactKeys(
  value: RecordValue,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (
    actual.length !== sorted.length ||
    actual.some((key, index) => key !== sorted[index])
  ) {
    throw new Error(`Invalid native relay grant ${label} fields.`);
  }
}

function stringField(value: unknown, label: string, maxLength = 2048): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxLength
  )
    throw new Error(`Invalid native relay grant ${label}.`);
  return value;
}

function integerField(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum)
    throw new Error(`Invalid native relay grant ${label}.`);
  return value as number;
}

function timestampField(value: unknown, label: string): number {
  const timestamp = integerField(value, label, 1);
  if (timestamp > 8_640_000_000_000_000)
    throw new Error(`Invalid native relay grant ${label}.`);
  return timestamp;
}

function booleanField(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean')
    throw new Error(`Invalid native relay grant ${label}.`);
  return value;
}

function arrayField(
  value: unknown,
  label: string,
  maximumLength: number,
): unknown[] {
  if (!Array.isArray(value) || value.length > maximumLength)
    throw new Error(`Invalid native relay grant ${label}.`);
  return value;
}

function brokerOrigin(value: unknown, label: string): string {
  const origin = stringField(value, label);
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new Error(`Invalid native relay grant ${label}.`);
  }
  const loopbackHttp =
    parsed.protocol === 'http:' &&
    (parsed.hostname === 'localhost' ||
      parsed.hostname === '[::1]' ||
      parsed.hostname === '::1' ||
      /^127(?:\.\d{1,3}){3}$/u.test(parsed.hostname));
  if (
    (parsed.protocol !== 'https:' && !loopbackHttp) ||
    parsed.origin !== origin ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(`Invalid native relay grant ${label}.`);
  }
  return origin;
}

function parseRoute(value: unknown, label: string): NativeRelayGrantRoute {
  const dto = record(value, `${label} route`);
  exactKeys(
    dto,
    [
      'brokerOrigin',
      'stationId',
      'enrollmentId',
      'routingGeneration',
      'grantId',
    ],
    `${label} route`,
  );
  return {
    brokerOrigin: brokerOrigin(dto.brokerOrigin, `${label}.brokerOrigin`),
    stationId: stringField(dto.stationId, `${label}.stationId`, 128),
    enrollmentId: stringField(dto.enrollmentId, `${label}.enrollmentId`, 128),
    routingGeneration: integerField(
      dto.routingGeneration,
      `${label}.routingGeneration`,
      1,
    ),
    grantId: stringField(dto.grantId, `${label}.grantId`, 128),
  };
}

function routeMatches(
  route: NativeRelayGrantRoute,
  expected: Pick<
    NativeRelayGrantRoute,
    'brokerOrigin' | 'stationId' | 'enrollmentId'
  >,
): boolean {
  return (
    route.brokerOrigin === expected.brokerOrigin &&
    route.stationId === expected.stationId &&
    route.enrollmentId === expected.enrollmentId
  );
}

function parseMetadata(
  value: unknown,
  label: string,
  expectedRoute?: Pick<
    NativeRelayGrantRoute,
    'brokerOrigin' | 'stationId' | 'enrollmentId'
  >,
): NativeRelayGrantMetadata {
  const dto = record(value, label);
  exactKeys(
    dto,
    ['route', 'stationSigningKeyId', 'stationSigningGeneration', 'expiresAt'],
    label,
  );
  const route = parseRoute(dto.route, label);
  if (expectedRoute && !routeMatches(route, expectedRoute))
    throw new Error(
      `Native relay grant ${label} does not match the saved route.`,
    );
  return {
    route,
    stationSigningKeyId: stringField(
      dto.stationSigningKeyId,
      `${label}.stationSigningKeyId`,
      512,
    ),
    stationSigningGeneration: integerField(
      dto.stationSigningGeneration,
      `${label}.stationSigningGeneration`,
      1,
    ),
    expiresAt: timestampField(dto.expiresAt, `${label}.expiresAt`),
  };
}

function parseCleanup(
  value: unknown,
  expectedRoute: Pick<
    NativeRelayGrantRoute,
    'brokerOrigin' | 'stationId' | 'enrollmentId'
  >,
): NativeRelayGrantCleanupStatus {
  const dto = record(value, 'cleanup status');
  exactKeys(
    dto,
    [
      'cleanupId',
      'route',
      'stagedAt',
      'recordPresent',
      'brokerRetired',
      'localCleanupRequired',
      'localCleanupComplete',
    ],
    'cleanup status',
  );
  const route = parseRoute(dto.route, 'cleanup');
  if (!routeMatches(route, expectedRoute))
    throw new Error(
      'Native relay grant cleanup does not match the saved route.',
    );
  return {
    cleanupId: stringField(dto.cleanupId, 'cleanupId', 128),
    route,
    stagedAt: timestampField(dto.stagedAt, 'stagedAt'),
    recordPresent: booleanField(dto.recordPresent, 'recordPresent'),
    brokerRetired: booleanField(dto.brokerRetired, 'brokerRetired'),
    localCleanupRequired: booleanField(
      dto.localCleanupRequired,
      'localCleanupRequired',
    ),
    localCleanupComplete: booleanField(
      dto.localCleanupComplete,
      'localCleanupComplete',
    ),
  };
}

function parseGrantInventory(
  value: unknown,
  profileName: string,
  expectedRoute: Pick<
    NativeRelayGrantRoute,
    'brokerOrigin' | 'stationId' | 'enrollmentId'
  >,
): NativeRelayGrantState {
  const dto = record(value, 'status');
  exactKeys(
    dto,
    [
      'profileName',
      'profileRevision',
      'stationId',
      'enrollmentId',
      'grants',
      'cleanups',
    ],
    'status',
  );
  const resultProfileName = stringField(dto.profileName, 'profileName', 256);
  const stationId = stringField(dto.stationId, 'stationId', 128);
  const enrollmentId = stringField(dto.enrollmentId, 'enrollmentId', 128);
  if (resultProfileName !== profileName)
    throw new NativeRelayGrantStatusError('profile');
  if (
    stationId !== expectedRoute.stationId ||
    enrollmentId !== expectedRoute.enrollmentId
  )
    throw new NativeRelayGrantStatusError('route');
  const grants = arrayField(dto.grants, 'grant list', 32).map((item) => {
    try {
      const entry = record(item, 'grant status item');
      exactKeys(entry, ['metadata', 'expired'], 'grant status item');
      return {
        metadata: parseMetadata(
          entry.metadata,
          'grant metadata',
          expectedRoute,
        ),
        expired: booleanField(entry.expired, 'grant expired state'),
      };
    } catch {
      throw new NativeRelayGrantStatusError('metadata');
    }
  });
  const cleanups = arrayField(dto.cleanups, 'cleanup list', 64).map((item) => {
    try {
      return parseCleanup(item, expectedRoute);
    } catch {
      throw new NativeRelayGrantStatusError('cleanup');
    }
  });
  if (
    grants.some(
      ({ metadata }) =>
        metadata.route.stationId !== stationId ||
        metadata.route.enrollmentId !== enrollmentId,
    ) ||
    cleanups.some(
      ({ route }) =>
        route.stationId !== stationId || route.enrollmentId !== enrollmentId,
    )
  ) {
    throw new NativeRelayGrantStatusError('scope');
  }
  return {
    profileName: resultProfileName,
    profileRevision: integerField(dto.profileRevision, 'profileRevision', 1),
    stationId,
    enrollmentId,
    grants,
    cleanups,
  };
}

function parseRecoveryResult(
  value: unknown,
  selection: NativeRelayRecoverySelection,
  expectedRevision: number,
): NativeRelayRecoveryResult {
  const dto = record(value, 'recovery result');
  exactKeys(dto, ['state', 'outcomes'], 'recovery result');
  const state = parseGrantInventory(
    dto.state,
    selection.profileName,
    selection.expectedRoute,
  );
  if (state.profileRevision !== expectedRevision)
    throw new Error('Connection recovery status changed.');
  const outcomes = arrayField(dto.outcomes, 'recovery outcomes', 32).map(
    (value) => {
      const entry = record(value, 'recovery outcome');
      exactKeys(
        entry,
        ['route', 'remoteBasis', 'localCleanupComplete', 'failure'],
        'recovery outcome',
      );
      const route = parseRoute(entry.route, 'recovery outcome');
      if (!routeMatches(route, selection.expectedRoute))
        throw new Error('Connection recovery scope changed.');
      let remoteBasis: NativeRelayCleanupRemoteBasis | null = null;
      if (entry.remoteBasis !== null) {
        const basis = record(entry.remoteBasis, 'recovery basis');
        if (basis.kind === 'individual-grant-retired') {
          exactKeys(basis, ['kind'], 'recovery basis');
          remoteBasis = { kind: 'individual-grant-retired' };
        } else if (basis.kind === 'superseded-generation-observed') {
          exactKeys(basis, ['kind', 'observation'], 'recovery basis');
          const observation = record(basis.observation, 'scope observation');
          exactKeys(
            observation,
            [
              'version',
              'requestNonce',
              'scope',
              'disposition',
              'leaseRevision',
            ],
            'scope observation',
          );
          const scope = record(observation.scope, 'observed scope');
          exactKeys(
            scope,
            ['stationId', 'enrollmentId', 'routingGeneration'],
            'observed scope',
          );
          const nonce = stringField(
            observation.requestNonce,
            'observation nonce',
            43,
          );
          if (
            observation.version !==
              'station-broker-native-superseded-scope-observed/v1' ||
            observation.disposition !== 'superseded-generation-not-admitted' ||
            !/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u.test(nonce) ||
            scope.stationId !== route.stationId ||
            scope.enrollmentId !== route.enrollmentId ||
            scope.routingGeneration !== route.routingGeneration
          )
            throw new Error(
              'Connection recovery observation could not be verified.',
            );
          remoteBasis = {
            kind: 'superseded-generation-observed',
            observation: {
              version: 'station-broker-native-superseded-scope-observed/v1',
              requestNonce: nonce,
              scope: {
                stationId: route.stationId,
                enrollmentId: route.enrollmentId,
                routingGeneration: route.routingGeneration,
              },
              disposition: 'superseded-generation-not-admitted',
              leaseRevision: integerField(
                observation.leaseRevision,
                'observed lease revision',
              ),
            },
          };
        } else
          throw new Error('Connection recovery basis could not be verified.');
      }
      const localCleanupComplete = booleanField(
        entry.localCleanupComplete,
        'recovery local state',
      );
      const failure =
        [...ERROR_CODES].find((code) => code === entry.failure) ?? null;
      if (
        (entry.failure !== null && failure === null) ||
        (localCleanupComplete && (!remoteBasis || failure !== null))
      )
        throw new Error('Connection recovery outcome could not be verified.');
      return { route, remoteBasis, localCleanupComplete, failure };
    },
  );
  return { state, outcomes };
}

function parseInvitation(
  invitationJson: string,
  expectedRoute: Pick<
    NativeRelayGrantRoute,
    'brokerOrigin' | 'stationId' | 'enrollmentId'
  >,
): SelfHostedBrokerNativeRouteInvitationV2 {
  if (
    new TextEncoder().encode(invitationJson).byteLength > MAX_INVITATION_BYTES
  )
    throw new Error('Native relay invitation must be under 16 KiB.');
  let value: unknown;
  try {
    value = JSON.parse(invitationJson);
  } catch {
    throw new Error('Enter a valid native relay invitation.');
  }
  const dto = record(value, 'invitation');
  exactKeys(
    dto,
    [
      'version',
      'brokerOrigin',
      'scope',
      'stationSigningKeyId',
      'stationSigningGeneration',
      'surface',
      'invitationId',
      'invitationSecret',
      'expiresAt',
    ],
    'invitation',
  );
  if (dto.version !== 'station-broker-native-route-invitation/v2')
    throw new Error('Native relay invitation version is not supported.');
  const origin = brokerOrigin(dto.brokerOrigin, 'invitation.brokerOrigin');
  const scope = record(dto.scope, 'invitation scope');
  exactKeys(
    scope,
    ['stationId', 'enrollmentId', 'routingGeneration'],
    'invitation scope',
  );
  const stationId = stringField(scope.stationId, 'invitation.stationId', 128);
  const enrollmentId = stringField(
    scope.enrollmentId,
    'invitation.enrollmentId',
    128,
  );
  if (
    origin !== expectedRoute.brokerOrigin ||
    stationId !== expectedRoute.stationId ||
    enrollmentId !== expectedRoute.enrollmentId
  ) {
    throw new Error('Native relay invitation does not match the saved route.');
  }
  const surface = record(dto.surface, 'invitation surface');
  exactKeys(
    surface,
    ['kind', 'appIdentifier', 'channel', 'clientInstanceId', 'keyThumbprint'],
    'invitation surface',
  );
  if (
    surface.kind !== 'station-native' ||
    !['dev', 'stable', 'beta', 'nightly'].includes(String(surface.channel))
  ) {
    throw new Error('Native relay invitation surface is not supported.');
  }
  const invitationId = stringField(dto.invitationId, 'invitationId', 128);
  const invitationSecret = stringField(
    dto.invitationSecret,
    'invitationSecret',
    128,
  );
  if (!GRANT_ID.test(invitationId) || !GRANT_SECRET.test(invitationSecret))
    throw new Error('Native relay invitation secret is invalid.');
  const expiresAt = timestampField(dto.expiresAt, 'invitation.expiresAt');
  if (expiresAt <= Date.now())
    throw new Error('Native relay invitation has expired.');
  return {
    version: 'station-broker-native-route-invitation/v2',
    brokerOrigin: origin,
    scope: {
      stationId,
      enrollmentId,
      routingGeneration: integerField(
        scope.routingGeneration,
        'invitation.routingGeneration',
        1,
      ),
    },
    stationSigningKeyId: stringField(
      dto.stationSigningKeyId,
      'invitation.stationSigningKeyId',
      512,
    ),
    stationSigningGeneration: integerField(
      dto.stationSigningGeneration,
      'invitation.stationSigningGeneration',
      1,
    ),
    surface: {
      kind: 'station-native',
      appIdentifier: stringField(
        surface.appIdentifier,
        'surface.appIdentifier',
        256,
      ),
      channel: surface.channel as 'dev' | 'stable' | 'beta' | 'nightly',
      clientInstanceId: stringField(
        surface.clientInstanceId,
        'surface.clientInstanceId',
        256,
      ),
      keyThumbprint: stringField(
        surface.keyThumbprint,
        'surface.keyThumbprint',
        512,
      ),
    },
    invitationId,
    invitationSecret,
    expiresAt,
  };
}

function parseRedemptionFailure(
  value: unknown,
  expectedRoute: Pick<
    NativeRelayGrantRoute,
    'brokerOrigin' | 'stationId' | 'enrollmentId'
  >,
): NativeRelayGrantRedemptionResult {
  const dto = record(value, 'redemption result');
  const status = stringField(dto.status, 'redemption status', 32);
  if (status === 'redeemed') {
    exactKeys(dto, ['status', 'grant'], 'redemption result');
    return {
      status,
      grant: parseMetadata(dto.grant, 'redeemed grant', expectedRoute),
    };
  }
  if (status !== 'failed')
    throw new Error('Invalid native relay grant redemption status.');
  exactKeys(dto, ['status', 'failure'], 'redemption result');
  const failure = record(dto.failure, 'redemption failure');
  exactKeys(failure, ['primary', 'cleanup', 'recovery'], 'redemption failure');
  const primary = stringField(failure.primary, 'failure code', 64);
  if (!ERROR_CODES.has(primary as NativeRelayGrantRedemptionFailureCode))
    throw new Error('Invalid native relay grant failure code.');
  const cleanup = parseCleanupDisposition(failure.cleanup);
  const recovery = parseRecovery(failure.recovery, expectedRoute);
  return {
    status,
    failure: {
      primary: primary as NativeRelayGrantRedemptionFailureCode,
      cleanup,
      recovery,
    },
  };
}

function parseCleanupDisposition(
  value: unknown,
): NativeRelayGrantCleanupDisposition {
  if (value === 'notAttempted' || value === 'complete') return value;
  const dto = record(value, 'cleanup disposition');
  exactKeys(
    dto,
    ['status', 'localRevokeFailed', 'brokerRetireFailed', 'custodyFailed'],
    'cleanup disposition',
  );
  if (dto.status !== 'pending')
    throw new Error('Invalid native relay grant cleanup disposition.');
  const result: Extract<
    NativeRelayGrantCleanupDisposition,
    { status: 'pending' }
  > = {
    status: 'pending',
    localRevokeFailed: booleanField(
      dto.localRevokeFailed,
      'local revoke state',
    ),
    brokerRetireFailed: booleanField(
      dto.brokerRetireFailed,
      'broker retirement state',
    ),
    custodyFailed: booleanField(dto.custodyFailed, 'custody state'),
  };
  return result;
}

function parseRecovery(
  value: unknown,
  expectedRoute: Pick<
    NativeRelayGrantRoute,
    'brokerOrigin' | 'stationId' | 'enrollmentId'
  >,
): NativeRelayGrantRecoveryInfo | null {
  if (value === null) return null;
  const dto = record(value, 'recovery');
  exactKeys(
    dto,
    [
      'brokerOrigin',
      'stationId',
      'enrollmentId',
      'routingGeneration',
      'grantId',
      'cleanupId',
      'cleanupError',
      'credentialStatus',
    ],
    'recovery',
  );
  const cleanupId =
    dto.cleanupId === null
      ? null
      : stringField(dto.cleanupId, 'cleanupId', 128);
  const cleanupErrorRaw =
    dto.cleanupError === null
      ? null
      : stringField(dto.cleanupError, 'cleanupError', 64);
  if (
    cleanupErrorRaw !== null &&
    !ERROR_CODES.has(cleanupErrorRaw as NativeRelayGrantRedemptionFailureCode)
  ) {
    throw new Error('Invalid native relay grant cleanup error.');
  }
  const credentialStatusRaw = stringField(
    dto.credentialStatus,
    'credential status',
    32,
  );
  if (
    !['notStored', 'retainedOrUnknown', 'durablePending'].includes(
      credentialStatusRaw,
    )
  )
    throw new Error('Invalid native relay grant credential status.');
  const route = {
    brokerOrigin: brokerOrigin(dto.brokerOrigin, 'recovery.brokerOrigin'),
    stationId: stringField(dto.stationId, 'recovery.stationId', 128),
    enrollmentId: stringField(dto.enrollmentId, 'recovery.enrollmentId', 128),
  };
  if (
    route.brokerOrigin !== expectedRoute.brokerOrigin ||
    route.stationId !== expectedRoute.stationId ||
    route.enrollmentId !== expectedRoute.enrollmentId
  ) {
    throw new Error(
      'Native relay grant recovery does not match the saved route.',
    );
  }
  return {
    ...route,
    routingGeneration: integerField(
      dto.routingGeneration,
      'recovery.routingGeneration',
      1,
    ),
    grantId: stringField(dto.grantId, 'recovery.grantId', 128),
    cleanupId,
    cleanupError:
      cleanupErrorRaw as NativeRelayGrantRedemptionFailureCode | null,
    credentialStatus:
      credentialStatusRaw as NativeRelayGrantRecoveryInfo['credentialStatus'],
  };
}

export function createNativeRelayGrantAdapter(
  invoke: Invoke = invokeTauri,
): NativeRelayGrantAdapter {
  const readCurrentStore = async () => {
    const raw = await invoke<unknown>('station_profile_store_read');
    let value: unknown = raw;
    if (typeof raw === 'string') {
      try {
        value = JSON.parse(raw);
      } catch {
        throw new Error('The saved route metadata could not be read.');
      }
    }
    if (!isStationProfileStore(value))
      throw new Error('The saved route metadata could not be verified.');
    return value;
  };
  const assertCurrentRoute: NativeRelayGrantAdapter['assertCurrentRoute'] =
    async (input) => {
      const profileName = stringField(input.profileName, 'profileName', 256);
      const expectedProfileRevision = integerField(
        input.expectedProfileRevision,
        'expectedProfileRevision',
        1,
      );
      const expectedUpdatedAt = integerField(
        input.expectedUpdatedAt,
        'expectedUpdatedAt',
        1,
      );
      const currentValue = await readCurrentStore();
      const currentProfile = currentValue.profiles.find(
        (profile) => profile.name.toLowerCase() === profileName.toLowerCase(),
      );
      if (
        currentValue.revision !== expectedProfileRevision ||
        !currentProfile ||
        currentProfile.updatedAt !== expectedUpdatedAt ||
        !currentProfile.relayRoute ||
        currentProfile.relayRoute.brokerOrigin !==
          input.expectedRoute.brokerOrigin ||
        currentProfile.relayRoute.stationId !== input.expectedRoute.stationId ||
        currentProfile.relayRoute.enrollmentId !==
          input.expectedRoute.enrollmentId
      )
        throw new Error('staleProfile');
    };
  return {
    status: async ({ profileName, expectedRoute }) => {
      let response: unknown;
      try {
        response = await invoke<unknown>('station_native_relay_grant_status', {
          profileName,
        });
      } catch (cause) {
        const fixed = 'Station could not read native relay grant status.';
        throw new NativeRelayGrantStatusError(
          cause === fixed || (cause instanceof Error && cause.message === fixed)
            ? 'unavailable'
            : 'unknown',
        );
      }
      try {
        const state = parseGrantInventory(response, profileName, expectedRoute);
        if (state.grants.length > 1)
          throw new NativeRelayGrantStatusError('ambiguous');
        return state;
      } catch (cause) {
        if (cause instanceof NativeRelayGrantStatusError) throw cause;
        throw new NativeRelayGrantStatusError('shape');
      }
    },
    recoveryPreview: async (input) => {
      const store = await readCurrentStore();
      await assertCurrentRoute({
        ...input,
        expectedProfileRevision: store.revision,
      });
      const response = await invoke<unknown>(
        'station_native_relay_link_recovery_preview',
        {
          pendingId: input.pendingId,
          profileName: input.profileName,
          expectedProfileRevision: store.revision,
          expectedUpdatedAt: input.expectedUpdatedAt,
        },
      );
      return parseRecoveryResult(response, input, store.revision);
    },
    resetConnectionInvitation: async (input) => {
      await assertCurrentRoute(input);
      const response = await invoke<unknown>(
        'station_native_relay_link_recovery_reset',
        {
          pendingId: input.pendingId,
          profileName: input.profileName,
          expectedProfileRevision: input.expectedProfileRevision,
          expectedUpdatedAt: input.expectedUpdatedAt,
        },
      );
      return parseRecoveryResult(
        response,
        input,
        input.expectedProfileRevision,
      );
    },
    assertCurrentRoute,
    redeemLinked: async (input) => {
      await assertCurrentRoute(input);
      const { expectedRoute, ...request } = input;
      return parseRedemptionFailure(
        await invoke<unknown>('station_native_relay_link_redeem', request),
        expectedRoute,
      );
    },
    redeem: async (input) => {
      const profileName = stringField(input.profileName, 'profileName', 256);
      const expectedProfileRevision = integerField(
        input.expectedProfileRevision,
        'expectedProfileRevision',
        1,
      );
      const invitation = parseInvitation(
        input.invitationJson,
        input.expectedRoute,
      );
      await assertCurrentRoute({
        profileName,
        expectedProfileRevision,
        expectedUpdatedAt: input.expectedUpdatedAt,
        expectedRoute: input.expectedRoute,
      });
      const response = await invoke<unknown>(
        'station_native_relay_grant_redeem',
        { profileName, expectedProfileRevision, invitation },
      );
      return parseRedemptionFailure(response, input.expectedRoute);
    },
  };
}

export const nativeRelayGrantAdapter = createNativeRelayGrantAdapter();
